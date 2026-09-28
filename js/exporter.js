/* ============================================================
   exporter.js —— 四个分区的执行入口

   每个分区为独立执行路径，彼此不共享设置：
     runShellAndZip  重命名         → 仅改文件名，图片与格式不变，输出 ZIP
     runResizeToZip  改分辨率       → 仅改尺寸，格式与文件名不变，输出 ZIP
     runConvertToZip 转格式         → 仅更换编码，尺寸与文件名不变，输出 ZIP
     runPdf          导出 PDF       → 将原图合并为一份 PDF

   执行方式：Worker 逐张产出结果后立即提交给 ZIP / PDF 写出器累积，
   整批结束后统一调用 build() 生成最终文件；在 build 之前全部结果
   驻留内存，因此峰值内存占用与本次处理的图片总量成正比。
   ============================================================ */

window.ITB = window.ITB || {};

(function (ITB) {
  'use strict';

  var U = ITB.util;

  function section(id) {
    var s = ITB.sections.get(id);
    if (!s) throw new Error('未知的分区：' + id);
    return s;
  }

  /* ============================================================
     一、三种 ZIP 输出
     ============================================================ */

  /**
   * @param {object} o
   * @param {Array}  o.files          [{ id, file, relPath, name }]
   * @param {Array}  o.outNames       与 files 一一对应的最终文件名
   * @param {object|null} o.resizeParams
   * @param {object|null} o.formatParams
   * @param {function} o.onProgress
   * @param {function} o.isCancelled
   * @param {string} o.label          出错时用的名字
   */
  function zipRun(o) {
    var files = o.files;
    var fmtMime = o.formatParams ? ITB.transform.mimeOf(o.formatParams.format) : null;

    checkModules();

    /* 未启用转格式时，Worker 按原格式输出：同格式直接透传，
       不重编码任何像素。 */
    var jobs = [];
    var i;
    for (i = 0; i < files.length; i++) {
      jobs.push({
        id: files[i].id,
        file: files[i].file,
        mime: fmtMime || guessMime(files[i].file.type, files[i].name)
      });
    }

    var zip = new ITB.ZipWriter();
    var pending = [];
    var errors = [];
    var added = 0;

    return ITB.workerHost.run({
      jobs: jobs,
      resizeParams: o.resizeParams || null,
      mime: fmtMime,
      quality: o.formatParams ? o.formatParams.quality : 0.92,

      onResult: function (index, id, buffer, meta) {
        // 此回调在 w.onmessage 中同步执行，抛出的异常会成为未捕获错误，
        // promise 不会 reject 且 errors 无法收集，因此必须捕获。
        try {
          var name = o.outNames[index] || ('image_' + (index + 1));
          name = alignExt(name, meta, fmtMime, jobs[index]);
          pending.push(zip.add(entryName(name, files[index]), new Uint8Array(buffer), true));
          added++;
        } catch (e) {
          pushError(errors, o.outNames[index] || ('第 ' + (index + 1) + ' 张'), e);
        }
      },

      onError: function (index, id, message) {
        var label = o.outNames[index] || ('第 ' + (index + 1) + ' 张');
        errors.push(label + '：' + message);
      },

      onProgress: function (done, all) {
        if (!o.onProgress) return;
        var label = o.outNames[Math.max(0, Math.min(done, all) - 1)] || '';
        o.onProgress(done, all, label);
      },

      isCancelled: o.isCancelled
    }).then(function (res) {
      if (res.cancelled) return { cancelled: true, errors: errors };

      return (pending.length ? Promise.all(pending) : Promise.resolve()).then(function () {
        if (o.isCancelled && o.isCancelled()) return { cancelled: true, errors: errors };
        if (!added) {
          throw new Error('没有图片处理成功，没有可打包的内容。' +
            (errors.length ? '\n\n' + errors.slice(0, 5).join('\n') : ''));
        }

        var blob = zip.build();
        return {
          cancelled: false,
          kind: 'zip',
          blob: blob,
          bytes: blob.size,
          entries: added,
          errors: errors
        };
      });
    });
  }

  /** 分区一：只重命名 */
  function runShellAndZip(onProgress, isCancelled) {
    var plan = section('shell').plan();
    var selected = ITB.selectedFiles();

    return zipRun({
      files: selected,
      outNames: plan.map(function (p) { return p.finalName; }),
      resizeParams: null,
      formatParams: null,
      onProgress: onProgress,
      isCancelled: isCancelled
    });
  }

  /** 分区二：只改分辨率 */
  function runResizeToZip(onProgress, isCancelled) {
    var selected = ITB.selectedFiles();
    var p = section('resize').params();

    return zipRun({
      files: selected,
      outNames: selected.map(function (f) { return f.name; }),   // 文件名不变
      resizeParams: p,
      formatParams: null,
      onProgress: onProgress,
      isCancelled: isCancelled
    });
  }

  /** 分区三：只转格式 */
  function runConvertToZip(onProgress, isCancelled) {
    var selected = ITB.selectedFiles();
    var p = section('format').params();
    var changeExt = section('format').els.keepExt.checked;

    return zipRun({
      files: selected,
      outNames: selected.map(function (f) {
        var parts = U.splitExt(f.name);
        var ext = changeExt ? ITB.transform.extOf(p.format) : parts.ext;
        return U.joinName(parts.base, ext);
      }),
      resizeParams: null,
      formatParams: p,
      onProgress: onProgress,
      isCancelled: isCancelled
    });
  }

  /* ============================================================
     二、分区四：导出 PDF
     ============================================================ */

  function runPdf(onProgress, isCancelled) {
    checkModules();

    var selected = ITB.selectedFiles();
    var name = section('pdf').outName();

    var items = selected.map(function (f) {
      // 传入已测量出的尺寸，供 pdfBuild 计算统一页面宽度，
      // 避免为测量宽度而重复解码每张图
      return { name: f.name, file: f.file, width: f.width, height: f.height };
    });

    return ITB.pdfBuild.build(items, {
      title: name || 'imgtoolbox',
      quality: 0.95,
      // 统一页面宽度：全部按最宽一张等比缩放，实现等宽且不变形
      uniformWidth: section('pdf').uniformOn(),
      onProgress: onProgress,
      isCancelled: isCancelled
    }).then(function (out) {
      return {
        cancelled: false,
        kind: 'pdf',
        blob: out.blob,
        bytes: out.bytes,
        pages: out.pages,
        errors: out.failed || []
      };
    }, function (err) {
      /* pdf.js 以 reject({cancelled:true}) 表示取消，而非失败。
         不识别该约定时，取消操作会被报告为「执行失败」。
         ZIP 路径则在 resolve 结果中携带 cancelled 标志，两者约定不同。 */
      if (err && err.cancelled) {
        return { cancelled: true, kind: 'pdf', errors: [] };
      }
      throw err;
    });
  }

  /* ============================================================
     三、统一调度
     ============================================================ */

  var RUNNERS = {
    shell: runShellAndZip,
    resize: runResizeToZip,
    format: runConvertToZip,
    pdf: runPdf
  };

  function runSection(id, onProgress, isCancelled) {
    var fn = RUNNERS[id];
    if (!fn) return Promise.reject(new Error('未知的分区：' + id));
    return fn(onProgress, isCancelled);
  }

  /* ============================================================
     四、零碎工具
     ============================================================ */

  function checkModules() {
    if (typeof ITB.WORKER_SOURCE !== 'string' || !ITB.WORKER_SOURCE) {
      throw new Error('js/worker-source.js 没有加载成功。请确认 js/ 目录完整、' +
        '且页面里每个 <script> 都能找到对应文件。');
    }
    if (!ITB.transform || typeof ITB.transform.processOne !== 'function') {
      throw new Error('js/transform.js 没有加载成功（ITB.transform.processOne 缺失）。');
    }
    if (!ITB.pdf || typeof ITB.pdf.PdfWriter !== 'function') {
      throw new Error('js/pdfwriter.js 没有加载成功（ITB.pdf.PdfWriter 缺失）。');
    }
  }

  function pushError(errors, label, e) {
    errors.push(label + '：' + String(e && e.message || e));
    if (window.console && console.error) {
      console.error('[imgtoolbox] ' + label + ' 处理失败', e);
    }
  }

  /* ZIP 条目名：保留「添加文件夹」导入时的相对目录结构 */
  function entryName(name, fileItem) {
    var rel = fileItem.relPath || '';
    if (!rel) return name;

    var slash = rel.lastIndexOf('/');
    if (slash < 0) return name;

    return rel.slice(0, slash + 1) + name;
  }

  /**
   * 使扩展名与**实际**编码一致。
   * 仅当目标格式未能实现时改写扩展名：典型场景为浏览器 canvas 不支持
   * 编码 WebP 而自动降级为 PNG；若不处理，将产出扩展名为 .webp 实为 PNG 的文件。
   * 用户主动转换格式（fmtMime 命中）时不改写。
   */
  function alignExt(name, meta, fmtMime, job) {
    var actual = meta && meta.mime;
    if (!actual) return name;

    var wanted = fmtMime || (job && job.mime);
    if (wanted && actual === wanted) return name;

    var real = ITB.transform.formatFromMime(actual);
    if (!real) return name;

    var parts = U.splitExt(name);
    var ext = ITB.transform.extOf(real);
    return parts.ext === ext ? name : U.joinName(parts.base, ext);
  }

  /** 未转格式时，按原图格式决定 Worker 的输出类型 */
  function guessMime(type, name) {
    if (type && type.indexOf('image/') === 0 &&
        type !== 'image/gif' && type.indexOf('avif') < 0 &&
        type.indexOf('bmp') < 0) {
      return type;
    }
    var ext = U.splitExt(name).ext;
    if (ext === '.png') return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    // GIF / BMP / AVIF 等统一转为 PNG，保证可写入 ZIP
    return 'image/png';
  }

  ITB.exporter = {
    runSection: runSection,
    runShellAndZip: runShellAndZip,
    runResizeToZip: runResizeToZip,
    runConvertToZip: runConvertToZip,
    runPdf: runPdf
  };

})(window.ITB);
