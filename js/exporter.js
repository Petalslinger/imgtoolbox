/* ============================================================
   exporter.js —— 四个分区各自的执行入口

   每个分区都是自成一体的一条路，彼此不共享任何设置：
     runShellAndZip  重命名         → 只改名字，图和格式原样，输出 ZIP
     runResizeToZip  改分辨率       → 只改尺寸，格式和名字原样，输出 ZIP
     runConvertToZip 转格式         → 只换编码，尺寸和名字原样，输出 ZIP
     runPdf          导出 PDF       → 只把原图合并成一份 PDF

   共通做法：结果流式装订。每张图在 Worker 里处理完就立刻交给
   ZIP / PDF 写出器，不把整批结果攒在内存里。
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

    checkModules(o.formatParams ? 'format' : (o.resizeParams ? 'resize' : 'shell'));

    /* 没有转格式时，让 Worker 按原格式输出：同格式直接透传，
       一个像素都不重编码。 */
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
        // 这个回调在 w.onmessage 里同步执行，抛异常会变成未捕获错误，
        // promise 不会 reject、errors 也收不到。所以必须兜住。
        try {
          var name = o.outNames[index] || ('image_' + (index + 1));
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
      outNames: selected.map(function (f) { return f.name; }),   // 名字不变
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
    checkModules('pdf');

    var selected = ITB.selectedFiles();
    var name = section('pdf').outName();

    var items = selected.map(function (f) {
      return { name: f.name, file: f.file };
    });

    return ITB.pdfBuild.build(items, {
      title: name || 'imgtoolbox',
      quality: 0.95,
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

  function checkModules(which) {
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
    void which;
  }

  function pushError(errors, label, e) {
    errors.push(label + '：' + String(e && e.message || e));
    if (window.console && console.error) {
      console.error('[imgtoolbox] ' + label + ' 处理失败', e);
    }
  }

  /* ZIP 条目名：保留「添加文件夹」时带进来的相对目录结构 */
  function entryName(name, fileItem) {
    var rel = fileItem.relPath || '';
    if (!rel) return name;

    var slash = rel.lastIndexOf('/');
    if (slash < 0) return name;

    return rel.slice(0, slash + 1) + name;
  }

  /** 没有转格式时，按原图格式决定 Worker 输出什么 */
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
    // GIF / BMP / AVIF 之类统一转 PNG，保证能进 ZIP
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
