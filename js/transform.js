/* ============================================================
   transform.js —— 像素处理与缩放数学
   缩放与重编码的唯一实现：
     · 5 个纯函数挂载于 window.ITB.transform，主线程与 Worker 共用
     · 像素计算仅在 canvas 上同步执行，无 DOM 依赖，
       因此同一份代码既可在 Worker 运行，也可在主线程兜底
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
      allowUpscale: false     // 默认禁止放大：放大仅插值，不增加细节
    };
  }

  function defaultFormatParams() {
    return {
      format: 'jpeg',         // 'png' | 'jpeg' | 'webp'
      quality: 0.92           // PNG 忽略此参数
    };
  }

  function num(v, dflt) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return (isFinite(n) && n > 0) ? n : dflt;
  }

  /**
   * 按比例计算目标尺寸。
   * 仅指定一个方向，另一方向由原比例推导，因此输出宽高比必然等于原图，
   * 不会发生拉伸变形。
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
    return s + '（透明填充白底）';
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
   * 将位图绘制到 canvas。
   * 上下文强制不透明（alpha:false），并统一先铺白底。
   * 不透明上下文导出的 PNG 不含 alpha 通道（颜色类型 6），
   * 可避免 PDF 侧判定为「需填充白底」而重复重编码。
   * 代价是输出必定经过压平，保留透明需绕过 canvas（原文件透传）。
   */
  function drawToCanvas(bitmap, targetW, targetH) {
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

    /* alpha:false 上下文的背板为不透明黑，透明像素若不处理会变为黑色。
       因此须先铺白底再绘制，以对齐 png2pdf 的 to_rgb() 行为；
       对完全不透明的图，铺底不产生影响。 */
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetW, targetH);

    ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, targetW, targetH);
    return canvas;
  }

  /**
   * 编码。部分浏览器的 canvas 不支持 WebP，此时降级为 PNG，
   * 并如实返回实际产出的类型，避免文件后缀与内容不一致。
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
      // imageOrientation:'from-image'：按 EXIF 方向标记校正照片方向
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

      /* 重绘条件：
         1. 尺寸发生变化；
         2. 目标为 JPEG —— JPEG 不含 alpha，即使尺寸不变也须经
            canvas 的 alpha:false 白底压平透明区（对齐 png2pdf 的 to_rgb）。
         其余情况原文件透传，不重编码任何像素，
         这也是保留透明的唯一路径（如 PNG → PNG 且尺寸不变）。 */
      var needFlatten = (mime === 'image/jpeg');
      var needRedraw = !target.unchanged || needFlatten;

      if (needRedraw) {
        var canvas = drawToCanvas(bmp, outW, outH);
        return canvasToBlob(canvas, mime, quality).then(function (blob) {
          return {
            blob: blob,
            width: outW, height: outH,
            sourceWidth: srcW, sourceHeight: srcH,
            passthrough: false
          };
        });
      }

      // 尺寸与格式均无需变更：原文件透传，不重编码任何像素
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

  /** 供 workerHost 兜底路径调用：签名与 Worker 内保持一致 */
  function processOneInline(job, resizeParams, mime, quality) {
    return processOne(job.file, resizeParams, mime, quality);
  }

  ITB.transform = {
    // 参数
    defaultResizeParams: defaultResizeParams,
    defaultFormatParams: defaultFormatParams,
    // 计算
    num: num,
    computeTarget: computeTarget,
    summarize: summarize,
    summarizeFormat: summarizeFormat,
    mimeOf: mimeOf,
    extOf: extOf,
    labelOf: labelOf,
    formatFromMime: formatFromMime,
    // 像素处理（唯一实现）
    drawToCanvas: drawToCanvas,
    canvasToBlob: canvasToBlob,
    decodeImage: decodeImage,
    processOne: processOne,
    processOneInline: processOneInline
  };

})(window.ITB);
