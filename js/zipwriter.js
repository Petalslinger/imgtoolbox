/* ============================================================
   zipwriter.js —— ZIP 写出器（零依赖，替代 fflate）

   功能范围限于本工具所需的两点：
     · 条目按 store（不压缩）或 deflate 写出
     · 条目名按 UTF-8 编码并置通用标志位 bit 11

   结构依据 PKWARE APPNOTE：每条目一个 Local File Header + 数据，
   末尾为 Central Directory + End of Central Directory。
   ============================================================ */

window.ITB = window.ITB || {};

(function (ITB) {
  'use strict';

  var U = ITB.util;

  /* ── CRC-32（IEEE 802.3，即 ZIP 用的那个） ─────────────── */

  var CRC_TABLE = null;

  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      t[n] = c >>> 0;
    }
    CRC_TABLE = t;
    return t;
  }

  function crc32(bytes) {
    var t = crcTable();
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ── 压缩：优先用浏览器原生 CompressionStream ────────────
     注意前四个字节是 zlib 头（78 01 / 78 9C / 78 DA），
     ZIP 的 deflate 只要裸流，得把它剥掉；末尾 4 字节 adler32 也去掉。
     ──────────────────────────────────────────────────────── */

  function deflateRaw(bytes) {
    if (typeof CompressionStream !== 'function') return Promise.resolve(null);
    try {
      var cs = new CompressionStream('deflate-raw');
      var writer = cs.writable.getWriter();
      // 不 await 写入完成，避免某些实现对背压处理不一致
      writer.write(bytes);
      writer.close();
      return new Response(cs.readable).arrayBuffer().then(function (buf) {
        return new Uint8Array(buf);
      }).catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  // 有 zlib 头的老实现兜底：-- 只在 deflate-raw 不被支持时用
  function deflateRawViaZlib(bytes) {
    if (typeof CompressionStream !== 'function') return Promise.resolve(null);
    try {
      var cs = new CompressionStream('deflate');
      var writer = cs.writable.getWriter();
      writer.write(bytes);
      writer.close();
      return new Response(cs.readable).arrayBuffer().then(function (buf) {
        var u = new Uint8Array(buf);
        if (u.length > 6 && (u[0] & 0x0F) === 8) return u.subarray(2, u.length - 4);
        return u;
      }).catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function compress(bytes) {
    return deflateRaw(bytes).then(function (out) {
      if (out) return out;
      return deflateRawViaZlib(bytes);
    });
  }

  /* ── MS-DOS 时间/日期 ──────────────────────────────────── */

  function dosDateTime(d) {
    d = d || new Date();
    var year = d.getFullYear();
    if (year < 1980) year = 1980;
    var time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
    var date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time: time & 0xFFFF, date: date & 0xFFFF };
  }

  /* ── 写出器 ─────────────────────────────────────────────── */

  function ZipWriter() {
    this.entries = [];     // { nameBytes, data, crc, compSize, method, time, date }
  }

  /**
   * 加一个条目。
   * @param {string} name        条目名，可含 '子目录/文件名' 斜杠
   * @param {Uint8Array|ArrayBuffer} data  原始字节
   * @param {boolean} [compress] 是否尝试 deflate，默认 true
   */
  ZipWriter.prototype.add = function (name, data, compress_) {
    var bytes = (data instanceof Uint8Array) ? data : new Uint8Array(data);
    var wantCompress = compress_ !== false;
    var nameBytes = U.utf8Bytes(name);
    var nameLower = name.toLowerCase();
    var isDir = nameLower.charAt(nameLower.length - 1) === '/';

    var self = this;
    var chain = isDir || !wantCompress || bytes.length < 256
      ? Promise.resolve(null)
      : compress(bytes);

    return chain.then(function (comp) {
      var useComp = !!(comp && comp.length < bytes.length);
      var dt = dosDateTime();
      self.entries.push({
        nameBytes: nameBytes,
        data: useComp ? comp : bytes,
        size: bytes.length,
        crc: crc32(bytes),
        method: useComp ? 8 : 0,
        time: dt.time,
        date: dt.date
      });
    });
  };

  /**
   * 拼出完整的 ZIP Blob。
   * @returns {Blob}
   */
  ZipWriter.prototype.build = function () {
    var parts = [];
    var offset = 0;
    var central = [];
    var i, e;

    for (i = 0; i < this.entries.length; i++) {
      e = this.entries[i];

      var local = new Uint8Array(30 + e.nameBytes.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);        // 本地文件头签名
      lv.setUint16(4, 20, true);                // 需要版本 2.0
      lv.setUint16(6, 0x0800, true);            // 通用标志：bit 11 = 名字是 UTF-8
      lv.setUint16(8, e.method, true);          // 压缩方法
      lv.setUint16(10, e.time, true);
      lv.setUint16(12, e.date, true);
      lv.setUint32(14, e.crc, true);
      lv.setUint32(18, e.data.length, true);    // 压缩后大小
      lv.setUint32(22, e.size, true);           // 原始大小
      lv.setUint16(26, e.nameBytes.length, true);
      lv.setUint16(28, 0, true);                // 扩展字段长度
      local.set(e.nameBytes, 30);

      parts.push(local, e.data);

      central.push({
        nameBytes: e.nameBytes,
        method: e.method,
        time: e.time,
        date: e.date,
        crc: e.crc,
        compSize: e.data.length,
        size: e.size,
        offset: offset
      });
      offset += local.length + e.data.length;
    }

    var cdStart = offset;
    var cdSize = 0;

    for (i = 0; i < central.length; i++) {
      var c = central[i];
      var rec = new Uint8Array(46 + c.nameBytes.length);
      var cv = new DataView(rec.buffer);
      cv.setUint32(0, 0x02014b50, true);        // 中央目录签名
      cv.setUint16(4, 20, true);                // 生成程序版本
      cv.setUint16(6, 20, true);                // 需要版本
      cv.setUint16(8, 0x0800, true);            // 通用标志 bit 11
      cv.setUint16(10, c.method, true);
      cv.setUint16(12, c.time, true);
      cv.setUint16(14, c.date, true);
      cv.setUint32(16, c.crc, true);
      cv.setUint32(20, c.compSize, true);
      cv.setUint32(24, c.size, true);
      cv.setUint16(28, c.nameBytes.length, true);
      cv.setUint16(30, 0, true);                // 扩展字段
      cv.setUint16(32, 0, true);                // 注释
      cv.setUint16(34, 0, true);                // 磁盘号
      cv.setUint16(36, 0, true);                // 内部属性
      cv.setUint32(38, 0, true);                // 外部属性
      cv.setUint32(42, c.offset, true);
      rec.set(c.nameBytes, 46);
      parts.push(rec);
      cdSize += rec.length;
    }

    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);          // 结束记录签名
    ev.setUint16(4, 0, true);                   // 本磁盘号
    ev.setUint16(6, 0, true);                   // 中央目录起始磁盘
    ev.setUint16(8, central.length, true);      // 本磁盘条目数
    ev.setUint16(10, central.length, true);     // 总条目数
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdStart, true);
    ev.setUint16(20, 0, true);                  // 注释长度
    parts.push(eocd);

    return new Blob(parts, { type: 'application/zip' });
  };

  ITB.ZipWriter = ZipWriter;
  ITB.crc32 = crc32;

})(window.ITB);
