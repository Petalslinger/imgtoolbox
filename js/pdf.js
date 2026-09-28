/* ============================================================
   pdf.js —— 把图片装订成 PDF（异步构建器）

   为什么所有图片都重编码成 JPEG，而不是像原来那样「能无损内嵌就无损内嵌」：

   无损内嵌 PNG 要求我把 PNG 的 IDAT 片段原样搬进 PDF 的 /FlateDecode 流。
   这条路踩了太多坑：得自己扫 chunk、判断色彩类型、确认它是内联的
   deflate 流（不能用 zlib 字典）……任何一处判断错，产出的就是一个
   「能下载但打不开」的 PDF —— 最坏的失败模式，而且用户完全看不出原因。

   JPEG 的 /DCTDecode 没有这些问题：它就是一个完整自包含的基线 JPEG
   字节流，PDF 阅读器直接交给 JPEG 解码器。兼容性最好，代码最短。

   代价是 JPEG 有损。所以：
     · 已经在用 JPEG 的图，质量设为 0.95，损失很小；
     · 无损的 PNG 会有轻微损失——这是为了可靠性付的代价，界面上写明了。

   自 png2pdf 传下来的行为依然保留：透明区域垫白底（原 to_rgb），
   一图一页，页面尺寸 = 图片像素尺寸（1px = 1pt）。
   ============================================================ */

window.ITB = window.ITB || {};

(function (ITB) {
  'use strict';

  var U = ITB.util;

  /** 给已解码的位图垫白底并编码成基线 JPEG */
  function encodeJpeg(bitmap, quality) {
    var canvas;
    if (typeof OffscreenCanvas === 'function') {
      canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    } else {
      canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }

    // alpha:false 是关键：否则透明区在编码成 JPEG 时可能变黑，
    // 而我们要的是和 png2pdf 的 to_rgb() 一样的效果——垫白
    var ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) ctx = canvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, 0, 0);

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
   * @param {object} [opts] { title, quality, onProgress(done,total,label), isCancelled() }
   * @returns {Promise<{blob, pages, bytes, reencoded}>}
   */
  function build(items, opts) {
    opts = opts || {};

    if (!items || !items.length) {
      return Promise.reject(new Error('没有可导出的图片。'));
    }

    // 先确认浏览器能把 DEFLATE 解开——pdfwriter 的自检要用它
    return ITB.pdf.load().then(function () {
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

          return encodeJpeg(bmp, quality).then(function (blob) {
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

          // 单张失败不中断整批，记下来继续
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

        // build() 会自己把每个流解压验一遍，验不过就直接报错
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

  ITB.pdfBuild = {
    build: build,
    encodeJpeg: encodeJpeg
  };

})(window.ITB);
