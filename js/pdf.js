/* ============================================================
   pdf.js —— 图片装订为 PDF（异步构建器）

   所有图片统一重编码为 JPEG，而非对 PNG 无损内嵌，原因如下：

   无损内嵌 PNG 需将 IDAT 原样写入 PDF 的 /FlateDecode 流，涉及
   手动扫描 chunk、判定色彩类型、确认流为不含 zlib 字典的 deflate 流；
   任一步骤出错都会产出无法打开的 PDF，且用户侧无可见线索。
   JPEG 的 /DCTDecode 无此约束：数据为自包含的基线 JPEG 字节流，
   由阅读器直接交由 JPEG 解码器处理，兼容性最好且实现最短。

   代价为有损压缩：原图为 JPEG 时质量取 0.95，损失可忽略；
   无损 PNG 有轻微损失，属可靠性权衡，界面已注明。

   沿用 png2pdf 行为：透明区域填充白底（原 to_rgb），一图一页，
   页面尺寸 = 图片像素尺寸（1px = 1pt）。
   ============================================================ */

window.ITB = window.ITB || {};

(function (ITB) {
  'use strict';

  var U = ITB.util;

  /**
   * 对已解码位图填充白底并编码为基线 JPEG。
   * @param {object} bitmap
   * @param {number} quality
   * @param {number} [targetWidth] 输出宽度，高度按原比例计算。
   *        省略或与位图同宽时不缩放，直接使用原尺寸路径。
   */
  function encodeJpeg(bitmap, quality, targetWidth) {
    var w = bitmap.width;
    var h = bitmap.height;

    if (targetWidth) {
      w = Math.max(1, Math.round(targetWidth));
      h = Math.max(1, Math.round(bitmap.height * (w / bitmap.width)));
    }

    var canvas;
    if (typeof OffscreenCanvas === 'function') {
      canvas = new OffscreenCanvas(w, h);
    } else {
      canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
    }

    // 必须使用 alpha:false：否则透明区在 JPEG 编码时可能变为黑色，
    // 此处需与 png2pdf 的 to_rgb() 一致，即填充白底
    var ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) ctx = canvas.getContext('2d');
    if (w !== bitmap.width) {
      // 仅在发生缩放时设置，避免改变原尺寸输出的插值行为
      ctx.imageSmoothingEnabled = true;
      if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    }

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, w, h);

    if (typeof canvas.convertToBlob === 'function') {
      return canvas.convertToBlob({ type: 'image/jpeg', quality: quality });
    }
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) {
        if (b) resolve(b);
        else reject(new Error('JPEG 编码失败'));
      }, 'image/jpeg', quality);
    });
  }

  /**
   * 装订 PDF。
   * @param {Array} items   [{ name, file }]，顺序即页序
   * @param {object} [opts] { title, quality, uniformWidth, onProgress(done,total,label), isCancelled() }
   *        uniformWidth=true 时，先测量最宽一张的宽度，其余每张等比缩放到该宽度，
   *        使每页宽度一致（高度按各自比例计算，因此不会变形）。
   * @returns {Promise<{blob, pages, bytes, reencoded}>}
   */
  function build(items, opts) {
    opts = opts || {};

    if (!items || !items.length) {
      return Promise.reject(new Error('没有可导出的图片。'));
    }

    return ITB.pdf.load().then(function () {
      return opts.uniformWidth ? measureMaxWidth(items) : 0;
    }).then(function (targetWidth) {
      var writer = new ITB.pdf.PdfWriter();
      writer.setMeta({
        title: opts.title || 'imgtoolbox',
        creator: 'imgtoolbox',
        producer: 'imgtoolbox'
      });

      var quality = opts.quality || 0.95;
      var failed = [];
      var i = 0;

      function cancelled() {
        return !!(opts.isCancelled && opts.isCancelled());
      }

      function next() {
        if (cancelled()) throw new Error('__cancelled__');
        if (i >= items.length) return Promise.resolve();

        var item = items[i];
        var index = i;
        i++;

        if (opts.onProgress) opts.onProgress(index, items.length, item.name);

        var bitmap = null;

        return U.loadImageBitmap(item.file).then(function (bmp) {
          bitmap = bmp;
          if (cancelled()) throw new Error('__cancelled__');

          var w = bmp.width;
          var h = bmp.height;
          if (!w || !h) throw new Error('读不到图片尺寸');

          /* 统一宽度：所有图片缩放至同一宽度，等比缩放保持宽高比；
             最宽那张本身即等于目标宽度，走不缩放的路径。
             写入页面的尺寸取重新解析后的 JPEG 尺寸，而非计算出的目标值 ——
             canvas 的取整规则由浏览器决定，须以实际产物为准，
             否则会出现 MediaBox 与图片实际宽高不一致。 */
          var scaleTo = targetWidth && w !== targetWidth ? targetWidth : 0;

          return encodeJpeg(bmp, quality, scaleTo).then(function (blob) {
            if (bitmap && typeof bitmap.close === 'function') bitmap.close();
            bitmap = null;

            return blob.arrayBuffer().then(function (buf) {
              var bytes = new Uint8Array(buf);
              var info = ITB.pdf.parseImage(bytes);

              if (!info || info.format !== 'jpeg') {
                throw new Error('重编码后不是 JPEG（得到 ' +
                  (info ? info.format : '无法识别') + '）');
              }

              writer.addJpegPage(bytes, info.width, info.height, info.colorspace, item.name);
              return next();
            });
          });
        }).catch(function (err) {
          if (bitmap && typeof bitmap.close === 'function') bitmap.close();
          bitmap = null;

          if (err && err.message === '__cancelled__') throw err;

          // 单张失败不中断整批，记录后继续
          failed.push((item.name || ('第 ' + (index + 1) + ' 张')) + '：' +
            String(err && err.message || err));
          return next();
        });
      }

      return next().catch(function (err) {
        if (err && err.message === '__cancelled__') {
          var e = new Error('已取消');
          e.cancelled = true;
          throw e;
        }
        throw err;
      }).then(function () {
        if (!writer.pages.length) {
          throw new Error('没有任何图片成功写入 PDF。' +
            (failed.length ? '\n\n' + failed.slice(0, 5).join('\n') : ''));
        }

        if (cancelled()) {
          var ce = new Error('已取消');
          ce.cancelled = true;
          throw ce;
        }

        // build() 完成后执行结构自检：xref 偏移、流边界、JPEG 头尾。
        // 校验不通过即报错，不输出无法打开的文件。
        return writer.build().then(function (out) {
          return {
            blob: out.blob,
            pages: out.pages,
            bytes: out.bytes,
            failed: failed
          };
        });
      });
    });
  }

  /**
   * 计算最宽图片的宽度，作为统一页面宽度。
   * 优先复用调用方已测量出的尺寸（文件池在收图时已测量），
   * 仅对缺少尺寸者执行一次解码，成本远低于整批预解码。
   * 无法测量者（损坏图）直接跳过，其会在处理阶段记入 failed。
   * @returns {Promise<number>} 0 表示无法测量，按原尺寸输出
   */
  function measureMaxWidth(items) {
    var max = 0;
    var i = 0;

    function step() {
      /* 已知尺寸的条目以循环一次处理完，不使用递归 ——
         数百张规模下同步递归会导致调用栈溢出；
         仅在需要解码时转入异步。 */
      while (i < items.length) {
        var item = items[i];
        i++;

        if (item.width > max) max = item.width;
        if (item.width) continue;

        return U.loadImageBitmap(item.file).then(function (bmp) {
          if (bmp.width > max) max = bmp.width;
          if (typeof bmp.close === 'function') bmp.close();
          return step();
        }, function () {
          return step();
        });
      }

      return Promise.resolve(max);
    }

    return step();
  }

  ITB.pdfBuild = {
    build: build,
    encodeJpeg: encodeJpeg,
    measureMaxWidth: measureMaxWidth
  };

})(window.ITB);
