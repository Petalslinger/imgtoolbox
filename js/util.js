/* ============================================================
   util.js —— 通用工具，无依赖
   挂载于 window.ITB。所有模块经经典 <script> 加载：
   file:// 协议下 ES module 会被 CORS 拦截，导致双击无法打开。
   ============================================================ */

window.ITB = window.ITB || {};

(function (ITB) {
  'use strict';

  /* ── 数字感知排序 ─────────────────────────────────────────
     沿用 png2pdf 的 natural_key：将文本中的数字段拆出并按整数比较，
     因此 'img2' 排在 'img10' 之前，而非 'img1' 之后。
     ──────────────────────────────────────────────────────── */

  function naturalKey(name) {
    var parts = String(name).split(/(\d+)/);
    var key = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p === '') continue;
      key.push(/^\d+$/.test(p) ? parseInt(p, 10) : p.toLowerCase());
    }
    return key;
  }

  // 混合类型数组的比较（number 与 string 不可直接比较，需按类型分支）
  function compareKeys(a, b) {
    var n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) {
      var x = a[i], y = b[i];
      var tx = typeof x, ty = typeof y;
      if (tx === ty) {
        if (x < y) return -1;
        if (x > y) return 1;
      } else {
        // 数字段排在文本段之前，与文件管理器一致
        return tx === 'number' ? -1 : 1;
      }
    }
    return a.length - b.length;
  }

  function naturalCompare(a, b) { return compareKeys(naturalKey(a), naturalKey(b)); }
  function lexCompare(a, b) {
    a = String(a).toLowerCase(); b = String(b).toLowerCase();
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /* ── 文件名处理 ─────────────────────────────────────────── */

  function splitExt(name) {
    var s = String(name);
    var i = s.lastIndexOf('.');
    // 首字符的点为隐藏文件标记，不计入扩展名；'.gitignore' 整体视为主名
    if (i <= 0) return { base: s, ext: '' };
    return { base: s.slice(0, i), ext: s.slice(i).toLowerCase() };
  }

  function joinName(base, ext) {
    if (!ext) return base;
    return base + (ext.charAt(0) === '.' ? ext : '.' + ext);
  }

  /* ── 字节 / 字符串 ──────────────────────────────────────── */

  // UTF-8 编码（用于 ZIP 条目名与 PDF 十六进制字符串）
  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  // 将任意字符串按 Latin-1 / PDFDocEncoding 安全转换为字节：
  // 非 ASCII 字符替换为 '?'，避免产生非法字节导致 PDF 损坏。
  function latin1Bytes(str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      out[i] = c < 256 ? c : 63; // 63 = '?'
    }
    return out;
  }

  function bytesToAscii(bytes, start, end) {
    var s = '';
    var e = end === undefined ? bytes.length : end;
    for (var i = start || 0; i < e; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  /* ── 字节格式化 ─────────────────────────────────────────── */

  function formatBytes(n) {
    if (!isFinite(n) || n < 0) return '—';
    if (n < 1024) return n + ' B';
    var kb = n / 1024;
    if (kb < 1024) return (kb < 10 ? kb.toFixed(1) : Math.round(kb)) + ' KB';
    var mb = kb / 1024;
    if (mb < 1024) return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' MB';
    return (mb / 1024).toFixed(2) + ' GB';
  }

  function pad(n, width) {
    var s = String(Math.abs(n));
    while (s.length < width) s = '0' + s;
    return (n < 0 ? '-' : '') + s;
  }

  function dateStamp() {
    var d = new Date();
    return d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2);
  }

  /* ── DOM 快捷方式 ───────────────────────────────────────── */

  function $(id) { return document.getElementById(id); }

  function el(tag, opts) {
    var node = document.createElement(tag);
    opts = opts || {};
    if (opts.cls) node.className = opts.cls;
    if (opts.text !== undefined) node.textContent = opts.text;
    if (opts.attrs) {
      for (var k in opts.attrs) {
        var v = opts.attrs[k];
        // 跳过 undefined / null，避免写出 min="undefined" 之类的无效属性
        if (v === undefined || v === null || v === false) continue;
        node.setAttribute(k, v);
      }
    }
    if (opts.props) for (var p in opts.props) node[p] = opts.props[p];
    if (opts.on) for (var ev in opts.on) node.addEventListener(ev, opts.on[ev]);
    if (opts.parent) opts.parent.appendChild(node);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  /* ── Toast ──────────────────────────────────────────────── */

  var toastHost = null;

  function toast(msg, kind, ms) {
    if (!toastHost) toastHost = $('toast-host');
    if (!toastHost) return;
    var node = el('div', { cls: 'toast' + (kind ? ' is-' + kind : ''), text: msg, parent: toastHost });
    var life = ms || (kind === 'danger' ? 6000 : 3200);
    setTimeout(function () {
      node.style.transition = 'opacity .2s';
      node.style.opacity = '0';
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 220);
    }, life);
  }

  /* ── 图片解码（Worker 内不可用，走 createImageBitmap） ──── */

  function loadImageBitmap(file) {
    if (typeof createImageBitmap === 'function') {
      // imageOrientation:'from-image'：按 EXIF 方向标记校正照片方向
      return createImageBitmap(file, { imageOrientation: 'from-image' })
        .catch(function () { return createImageBitmap(file); });
    }
    // 兜底路径：不支持 createImageBitmap 时使用 <img> + objectURL
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
      img.src = url;
    });
  }

  /* ── 触发下载 ───────────────────────────────────────────── */

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 2000);
  }

  /* ── 导出 ───────────────────────────────────────────────── */

  ITB.util = {
    naturalKey: naturalKey,
    naturalCompare: naturalCompare,
    lexCompare: lexCompare,
    splitExt: splitExt,
    joinName: joinName,
    utf8Bytes: utf8Bytes,
    latin1Bytes: latin1Bytes,
    bytesToAscii: bytesToAscii,
    formatBytes: formatBytes,
    pad: pad,
    dateStamp: dateStamp,
    $: $,
    el: el,
    clear: clear,
    toast: toast,
    loadImageBitmap: loadImageBitmap,
    downloadBlob: downloadBlob
  };

})(window.ITB);
