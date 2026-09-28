/* ============================================================
   transform.js —— 像素处理与缩放数学
   这里是缩放/重编码的「唯一实现」：
     · 5 个纯函数挂在 window.ITB.transform 上，主线程和 Worker 共用
     · 真正的像素计算只发生在 canvas 上，同步、无 DOM 依赖，
       所以同一份代码既能在 Worker 里跑，也能在主线程兜底跑
   不存在两份实现，也就不会出现两套 bug。
   ============================================================ */

window.ITB = window.ITB || {};

(function (ITB) {
  'use strict';

  /* ============================================================
     一、参数定义与摘要
     ============================================================ */

  function defaultResizeParams() {
    return {
      mode: 'width',          // 'width' | 'height' | 'percent'
      width: 1920,
      height: 1080,
      percent: 50,
      allowUpscale: false     // 默认禁止放大：800px 的图不该被拉到 2000px 变糊
    };
  }

  function defaultFormatParams() {
    return {
      format: 'jpeg',         // 'png' | 'jpeg' | 'webp'
      quality: 0.92           // PNG 忽略它
    };
  }

  function num(v, dflt) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return (isFinite(n) && n > 0) ? n : dflt;
  }

  /**
   * 等比算出目标尺寸。
   * 只允许填一个方向，另一边永远按原比例算出来——所以输出的宽高比
   * 必然等于原图，不存在拉伸变形的可能。
   */
  function computeTarget(srcW, srcH, p) {
    if (!srcW || !srcH) {
      return { width: srcW, height: srcH, scale: 1, unchanged: true, blockedByUpscale: false };
    }

    var scale;
    if (p.mode === 'percent')      scale = num(p.percent, 100) / 100;
    else if (p.mode === 'height')  scale = num(p.height, srcH) / srcH;
    else                           scale = num(p.width, srcW) / srcW;

    var blocked = false;
    if (scale > 1 && !p.allowUpscale) {
      scale = 1;
      blocked = true;
    }

    var w = Math.max(1, Math.round(srcW * scale));
    var h = Math.max(1, Math.round(srcH * scale));

    return {
      width: w,
      height: h,
      scale: scale,
      unchanged: (w === srcW && h === srcH),
      blockedByUpscale: blocked
    };
  }

  function summarize(p) {
    if (p.mode === 'percent') {
      return '按百分比 ' + num(p.percent, 100) + '%' + (p.allowUpscale ? ' · 允许放大' : '');
    }
    if (p.mode === 'height') {
      return '高度 ' + num(p.height, 1080) + 'px 等比' + (p.allowUpscale ? ' · 允许放大' : '');
    }
    return '宽度 ' + num(p.width, 1920) + 'px 等比' + (p.allowUpscale ? ' · 允许放大' : '');
  }

  /* ============================================================
     二、格式常量
     ============================================================ */

  var FORMAT_LABEL = { png: 'PNG', jpeg: 'JPEG', webp: 'WebP' };
  var FORMAT_MIME  = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
  var FORMAT_EXT   = { png: '.png', jpeg: '.jpg', webp: '.webp' };

  function mimeOf(format)  { return FORMAT_MIME[format] || 'image/png'; }
  function extOf(format)   { return FORMAT_EXT[format] || '.png'; }
  function labelOf(format) { return FORMAT_LABEL[format] || String(format).toUpperCase(); }

  function summarizeFormat(p) {
    var s = labelOf(p.format);
    if (p.format !== 'png') s += ' 质量 ' + Math.round(num(p.quality, 0.92) * 100) + '%';
    return s + '（透明垫白底）';
  }

  // 从 MIME 反查格式名
  function formatFromMime(mime) {
    if (!mime) return null;
    var m = String(mime).toLowerCase();
    if (m.indexOf('jpeg') >= 0 || m.indexOf('jpg') >= 0) return 'jpeg';
    if (m.indexOf('webp') >= 0) return 'webp';
    if (m.indexOf('png') >= 0) return 'png';
    return null;
  }

  /* ============================================================
     三、像素处理（主线程 / Worker 共用）
     ============================================================ */

  /**
   * 把位图贴到 canvas 上。
   * 这个上下文**强制不透明**（alpha:false）。否则即使先铺了白底，
   * 导出的 PNG 依然带 alpha 通道（颜色类型 6），会让 PDF 那边误判成
   * 「需要垫白底」而反复重编码，甚至直接报错。
   * 需要保留透明的情况我们根本不走 canvas（原文件透传）。
   */
  function drawToCanvas(bitmap, targetW, targetH, opaque) {
    var canvas;
    if (typeof OffscreenCanvas === 'function') {
      canvas = new OffscreenCanvas(targetW, targetH);
    } else {
      canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
    }

    var ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';

    if (opaque) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, targetW, targetH);
    }

    ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, targetW, targetH);
    return canvas;
  }

  /**
   * 编码。WebP 在个别浏览器上不被 canvas 支持，这时降级成 PNG，
   * 并把真正产出的类型如实报回去，免得文件后缀和内容对不上。
   */
  function canvasToBlob(canvas, mime, quality) {
    function attempt(type) {
      if (typeof canvas.convertToBlob === 'function') {
        return canvas.convertToBlob({ type: type, quality: quality });
      }
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (b) {
          if (b) resolve(b);
          else reject(new Error('图片编码失败，可能是浏览器不支持 ' + type));
        }, type, quality);
      });
    }

    return attempt(mime).catch(function (err) {
      if (mime === 'image/webp') return attempt('image/png');
      throw err;
    });
  }

  function decodeViaImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
      img.src = url;
    });
  }

  function decodeImage(file) {
    if (typeof createImageBitmap === 'function') {
      // imageOrientation:'from-image' 让带 EXIF 旋转标记的照片按正确方向显示
      return createImageBitmap(file, { imageOrientation: 'from-image' })
        .catch(function () { return createImageBitmap(file); });
    }
    return decodeViaImage(file);
  }

  /**
   * 处理单个文件：解码 → 缩放 → 编码。
   * @param {File|Blob} file
   * @param {object|null} resizeParams   null 表示不缩放
   * @param {string} mime                输出 MIME
   * @param {number} quality             输出质量（PNG 忽略）
   * @returns {Promise<{blob, width, height, sourceWidth, sourceHeight, passthrough}>}
   */
  function processOne(file, resizeParams, mime, quality) {
    var bitmap = null;

    return decodeImage(file).then(function (bmp) {
      bitmap = bmp;

      var srcW = bmp.width;
      var srcH = bmp.height;

      var target = { width: srcW, height: srcH, unchanged: true, blockedByUpscale: false };
      if (resizeParams) target = computeTarget(srcW, srcH, resizeParams);

      var outW = target.width;
      var outH = target.height;

      // 需要重画的唯一原因：尺寸变了，或者输出是 JPEG（必须垫白底）
      var wantsOpaque = (mime === 'image/jpeg');
      var needRedraw = !target.unchanged || wantsOpaque;

      if (needRedraw) {
        var canvas = drawToCanvas(bmp, outW, outH, wantsOpaque);
        return canvasToBlob(canvas, mime, quality).then(function (blob) {
          return {
            blob: blob,
            width: outW, height: outH,
            sourceWidth: srcW, sourceHeight: srcH,
            passthrough: false
          };
        });
      }

      // 尺寸和格式都不用动：原文件直接透传，一个像素都不重编码
      return {
        blob: file,
        width: srcW, height: srcH,
        sourceWidth: srcW, sourceHeight: srcH,
        passthrough: true
      };
    }).then(function (res) {
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
      return res;
    }, function (err) {
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
      throw err;
    });
  }

  /** 给 workerhost 的兜底路径用：签名和 worker 里保持一致 */
  function processOneInline(job, resizeParams, mime, quality) {
    return processOne(job.file, resizeParams, mime, quality);
  }

  /* ============================================================
     四、队列级计算：谁决定最终输出、要占多少内存
     ============================================================ */

  /** 队列里最后一个生效的缩放和最后一个生效的转格式，决定最终输出 */
  function effectiveSteps(steps) {
    var resize = null;
    var format = null;
    for (var i = 0; i < steps.length; i++) {
      if (!steps[i].enabled) continue;
      if (steps[i].type === 'resize') resize = steps[i];
      if (steps[i].type === 'format') format = steps[i];
    }
    return { resize: resize, format: format };
  }

  /**
   * 把一张图依次走完所有生效的缩放步骤，算出最终尺寸。
   * @param {number} srcW
   * @param {number} srcH
   * @param {Array} steps  形如 [{ enabled, type:'resize', params }] 的步骤数组
   */
  function layoutSize(srcW, srcH, steps) {
    var w = srcW;
    var h = srcH;
    var blocked = false;
    var applied = 0;

    for (var i = 0; i < steps.length; i++) {
      if (!steps[i].enabled || steps[i].type !== 'resize') continue;
      var t = computeTarget(w, h, steps[i].params);
      w = t.width;
      h = t.height;
      if (t.blockedByUpscale) blocked = true;
      applied++;
    }

    return {
      width: w,
      height: h,
      resized: applied > 0,
      blockedByUpscale: blocked,
      unchanged: (w === srcW && h === srcH)
    };
  }

  /** 粗估内存占用：canvas 的 RGBA 位图 4 字节/像素，编码产物按 1 字节/像素估 */
  function estimateMemory(files, steps) {
    var bytes = 0;
    var pixels = 0;

    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var t = layoutSize(f.width || 1200, f.height || 1200, steps);
      pixels += t.width * t.height;
      bytes += t.width * t.height * 5;
    }

    return { bytes: bytes, pixels: pixels, count: files.length };
  }

  ITB.transform = {
    // 参数
    defaultResizeParams: defaultResizeParams,
    defaultFormatParams: defaultFormatParams,
    // 计算
    computeTarget: computeTarget,
    summarize: summarize,
    summarizeFormat: summarizeFormat,
    mimeOf: mimeOf,
    extOf: extOf,
    labelOf: labelOf,
    formatFromMime: formatFromMime,
    effectiveSteps: effectiveSteps,
    layoutSize: layoutSize,
    estimateMemory: estimateMemory,
    // 像素处理（唯一实现）
    drawToCanvas: drawToCanvas,
    canvasToBlob: canvasToBlob,
    decodeImage: decodeImage,
    processOne: processOne,
    processOneInline: processOneInline
  };

})(window.ITB);
