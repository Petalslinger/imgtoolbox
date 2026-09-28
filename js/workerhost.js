/* ============================================================
   workerhost.js —— Worker 宿主侧
   以 Blob URL 创建 Worker（兼容 file://），注入 transform.js 中的
   纯函数实现，然后分发任务。Worker 串行处理，每完成一项即把
   ArrayBuffer 移交回主线程。
   ============================================================ */

window.ITB = window.ITB || {};

(function (ITB) {
  'use strict';

  /* 每次运行创建独立的 Worker。Worker 实例创建开销低；若复用单例，
     finish() 摘除 onmessage 后实例会长期驻留，后续运行会收到上一批
     的残留消息。 */
  function spawnWorker() {
    try {
      var blob = new Blob([ITB.WORKER_SOURCE], { type: 'application/javascript' });
      var url = URL.createObjectURL(blob);
      var w = new Worker(url);
      URL.revokeObjectURL(url);
      return w;
    } catch (e) {
      return null;
    }
  }

  /* 回调统一包裹 try/catch。回调在消息处理或 Promise 链中同步执行，
     异常会变成未捕获错误并导致整批 Promise 永不落定。
     worker 与主线程兜底两条路径共用此实现。 */
  function safeCall(fn, args, label) {
    if (typeof fn !== 'function') return;
    try {
      fn.apply(null, args);
    } catch (e) {
      if (window.console && console.error) {
        console.error('[imgtoolbox] ' + label + ' 回调抛错', e);
      }
    }
  }

  /* 像素处理实现仅存于 transform.js。结构化克隆不支持函数
     （postMessage 函数会抛 DataCloneError），因此改为将函数源码字符串
     传给 Worker，由其在自己上下文中 eval，保证两侧执行同一份代码。

     这些函数引用的辅助函数必须一并注入，否则 Worker 内会抛
     ReferenceError。checkToolkit() 负责提前将其转为明确错误。 */
  var injectSource = null;

  /* 注入 Worker 的完整清单。顺序无关（函数声明会提升），但必须包含
     被调用函数的所有辅助依赖：computeTarget 调用 num，processOne 调用
     decodeImage / computeTarget / drawToCanvas / canvasToBlob。
     遗漏任一项都会由 checkToolkit() 检出。 */
  var TOOLKIT = ['num', 'computeTarget', 'canvasToBlob', 'decodeViaImage',
                 'decodeImage', 'drawToCanvas', 'processOne'];

  /* 停滞超时阈值：Worker 在「基础额度 + 每张额度」内没有发出 done 即中止本批。
     额度需覆盖大图解码与编码耗时，仅用于捕获完全无响应的情形。 */
  var STALL_BASE_MS = 30000;
  var STALL_PER_ITEM_MS = 15000;

  /* 以下标识符由 Worker 或浏览器提供，无需注入。
     注意 Image / document 仅存在于主线程：Worker 中不会进入该兜底分支，
     因为支持 Worker 的浏览器必然提供 OffscreenCanvas。 */
  var WHITELIST = ['self', 'window', 'globalThis', 'Math', 'JSON', 'Date', 'Number',
                   'String', 'Object', 'Array', 'Boolean', 'Promise', 'Error',
                   'TypeError', 'isFinite', 'isNaN', 'parseInt', 'parseFloat',
                   'URL', 'Blob', 'Image', 'Response', 'Uint8Array', 'ArrayBuffer',
                   'DataView', 'OffscreenCanvas', 'createImageBitmap', 'document',
                   'console', 'setTimeout', 'clearTimeout', 'undefined', 'NaN',
                   'Infinity', 'postMessage'];

  // 先剥离注释，避免说明文字中的标识符被误判为函数调用。
  // 未处理字符串字面量：目标函数中不存在含 // 的字符串。
  var STRIP_COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

  /**
   * 静态自检：若注入 Worker 的函数调用了未被一并注入的辅助函数，
   * Worker 内会抛 ReferenceError。此处提前转为明确错误，
   * 随后退回主线程处理，避免整批任务在 Worker 内静默失败。
   *
   * 扫描须排除方法调用：`canvas.toBlob(` 中的 toBlob 是属性名而非自由
   * 标识符。因此先消去所有「.名称」，剩余 `名称(` 才是真正的函数调用。
   */
  function checkToolkit() {
    var i;

    for (i = 0; i < TOOLKIT.length; i++) {
      if (typeof ITB.transform[TOOLKIT[i]] !== 'function') {
        throw new Error('缺少像素处理实现：transform.' + TOOLKIT[i]);
      }
    }

    var known = TOOLKIT.concat(WHITELIST);

    for (i = 0; i < TOOLKIT.length; i++) {
      var src = String(ITB.transform[TOOLKIT[i]]).replace(STRIP_COMMENTS, ' ');

      // 提取形参名（仅取裸标识符，忽略默认值与解构）
      var params = /\(([^)]*)\)/.exec(src);
      var local = [];
      if (params && params[1]) {
        params[1].split(',').forEach(function (s) {
          var nm = /^\s*([A-Za-z_$][\w$]*)/.exec(s);
          if (nm) local.push(nm[1]);
        });
      }

      // 1. 消去所有属性访问（foo.bar( / foo.bar.baz( / a.b）
      var masked = src.replace(/\.\s*[A-Za-z_$][\w$]*/g, '@');

      // 2. 剩余的 `标识符(` 即为自由函数调用
      var re = /(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
      var m;
      while ((m = re.exec(masked)) !== null) {
        var id = m[2];
        if (known.indexOf(id) >= 0 || local.indexOf(id) >= 0) continue;
        throw new Error('像素函数 transform.' + TOOLKIT[i] + ' 调用了未注入的辅助函数「' +
          id + '」，worker 里会直接报错。请把它补进 workerhost.js 的 TOOLKIT 列表' +
          '（transform.js 里没导出的也要一并导出）。');
      }
    }
  }

  function pixelSource() {
    if (injectSource) return injectSource;

    checkToolkit();

    var body = '';
    for (var i = 0; i < TOOLKIT.length; i++) {
      body += String(ITB.transform[TOOLKIT[i]]) + '\n';
    }
    body += 'self.processOne = processOne;\n';

    // 真正执行 eval 的是 worker 自己，这里只是拼一段字符串
    injectSource = 'self.eval(' + JSON.stringify(body) + ');';
    return injectSource;
  }

  /**
   * 跑一批任务。
   * @param {object} opts
   * @param {Array}    opts.jobs         [{ id, file, mime }]，mime 可省略，省略时用本批的 opts.mime
   * @param {object}   opts.resizeParams 缩放参数，null 表示不缩放
   * @param {string}   opts.mime         输出 MIME
   * @param {number}   opts.quality      输出质量
   * @param {function} opts.onResult     (index, id, buffer, meta)
   * @param {function} [opts.onError]    (index, id, message) 单个失败不中断整批
   * @param {function} [opts.onProgress] (done, total)
   * @param {function} [opts.isCancelled]() => boolean
   * @returns {Promise<{ok, cancelled, results, errors}>}
   */
  function run(opts) {
    var jobs = opts.jobs || [];
    var total = jobs.length;

    return new Promise(function (resolve) {
      if (!total) { resolve({ ok: true, cancelled: false, results: 0, errors: 0 }); return; }
      if (opts.isCancelled && opts.isCancelled()) {
        resolve({ ok: false, cancelled: true, results: 0, errors: 0 });
        return;
      }

      var done = 0;
      var errors = 0;
      var settled = false;
      var cancelTimer = null;
      var watchdog = null;
      var lastMessageAt = 0;      // 最近一次收到 worker 消息的时间戳
      var w = spawnWorker();

      function cleanup() {
        if (cancelTimer) { clearInterval(cancelTimer); cancelTimer = null; }
        if (watchdog) { clearInterval(watchdog); watchdog = null; }
        if (w) {
          w.onmessage = null;
          w.onerror = null;
          try { w.terminate(); } catch (e) { /* 实例可能已终止 */ }
        }
      }

      /* 完成信号以 Worker 发出的 'done' 为准。该消息在 Worker 内部消息
         循环结束后投递，可作为「上一批消息已处理完毕」的确认点，
         因此在此处 terminate 是安全的。 */
      function finish(ok, cancelled) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ ok: ok, cancelled: !!cancelled, results: done, errors: errors });
      }

      /* 退回主线程处理时输出警告：否则界面无提示地卡顿，
         且无法判断 Worker 是否生效。 */
      function fallbackInline(reason) {
        if (window.console && console.warn) {
          console.warn('[imgtoolbox] 退回主线程处理：' + reason);
        }
        runInline(opts, finish);
      }

      if (!w) {
        // 环境不支持 Worker（file:// 下部分浏览器存在此限制）
        fallbackInline('无法创建 Worker');
        return;
      }

      /* 停滞超时保护：Worker 因任何原因未发出 'done'（注入源码语法错误、
         内部异常等）时，仍需让 Promise 落定，避免界面停留在运行状态。
         判据为是否持续有进展而非总耗时：每收到一条消息即重新计时，
         因此单张大图的长时间编码不会被误判。 */
      function armWatchdog() {
        if (watchdog) return;
        var budget = STALL_BASE_MS + total * STALL_PER_ITEM_MS;
        lastMessageAt = Date.now();

        watchdog = setInterval(function () {
          if (settled) { clearInterval(watchdog); watchdog = null; return; }
          if (Date.now() - lastMessageAt <= budget) return;

          clearInterval(watchdog);
          watchdog = null;
          // 先告知调用方原因；即使该回调抛错也必须让 Promise 落定
          safeCall(opts.onError, [-1, null,
            '工作线程超过 ' + Math.round(budget / 1000) +
            ' 秒没有任何进展，已中止本批。可以重试，或减少一次处理的张数。'], 'onError');
          finish(false, false);
        }, 1000);
      }

      function noteProgress() {
        lastMessageAt = Date.now();
      }

      w.onmessage = function (e) {
        var msg = e.data || {};
        noteProgress();

        if (msg.type === 'result') {
          safeCall(opts.onResult, [msg.index, msg.id, msg.buffer, {
            mime: msg.mime,
            width: msg.width,
            height: msg.height,
            sourceWidth: msg.sourceWidth,
            sourceHeight: msg.sourceHeight,
            passthrough: msg.passthrough
          }], 'onResult');
          done++;
          safeCall(opts.onProgress, [done + errors, total], 'onProgress');
          return;
        }

        if (msg.type === 'error') {
          errors++;
          safeCall(opts.onError, [msg.index, msg.id, msg.message], 'onError');
          safeCall(opts.onProgress, [done + errors, total], 'onProgress');
          return;
        }

        if (msg.type === 'done') {
          finish(errors === 0, false);
        }
      };

      w.onerror = function (ev) {
        errors++;
        // 同样需要包裹，否则回调抛错会导致 Promise 悬置
        safeCall(opts.onError, [-1, null, (ev && ev.message) || '工作线程出错'], 'onError');
        finish(false, false);
      };

      /* Worker 内部串行执行，主线程以定时器轮询取消标志。
         取消时直接 terminate：无需等待当前图片处理完成，并可立即释放内存。 */
      if (opts.isCancelled) {
        cancelTimer = setInterval(function () {
          if (settled) { clearInterval(cancelTimer); return; }
          if (opts.isCancelled()) finish(false, true);
        }, 120);
      }

      /* 先注入像素处理实现，再分发任务。两条消息在同一端口的队列中，
         init 必然先被处理，不存在竞态。 */
      var src;
      try {
        src = pixelSource();
      } catch (e) {
        fallbackInline(String(e && e.message || e));
        return;
      }
      w.postMessage({ type: 'init', source: src });

      w.postMessage({
        // 逐项携带 mime：改分辨率分区不改变格式，须按各图原格式编码
        jobs: jobs.map(function (j) { return { id: j.id, file: j.file, mime: j.mime }; }),
        resizeParams: opts.resizeParams || null,
        mime: opts.mime,
        quality: opts.quality
      });

      // 任务分发完成后开始计时，覆盖 Worker 无响应的情形
      armWatchdog();
    });
  }

  /* ── 无 Worker 支持时的回退路径：主线程串行 ─────────────── */

  function runInline(opts, finish) {
    var jobs = opts.jobs;
    var i = 0;
    var errors = 0;
    var done = 0;

    function step() {
      if (opts.isCancelled && opts.isCancelled()) { finish(false, true); return; }
      if (i >= jobs.length) { finish(errors === 0, false); return; }

      var job = jobs[i];
      var index = i;
      i++;

      // 回退路径同样按各项自身的 mime 处理，与 Worker 内逻辑保持一致
      ITB.transform.processOneInline(job, opts.resizeParams, job.mime || opts.mime, opts.quality)
        .then(function (res) {
          return res.blob.arrayBuffer().then(function (buf) {
            // 回调异常不得影响 res，也不得中断整批，故同样包裹
            safeCall(opts.onResult, [index, job.id, buf, {
              mime: res.blob.type || job.mime || opts.mime,
              width: res.width,
              height: res.height,
              sourceWidth: res.sourceWidth,
              sourceHeight: res.sourceHeight,
              passthrough: !!res.passthrough
            }], 'onResult');
            done++;
            safeCall(opts.onProgress, [done + errors, jobs.length], 'onProgress');
            step();
          });
        })
        .catch(function (err) {
          errors++;
          safeCall(opts.onError, [index, job.id, String(err && err.message || err)], 'onError');
          safeCall(opts.onProgress, [done + errors, jobs.length], 'onProgress');
          step();
        });
    }

    step();
  }

  ITB.workerHost = {
    run: run,

    /* 仅检测环境中是否存在 Worker 构造器。实际创建实例开销较大，
       真实可用性由 run() 在失败时退回 runInline 处理。 */
    hasWorker: function () {
      return typeof Worker === 'function' && typeof Blob === 'function' &&
             typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
    },

    /* 供自检调用：实际组装一次注入源码。
       组装过程会将「注入清单遗漏辅助函数」直接暴露为异常。
       该方法不参与运行时功能，仅用于在 selftest 中覆盖此类缺陷。 */
    buildInjectSource: function () {
      injectSource = null;      // 强制重新计算，绕过缓存
      return pixelSource();
    }
  };

})(window.ITB);
