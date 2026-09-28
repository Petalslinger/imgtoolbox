/* ============================================================
   workerhost.js —— Worker 宿主侧
   从字符串起一个 Blob URL Worker（file:// 下也能跑），
   把 transform.js 里的纯函数实现注入进去，然后派活。
   Worker 串行处理，每完成一个就把 ArrayBuffer 移交回主线程。
   ============================================================ */

window.ITB = window.ITB || {};

(function (ITB) {
  'use strict';

  /* 每次运行都用一个全新的 worker：worker 是廉价的，
     而共用单例在 finish() 里摘掉 onmessage 之后会永远挂着，
     下一次运行必然收到上一批的残留消息。 */
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

  /* 像素处理的实现只有一份，在 transform.js 里。跨线程没法传函数
     （结构化克隆不能复制函数，postMessage 一个函数会直接抛
     DataCloneError），所以改成把源码字符串交给 worker，让它在自己的
     上下文里做一次 eval —— 这样两边跑的是同一份代码。

     这些函数里引用的辅助函数必须一起注进去，否则 worker 里会
     静默退化成错误行为（比如默认参数悄悄生效）。所以下面有一道
     静态自检，把「悄悄算错」变成「明确报错并退回主线程」。 */
  var injectSource = null;

  var TOOLKIT = ['computeTarget', 'canvasToBlob', 'decodeViaImage', 'decodeImage',
                 'drawToCanvas', 'processOne'];

  // 不参与自由标识符判断的词：语言关键字，以及各函数自己的参数名 / 局部名
  var NOISE = ['function', 'return', 'var', 'let', 'const', 'if', 'else', 'for',
               'while', 'try', 'catch', 'new', 'typeof', 'instanceof', 'throw',
               'in', 'of', 'this', 'null', 'true', 'false',
               // 参数名与局部名
               'srcW', 'srcH', 'p', 'v', 'd', 'x', 'n', 'w', 'h', 'scale', 'blocked',
               'targetW', 'targetH', 'opaque', 'canvas', 'ctx', 'mime', 'quality',
               'type', 'b', 'resolve', 'reject', 'file', 'resizeParams', 'bitmap',
               'bmp', 'target', 'outW', 'outH', 'wantsOpaque', 'needRedraw', 'blob',
               'err', 'img', 'url', 'size'];

  // 这些标识符由 worker 或浏览器提供，不需要注入
  var WHITELIST = ['self', 'window', 'globalThis', 'Math', 'JSON', 'Date', 'Number',
                   'String', 'Object', 'Array', 'Boolean', 'Promise', 'Error',
                   'TypeError', 'isFinite', 'isNaN', 'parseInt', 'parseFloat',
                   'URL', 'Blob', 'Image', 'Response', 'Uint8Array', 'ArrayBuffer',
                   'DataView', 'OffscreenCanvas', 'createImageBitmap', 'document',
                   'console', 'setTimeout', 'clearTimeout', 'undefined', 'NaN',
                   'Infinity', 'postMessage'];

  // 先把手写注释剥掉，否则中文说明里的「num」之类会被误认成函数调用
  var STRIP_COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

  /**
   * 静态自检：注入进 worker 的函数如果引用了没被一起注入的辅助函数，
   * worker 里会静默算错（比如取不到参数、悄悄用了默认值）。
   * 这里把它变成明确报错，宁可退回主线程也不要算错。
   */
  function checkToolkit() {
    var i, k;

    for (i = 0; i < TOOLKIT.length; i++) {
      if (typeof ITB.transform[TOOLKIT[i]] !== 'function') {
        throw new Error('缺少像素处理实现：transform.' + TOOLKIT[i]);
      }
    }

    var known = TOOLKIT.concat(WHITELIST, NOISE);
    var local = [];

    for (i = 0; i < TOOLKIT.length; i++) {
      var clean = String(ITB.transform[TOOLKIT[i]]).replace(STRIP_COMMENTS, ' ');
      var m;

      // 收集形参名
      var params = /\(([^)]*)\)/.exec(clean);
      if (params && params[1]) {
        local = local.concat(params[1].split(',').map(function (s) { return s.trim(); }));
      }

      // 只检查「以函数调用形式出现」的标识符：name( ，这样关键字和属性名都不会误报
      var re = /\b([A-Za-z_$][\w$]*)\s*\(/g;
      while ((m = re.exec(clean)) !== null) {
        var id = m[1];
        if (known.indexOf(id) >= 0 || local.indexOf(id) >= 0) continue;
        throw new Error('像素函数引用了未注入的辅助函数「' + id + '」，' +
          'worker 里会算错。请把它补进 workerhost.js 的 TOOLKIT 列表。');
      }
    }

    void k;
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
   * @param {Array}    opts.jobs         [{ id, file }]
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
      var w = spawnWorker();

      function cleanup() {
        if (cancelTimer) { clearInterval(cancelTimer); cancelTimer = null; }
        if (w) {
          w.onmessage = null;
          w.onerror = null;
          try { w.terminate(); } catch (e) { /* 已经死了就算了 */ }
        }
      }

      // 完成信号只认 worker 发来的 'done'。它是 worker 内部消息循环
      // 真正跑完之后才投递的，也就是天然的「上一批消息已排空」确认点，
      // 所以在这里 terminate 是安全的。
      function finish(ok, cancelled) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ ok: ok, cancelled: !!cancelled, results: done, errors: errors });
      }

      if (!w) {
        // 环境不支持 Worker：退化成主线程串行，界面会卡但结果正确
        runInline(opts, finish);
        return;
      }

      w.onmessage = function (e) {
        var msg = e.data || {};

        if (msg.type === 'result') {
          opts.onResult(msg.index, msg.id, msg.buffer, {
            mime: msg.mime,
            width: msg.width,
            height: msg.height,
            sourceWidth: msg.sourceWidth,
            sourceHeight: msg.sourceHeight,
            passthrough: msg.passthrough
          });
          done++;
          if (opts.onProgress) opts.onProgress(done + errors, total);
          return;
        }

        if (msg.type === 'error') {
          errors++;
          if (opts.onError) opts.onError(msg.index, msg.id, msg.message);
          if (opts.onProgress) opts.onProgress(done + errors, total);
          return;
        }

        if (msg.type === 'done') {
          finish(errors === 0, false);
        }
      };

      w.onerror = function (ev) {
        errors++;
        if (opts.onError) opts.onError(-1, null, (ev && ev.message) || '工作线程出错');
        finish(false, false);
      };

      // worker 内部是串行的，主线程用定时器盯取消标志。
      // 取消时直接 terminate：比让它把手上的图做完更快，也立刻释放内存。
      if (opts.isCancelled) {
        cancelTimer = setInterval(function () {
          if (settled) { clearInterval(cancelTimer); return; }
          if (opts.isCancelled()) finish(false, true);
        }, 120);
      }

      // 先把像素处理实现送进去，再派活。两条消息在同一个端口的队列里，
      // init 必然先被处理，不存在竞态。
      var src;
      try {
        src = pixelSource();
      } catch (e) {
        runInline(opts, finish);
        return;
      }
      w.postMessage({ type: 'init', source: src });

      w.postMessage({
        jobs: jobs.map(function (j) { return { id: j.id, file: j.file }; }),
        resizeParams: opts.resizeParams || null,
        mime: opts.mime,
        quality: opts.quality
      });
    });
  }

  /* ── 没有 Worker 支持时的兜底：主线程串行 ───────────────── */

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

      ITB.transform.processOneInline(job, opts.resizeParams, opts.mime, opts.quality)
        .then(function (res) {
          return res.blob.arrayBuffer().then(function (buf) {
            opts.onResult(index, job.id, buf, {
              mime: res.blob.type || opts.mime,
              width: res.width,
              height: res.height,
              sourceWidth: res.sourceWidth,
              sourceHeight: res.sourceHeight,
              passthrough: !!res.passthrough
            });
            done++;
            if (opts.onProgress) opts.onProgress(done + errors, jobs.length);
            step();
          });
        })
        .catch(function (err) {
          errors++;
          if (opts.onError) opts.onError(index, job.id, String(err && err.message || err));
          if (opts.onProgress) opts.onProgress(done + errors, jobs.length);
          step();
        });
    }

    step();
  }

  ITB.workerHost = {
    run: run,
    /* 只报告环境有没有 Worker 构造器。真起一个再杀掉太浪费，
       而且真实可用性会由 run() 自己在失败时退回 runInline 处理。 */
    hasWorker: function () {
      return typeof Worker === 'function' && typeof Blob === 'function' &&
             typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
    }
  };

})(window.ITB);
