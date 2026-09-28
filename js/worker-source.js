/* ============================================================
   worker-source.js —— Worker 里的消息循环，字符串形式保存
   用 Blob URL 起 Worker，file:// 协议下也能用
   （file:// 加载独立 worker.js 会被 CORS 拦掉）。

   这里刻意「不」包含任何像素处理代码。缩放、垫白底、编码全部
   复用 transform.js —— 主线程把那些函数的源码字符串发过来，
   由这里自我 eval 出 self.processOne，保证只有一份实现。
   ============================================================ */

window.ITB = window.ITB || {};

window.ITB.WORKER_SOURCE = String.raw`
'use strict';

self.onmessage = function (e) {
  var msg = e.data || {};
  var i;
  var jobs;
  var rp;
  var mime;
  var quality;

  /* 第一步：接收主线程送来的像素处理实现源码并在本地求值。
     eval 在这里跑，作用域就是 worker 自己的全局，所以那些函数
     里用到的 createImageBitmap / OffscreenCanvas 都是 worker 的。
     源码是同步执行的，不引用 self.onmessage，不会把消息再跑一遍。 */
  if (msg && msg.type === 'init') {
    try {
      eval(msg.source);
    } catch (err) {
      self.postMessage({
        type: 'error', index: -1, id: null,
        message: '工作线程初始化失败：' + (err && err.message || err)
      });
    }
    return;
  }

  if (typeof self.processOne !== 'function') {
    self.postMessage({ type: 'error', index: -1, id: null, message: '工作线程未初始化' });
    return;
  }

  jobs = msg.jobs || [];
  rp = msg.resizeParams || null;
  mime = msg.mime || 'image/png';
  quality = (typeof msg.quality === 'number') ? msg.quality : 0.92;
  i = 0;

  function next() {
    if (i >= jobs.length) {
      self.postMessage({ type: 'done' });
      return;
    }

    var job = jobs[i];
    var index = i;
    i++;

    self.processOne(job.file, rp, mime, quality).then(function (res) {
      res.blob.arrayBuffer().then(function (buf) {
        // 用 blob.type 而不是请求的 mime：canvas 可能降级过编码
        // （比如 WebP 不被支持时退回 PNG），文件后缀得跟着真实格式走
        var actualMime = res.blob.type || mime;
        // 把 buffer 移交回主线程，零拷贝
        self.postMessage({
          type: 'result',
          index: index,
          id: job.id,
          buffer: buf,
          mime: actualMime,
          width: res.width,
          height: res.height,
          sourceWidth: res.sourceWidth,
          sourceHeight: res.sourceHeight,
          passthrough: !!res.passthrough
        }, [buf]);
        next();
      }, function (err) {
        self.postMessage({ type: 'error', index: index, id: job.id, message: String(err && err.message || err) });
        next();
      });
    }, function (err) {
      self.postMessage({ type: 'error', index: index, id: job.id, message: String(err && err.message || err) });
      next();
    });
  }

  next();
};
`;
