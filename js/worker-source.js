/* ============================================================
   worker-source.js —— Worker 消息循环，以字符串形式保存
   经 Blob URL 创建 Worker，兼容 file:// 协议
   （file:// 下加载独立 worker.js 会被 CORS 拦截）。

   此文件不包含像素处理代码。缩放、填充白底、编码均复用
   transform.js —— 主线程以源码字符串传入，由本文件经 eval 定义
   self.processOne，以保持单一实现。
   ============================================================ */

window.ITB = window.ITB || {};

window.ITB.WORKER_SOURCE = String.raw`
'use strict';

self.onmessage = function (e) {
  var msg = e.data || {};
  var i;
  var jobs;
  var rp;
  var quality;
  var settled = false;

  /* 唯一出口：任何路径都必须向主线程发送一条 done。
     宿主依赖 done 才会 resolve，缺失将使 Promise 永久挂起、
     界面停留在「运行中」。以守卫变量保证仅发送一次。 */
  function settle(message) {
    if (settled) return;
    settled = true;
    if (message) self.postMessage({ type: 'error', index: -1, id: null, message: message });
    self.postMessage({ type: 'done' });
  }

  /* 第一步：接收主线程传入的像素处理实现源码并在本地求值。
     eval 在 Worker 全局作用域执行，故源码中引用的
     createImageBitmap / OffscreenCanvas 均解析为 Worker 的实现。
     源码同步执行且不引用 self.onmessage，不会重复消费消息。 */
  if (msg && msg.type === 'init') {
    try {
      eval(msg.source);
    } catch (err) {
      // 初始化失败即无像素实现，直接终结本批，避免主线程长期等待
      settle('工作线程初始化失败：' + (err && err.message || err));
      return;
    }
    return;
  }

  if (typeof self.processOne !== 'function') {
    settle('工作线程未初始化');
    return;
  }

  jobs = msg.jobs || [];
  rp = msg.resizeParams || null;
  quality = (typeof msg.quality === 'number') ? msg.quality : 0.92;
  i = 0;

  function fanout(done) {
    if (i >= jobs.length) { done(); return; }

    var job = jobs[i];
    var index = i;
    i++;

    /* 每个 job 可携带各自的 mime：改分辨率分区不改变格式与文件名，
       须按原格式编码，否则 .jpg 条目会写入 PNG 字节。
       仅当 job.mime 缺失时回退到本批 mime。 */
    var jobMime = job.mime || msg.mime || 'image/png';

    function fail(err) {
      self.postMessage({
        type: 'error', index: index, id: job.id,
        message: String(err && err.message || err)
      });
      fanout(done);
    }

    try {
      self.processOne(job.file, rp, jobMime, quality).then(function (res) {
        return res.blob.arrayBuffer().then(function (buf) {
          // 采用 blob.type 而非请求的 mime：canvas 可能已降级编码
          // （如不支持 WebP 时降级为 PNG），文件后缀须与实际格式一致
          var actualMime = res.blob.type || jobMime;
          // 以 Transferable 将 buffer 移交主线程，零拷贝
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
          fanout(done);
        });
      }, fail);
    } catch (err) {
      fail(err);
    }
  }

  /* 无论整批成功、失败或中途抛错，均须到达 settle()。
     缺失将导致宿主永久挂起，故在此显式兜底，
     不依赖各分支分别发送 done。 */
  try {
    fanout(function () { settle(null); });
  } catch (err) {
    settle('工作线程处理中断：' + (err && err.message || err));
  }
};
`;
