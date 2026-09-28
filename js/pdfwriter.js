/* ============================================================
   pdfwriter.js —— PDF 写出器（零依赖，替代 pdf-lib）

   支持的输入仅两种，与 canvas.toBlob() 的输出对应：
     JPEG           → /DCTDecode，原始字节直接内嵌，不解码不重编码
     8 位非隔行 PNG → /FlateDecode，IDAT 片段原样搬运
   调色板 / 16 位 / 隔行扫描的 PNG 由上层先用 canvas 规范化。

   一图一页，页面尺寸 = 图片像素尺寸（1px = 1pt）。

   build() 在拼装后执行结构自检：解析交叉引用表、核对对象偏移、
   确认每个流在 /Length 声明位置后紧跟 endstream、核对内嵌图完整性
   （JPEG 校验 SOI/EOI）。自检不通过则抛错，不产出文件。
   ============================================================ */

window.ITB = window.ITB || {};

(function (ITB) {
  'use strict';

  var U = ITB.util;

  /* ============================================================
     一、字节读取
     ============================================================ */

  function isPng(bytes) {
    return bytes.length > 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 &&
      bytes[2] === 0x4E && bytes[3] === 0x47;
  }

  function isJpeg(bytes) {
    return bytes.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8;
  }

  function peek(bytes) {
    if (isPng(bytes)) return 'png';
    if (isJpeg(bytes)) return 'jpeg';
    return null;
  }

  /* ── JPEG：遍历 marker 定位 SOF，读取宽高与分量数 ───────── */

  function parseJpeg(bytes) {
    var i = 2;
    var len = bytes.length;

    while (i + 3 < len) {
      if (bytes[i] !== 0xFF) { i++; continue; }

      var marker = bytes[i + 1];
      if (marker === 0xFF) { i++; continue; }                 // 填充
      if (marker === 0x00) { i += 2; continue; }              // 转义
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) { i += 2; continue; }

      var segLen = (bytes[i + 2] << 8) | bytes[i + 3];
      if (segLen < 2 || i + 2 + segLen > len) return null;

      // SOF0–SOF15，排除 DHT(C4) / JPG(C8) / DAC(CC)
      var isSOF = marker >= 0xC0 && marker <= 0xCF &&
                  marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;

      if (isSOF) {
        if (i + 9 >= len) return null;
        var height = (bytes[i + 5] << 8) | bytes[i + 6];
        var width  = (bytes[i + 7] << 8) | bytes[i + 8];
        var ncomp  = bytes[i + 9];
        if (!width || !height) return null;

        var cs;
        if (ncomp === 1) cs = 'DeviceGray';
        else if (ncomp === 3) cs = 'DeviceRGB';
        /* 4 分量 JPEG 按 Adobe 反相约定解释，canvas 不会产出该格式。
           判为不支持并交由上层重新编码，避免写出色彩反转的文件。 */
        else return null;

        return { format: 'jpeg', width: width, height: height, colorspace: cs };
      }

      i += 2 + segLen;
    }
    return null;
  }

  /* ── PNG：校验 IHDR + 拆出 IDAT ─────────────────────────── */

  function parsePng(bytes) {
    if (bytes.length < 33) return null;

    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var width   = view.getUint32(16);
    var height  = view.getUint32(20);
    var depth   = bytes[24];
    var ctype   = bytes[25];
    var interlace = bytes[28];

    if (!width || !height) return null;

    // 4=灰度+alpha；6=RGB+alpha
    var hasAlpha = (ctype === 4 || ctype === 6);

    if (depth !== 8) return { format: 'png', needsFlatten: true, reason: 'bit-depth' };
    if (interlace !== 0) return { format: 'png', needsFlatten: true, reason: 'interlaced' };
    if (ctype === 3) return { format: 'png', needsFlatten: true, reason: 'palette' };

    var cs;
    if (ctype === 0 || ctype === 4) cs = 'DeviceGray';
    else if (ctype === 2 || ctype === 6) cs = 'DeviceRGB';
    else return { format: 'png', needsFlatten: true, reason: 'colortype' };

    /* 遍历 chunk 收集 IDAT 片段，同时记录已见 chunk 列表：
       IDAT 缺失时，这些信息用于定位原因。 */
    var off = 8;
    var idats = [];
    var idatLength = 0;
    var seen = [];
    var sawIend = false;
    var truncated = false;

    while (off + 8 <= bytes.length) {
      var clen = view.getUint32(off);
      var kind = U.bytesToAscii(bytes, off + 4, off + 8);
      var dataStart = off + 8;

      if (seen.length < 12) seen.push(kind + ':' + clen);

      if (dataStart + clen + 4 > bytes.length) { truncated = true; break; }

      if (kind === 'IDAT') {
        idats.push(bytes.subarray(dataStart, dataStart + clen));
        idatLength += clen;
      } else if (kind === 'IEND') {
        sawIend = true;
        break;
      }

      off = dataStart + clen + 4;
    }

    if (!idats.length) {
      // 返回带诊断信息的「需要重编码」结果而非 null：上层据此走 canvas 重编码，
      // 而不是丢弃该图。
      return {
        format: 'png',
        needsFlatten: true,
        reason: 'no-idat(' +
          'bytes=' + bytes.length +
          ',depth=' + depth +
          ',ctype=' + ctype +
          ',interlace=' + interlace +
          ',truncated=' + truncated +
          ',iend=' + sawIend +
          ',chunks=' + (seen.join(',') || '无') + ')'
      };
    }

    return {
      format: 'png',
      width: width,
      height: height,
      colorspace: cs,
      hasAlpha: hasAlpha,
      needsFlatten: hasAlpha,
      reason: hasAlpha ? 'alpha' : null,
      idat: idats,
      idatLength: idatLength
    };
  }

  /**
   * 读取图片字节的元信息。
   * needsFlatten=true 表示该图不可直接内嵌，须先填充白底后重编码。
   */
  function parseImage(bytes) {
    if (isPng(bytes)) return parsePng(bytes);
    if (isJpeg(bytes)) return parseJpeg(bytes);
    return null;
  }

  /* ============================================================
     二、字节累加器
     ============================================================ */

  function ByteSink() {
    this.parts = [];
    this.size = 0;
  }

  ByteSink.prototype.push = function (u8) {
    if (!u8 || !u8.length) return;
    this.parts.push(u8);
    this.size += u8.length;
  };

  ByteSink.prototype.text = function (s) {
    this.push(U.latin1Bytes(s));
  };

  ByteSink.prototype.blob = function () {
    return new Blob(this.parts, { type: 'application/pdf' });
  };

  /* ============================================================
     三、写出器
     ============================================================ */

  // 各色彩空间的通道数，用于校验 Flate 流解压后的扫描线长度
  var CHANNELS = { DeviceGray: 1, DeviceRGB: 3 };

  function PdfWriter() {
    this.pages = [];
    this.meta = {};
  }

  /** 追加一页：JPEG 原样内嵌 */
  PdfWriter.prototype.addJpegPage = function (bytes, width, height, colorspace, title) {
    this.pages.push({
      format: 'jpeg',
      width: width,
      height: height,
      colorspace: colorspace || 'DeviceRGB',
      data: bytes,
      dataLength: bytes.length,
      title: title || ''
    });
  };

  /**
   * 追加一页：8 位无 alpha 的 PNG，IDAT 片段原样搬运。
   * @param {object} info parseImage() 的返回值
   */
  PdfWriter.prototype.addPngPage = function (info) {
    this.pages.push(info);
  };

  PdfWriter.prototype.setMeta = function (meta) {
    this.meta = meta || {};
    return this;
  };

  /**
   * 组装完整 PDF 字节流。返回 Promise，因为需要解压流进行校验。
   * @returns {Promise<{blob, bytes, pages, reencoded}>}
   */
  PdfWriter.prototype.build = function () {
    if (!this.pages.length) return Promise.reject(new Error('没有可写入 PDF 的页面。'));

    var self = this;

    // 逐页检查必需字段，错误信息指明具体页码与缺失项
    for (var v = 0; v < this.pages.length; v++) {
      var page = this.pages[v];
      var who = '第 ' + (v + 1) + ' 页' + (page && page.title ? '（' + page.title + '）' : '');

      if (!page) return Promise.reject(new Error(who + '：页面对象是空的。'));
      if (!page.width || !page.height) return Promise.reject(new Error(who + '：宽高缺失。'));
      if (!page.colorspace) return Promise.reject(new Error(who + '：色彩空间缺失。'));

      if (page.format === 'jpeg') {
        if (!page.data || typeof page.dataLength !== 'number') {
          return Promise.reject(new Error(who + '：JPEG 数据不完整。'));
        }
      } else if (page.format === 'png') {
        if (!page.idat || typeof page.idatLength !== 'number' || !page.idatLength) {
          return Promise.reject(new Error(who + '：PNG 的 IDAT 片段缺失，无法内嵌。'));
        }
      } else {
        return Promise.reject(new Error(who + '：未知的图片编码「' + page.format + '」。'));
      }
    }

    /* 拼装后执行自检。当前流水线统一重编码为基线 JPEG，因此每页均为
       /DCTDecode：validate() 解析交叉引用表、核对对象偏移，并校验流完整性
       与 JPEG 头尾。任一项不通过即抛错，不产出文件。 */
    var bytes = this._assemble();

    return validate(bytes).then(function (rep) {
      if (rep.problems.length) {
        throw new Error('PDF 结构自检失败，已放弃生成：' + rep.problems.slice(0, 3).join('；'));
      }

      var fails = describeFails(rep);
      if (fails.length) {
        throw new Error('PDF 自检发现 ' + fails.length + ' 页有问题，已放弃生成：' +
          fails.slice(0, 3).join('；'));
      }

      if (rep.okPages !== self.pages.length) {
        throw new Error('PDF 自检只通过了 ' + rep.okPages + ' / ' +
          self.pages.length + ' 张图片，已放弃生成。');
      }

      return {
        blob: new Blob([bytes], { type: 'application/pdf' }),
        bytes: bytes.length,
        pages: self.pages.length,
        reencoded: 0
      };
    });
  };

  function describeFails(report) {
    var out = [];
    for (var i = 0; i < report.pages.length; i++) {
      var p = report.pages[i];
      if (p.fail) out.push('第 ' + p.index + ' 页：' + p.fail);
    }
    return out;
  }

  /* ── 拼字节（不含任何验证） ─────────────────────────────── */

  PdfWriter.prototype._assemble = function () {
    var sink = new ByteSink();
    var offsets = [0];                 // 对象号 → 字节偏移，0 号恒为空闲对象
    var next = 1;
    var kids = [];
    var i;

    function reserve() { return next++; }

    function mark(id) {
      while (offsets.length <= id) offsets.push(0);
      offsets[id] = sink.size;
      sink.text(id + ' 0 obj\n');
    }

    function end() { sink.text('endobj\n'); }

    /* 文件头：%PDF-<版本> 必须位于文件起始 5 个字节。
       紧随其后的二进制标记行是可选的，用于提示传输工具按二进制处理。 */
    sink.text('%PDF-1.4\n');
    sink.push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

    var pagesId = reserve();
    var fontId = reserve();

    for (i = 0; i < this.pages.length; i++) {
      var pg = this.pages[i];
      var w = pg.width;
      var h = pg.height;
      var usePg = pg;

      var contentId = reserve();
      var imgId = reserve();
      var pageId = reserve();

      // 内容流：将图片缩放到整页
      var contentBytes = U.latin1Bytes('q\n' + w + ' 0 0 ' + h + ' 0 0 cm\n/Im0 Do\nQ\n');

      mark(contentId);
      sink.text('<< /Length ' + contentBytes.length + ' >>\nstream\n');
      sink.push(contentBytes);
      sink.text('endstream\n');
      end();

      /* 图片 XObject */
      mark(imgId);
      sink.text('<< /Type /XObject /Subtype /Image' +
        ' /Width ' + usePg.width + ' /Height ' + usePg.height +
        ' /ColorSpace /' + usePg.colorspace +
        ' /BitsPerComponent 8' +
        ' /Filter ' + (usePg.format === 'jpeg' ? '/DCTDecode' : '/FlateDecode') +
        ' /Length ' + (usePg.format === 'jpeg' ? usePg.dataLength : usePg.idatLength) +
        ' >>\nstream\n');

      if (usePg.format === 'jpeg') {
        sink.push(usePg.data);
      } else {
        for (var k = 0; k < usePg.idat.length; k++) sink.push(usePg.idat[k]);
      }

      sink.text('\nendstream\n');
      end();

      /* 页面对象 */
      mark(pageId);
      sink.text('<< /Type /Page /Parent ' + pagesId + ' 0 R' +
        ' /MediaBox [0 0 ' + w + ' ' + h + ']' +
        ' /Resources << /XObject << /Im0 ' + imgId + ' 0 R >>' +
        ' /ProcSet [/PDF /ImageB /ImageC /ImageI] >>' +
        ' /Contents ' + contentId + ' 0 R >>\n');
      end();

      kids.push(pageId + ' 0 R');
    }

    /* 页面树 */
    mark(pagesId);
    sink.text('<< /Type /Pages /Count ' + this.pages.length +
      ' /Kids [' + kids.join(' ') + '] >>\n');
    end();

    /* 标准字体对象。当前内容不引用它，保留供后续添加文字内容使用；
       删除需同步调整对象编号与 xref。 */
    mark(fontId);
    sink.text('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica' +
      ' /Encoding /WinAnsiEncoding >>\n');
    end();

    /* 文档信息。含非 ASCII 的字段按 UTF-16BE 十六进制串写出 */
    var infoId = reserve();
    mark(infoId);
    sink.text('<< /Producer ' + pdfText(this.meta.producer || 'imgtoolbox') +
      ' /Creator ' + pdfText(this.meta.creator || 'imgtoolbox'));
    if (this.meta.title) sink.text(' /Title ' + pdfText(this.meta.title));
    sink.text(' >>\n');
    end();

    /* 文档目录 */
    var catalogId = reserve();
    mark(catalogId);
    sink.text('<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>\n');
    end();

    /* 交叉引用表：每条 20 字节（10 位偏移 + 空格 + 5 位世代号 + 空格 +
       1 位类型 + 2 字节 EOL）。行尾必须是 \r\n，否则每条会短 1 字节，
       按固定 20 字节步进解析的阅读器将从此错位。 */
    var xrefOffset = sink.size;
    var count = offsets.length;
    var rows = ['xref\n0 ' + count + '\n', '0000000000 65535 f\r\n'];

    for (i = 1; i < count; i++) {
      rows.push(U.pad(offsets[i] || 0, 10) + ' 00000 n\r\n');
    }
    sink.text(rows.join(''));

    sink.text('trailer\n<< /Size ' + count +
      ' /Root ' + catalogId + ' 0 R' +
      ' /Info ' + infoId + ' 0 R >>\n' +
      'startxref\n' + xrefOffset + '\n%%EOF\n');

    // 按写入顺序拼成单个字节数组
    var total = sink.size;
    var out = new Uint8Array(total);
    var at = 0;
    for (i = 0; i < sink.parts.length; i++) {
      out.set(sink.parts[i], at);
      at += sink.parts[i].length;
    }
    return out;
  };

  /* ============================================================
     四、验证：按解析顺序完整遍历 PDF
     ============================================================ */

  function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') return Promise.resolve(null);
    try {
      var ds = new DecompressionStream('deflate-raw');
      var writer = ds.writable.getWriter();
      writer.write(bytes);
      writer.close();
      return new Response(ds.readable).arrayBuffer()
        .then(function (buf) { return new Uint8Array(buf); })
        .catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  /**
   * 校验已经拼好的 PDF 字节。
   * @returns {Promise<{problems:string[], pages:Array}>}
   */
  function validate(pdf) {
    var problems = [];
    var pages = [];

    var i;
    var text = '';
    for (i = 0; i < pdf.length; i++) text += String.fromCharCode(pdf[i]);

    /* 1. 头尾 */
    if (text.slice(0, 5) !== '%PDF-') problems.push('缺少 %PDF- 文件头');
    var eofAt = text.lastIndexOf('%%EOF');
    if (eofAt < 0) problems.push('缺少 %%EOF');

    /* 2. 非法字面量：一旦写进 PDF，阅读器直接打不开 */
    var badLit = /\/(Length|Width|Height|Size|Count|BitsPerComponent)\s+(undefined|NaN|null)\b/g;
    var bl;
    while ((bl = badLit.exec(text)) !== null) {
      problems.push('出现非法值 ' + JSON.stringify(bl[0]));
    }

    /* 3. startxref 必须精确指向 xref */
    var sxAt = text.lastIndexOf('startxref');
    var xrefOffset = -1;
    var objCount = 0;

    if (sxAt < 0) {
      problems.push('缺少 startxref');
    } else {
      var m = /startxref\s+(\d+)/.exec(text.slice(sxAt));
      xrefOffset = m ? parseInt(m[1], 10) : -1;
      if (text.substr(xrefOffset, 4) !== 'xref') {
        problems.push('startxref 指向的 ' + xrefOffset + ' 处不是 xref');
        xrefOffset = -1;
      }
    }

    /* 4. 逐字段解析 xref，核对每个对象偏移 */
    if (xrefOffset >= 0) {
      var p = xrefOffset + 4;
      while (text[p] === '\r' || text[p] === '\n' || text[p] === ' ') p++;

      var sub = /^(\d+)\s+(\d+)/.exec(text.slice(p));
      if (!sub) {
        problems.push('xref 子段头解析失败');
      } else {
        var firstObj = parseInt(sub[1], 10);
        objCount = parseInt(sub[2], 10);
        p += sub[0].length;
        if (text[p] === '\r') p++;
        if (text[p] === '\n') p++;

        for (var k = 0; k < objCount; k++) {
          var entry = text.substr(p, 20);
          if (entry.length < 20) { problems.push('第 ' + k + ' 条 xref 条目不足 20 字节'); break; }

          /* 20 字节一条：10 位偏移 + 空格 + 5 位世代号 + 空格 + 1 位类型 + \r\n
             —— 所以类型在 [17]，行尾两字节在 [18][19]。 */
          if (!/^\d{10} \d{5} [nf]\r\n$/.test(entry)) {
            problems.push('第 ' + k + ' 条 xref 条目格式不对：' + JSON.stringify(entry));
          }

          var id = firstObj + k;
          if (id > 0) {
            var off = parseInt(entry.slice(0, 10), 10);
            var expect = id + ' 0 obj';
            if (text.substr(off, expect.length) !== expect) {
              problems.push('对象 ' + id + ' 的偏移 ' + off + ' 处不是 "' + expect + '"');
            }
          }
          p += 20;
        }
      }
    }

    /* 5. 每个 stream：用 /Length 定位数据，再逐个验证 */
    var streamRe = /<<((?:[^<>]|<<[^>]*>>)*)>>\s*stream(\r\n|\r|\n)/g;
    var sm;
    var checks = [];

    while ((sm = streamRe.exec(text)) !== null) {
      var dict = sm[1];
      // 流数据从「字典 + stream + 换行」之后开始。
      // 必须读 streamRe.lastIndex，而不是匹配结果上的属性——匹配数组没有 lastIndex。
      var dataStart = streamRe.lastIndex;
      var lenM = /\/Length\s+(\d+)/.exec(dict);

      if (!lenM) { problems.push('某个 stream 字典里没有 /Length'); continue; }

      var declared = parseInt(lenM[1], 10);
      var after = dataStart + declared;

      if (after > pdf.length) {
        problems.push('某个 stream 声明 /Length=' + declared + ' 超出文件长度');
        continue;
      }
      if (!/^\s*endstream/.test(text.slice(after, after + 12))) {
        problems.push('某个 stream 在 /Length 指定位置之后不是 endstream');
      }

      var wm = /\/Width\s+(\d+)/.exec(dict);
      var hm = /\/Height\s+(\d+)/.exec(dict);
      var cm = /\/ColorSpace\s+\/(\w+)/.exec(dict);
      var isFlate = /\/Filter\s*\/FlateDecode/.test(dict);
      var isDct = /\/Filter\s*\/DCTDecode/.test(dict);
      var isImage = /\/Subtype\s*\/Image/.test(dict);

      checks.push({
        dict: dict,
        dataStart: dataStart,
        length: declared,
        width: wm ? parseInt(wm[1], 10) : 0,
        height: hm ? parseInt(hm[1], 10) : 0,
        colorspace: cm ? cm[1] : null,
        isFlate: isFlate,
        isDct: isDct,
        isImage: isImage
      });
    }

    /* 6. 逐张校验图片流。当前流水线全部产出 /DCTDecode，检查项为：
             · /Width /Height /ColorSpace 齐全
             · 字节范围位于文件内
             · JPEG 完整（以 SOI 开头、EOI 结尾）
           JPEG 内部像素无法在不解码的前提下进一步验证。 */
    var imageChecks = checks.filter(function (c) { return c.isImage; });
    var pageFails = [];
    var okPages = 0;

    function checkOne(c, i) {
      var label = '第 ' + (i + 1) + ' 张图';

      if (!c.width || !c.height) {
        pageFails.push({ index: i + 1, fail: label + '：缺少宽高' });
        return;
      }
      if (!c.colorspace || !CHANNELS[c.colorspace]) {
        pageFails.push({ index: i + 1, fail: label + '：色彩空间是 ' + c.colorspace });
        return;
      }
      if (!c.isDct && !c.isFlate) {
        pageFails.push({ index: i + 1, fail: label + '：图片流既不是 DCTDecode 也不是 FlateDecode' });
        return;
      }

      if (c.length < 4) {
        pageFails.push({ index: i + 1, fail: label + '：流只有 ' + c.length + ' 字节' });
        return;
      }

      if (c.isDct) {
        // 完整的 JPEG 必须以 SOI(FFD8) 开头、以 EOI(FFD9) 结尾
        var s0 = pdf[c.dataStart];
        var s1 = pdf[c.dataStart + 1];
        var e1 = pdf[c.dataStart + c.length - 1];
        var e0 = pdf[c.dataStart + c.length - 2];

        if (s0 !== 0xFF || s1 !== 0xD8) {
          pageFails.push({
            index: i + 1,
            fail: label + '：不是 JPEG 开头（' + hex2(s0) + ' ' + hex2(s1) + '，应为 ff d8）'
          });
          return;
        }
        if (e0 !== 0xFF || e1 !== 0xD9) {
          pageFails.push({
            index: i + 1,
            fail: label + '：不是 JPEG 结尾（' + hex2(e0) + ' ' + hex2(e1) + '，应为 ff d9）,' +
                  '说明流被截断了'
          });
          return;
        }
        okPages++;
        return;
      }

      /* FlateDecode 分支（保留给后续可能恢复的 PNG 无损内嵌）：
         解压后长度须等于 高度 × (1 + 宽度 × 通道数) */
      var ch = CHANNELS[c.colorspace];
      var expected = c.height * (1 + c.width * ch);
      var raw = pdf.subarray(c.dataStart, c.dataStart + c.length);

      return inflateRaw(raw).then(function (out) {
        if (!out) {
          pageFails.push({ index: i + 1, fail: label + '：FlateDecode 流解不开' });
          return;
        }
        if (out.length !== expected) {
          pageFails.push({
            index: i + 1,
            fail: label + '：解压后 ' + out.length + ' 字节，按 ' +
                  c.width + '×' + c.height + ' ' + c.colorspace +
                  ' 应为 ' + expected + ' 字节'
          });
          return;
        }
        okPages++;
      });
    }

    function runChecks(i) {
      if (i >= imageChecks.length) return Promise.resolve();
      return Promise.resolve(checkOne(imageChecks[i], i)).then(function () {
        return runChecks(i + 1);
      });
    }

    return runChecks(0).then(function () {
      for (var q = 0; q < pageFails.length; q++) pages.push(pageFails[q]);
      return {
        problems: problems,
        pages: pages,
        okPages: okPages,
        imageCount: imageChecks.length,
        streams: checks.length
      };
    });
  }

  function hex2(b) {
    if (b === undefined) return '??';
    return ('0' + b.toString(16)).slice(-2);
  }

  function pdfEscape(s) {
    return String(s)
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      .replace(/[\r\n]+/g, ' ');
  }

  /**
   * 生成 PDF 字符串对象（字面量或十六进制），用于 /Title 等元数据。
   *
   * 纯 ASCII 写为字面量；含非 ASCII 时写为带 BOM（FEFF）的 UTF-16BE
   * 十六进制串，这是 PDF 表示 Unicode 文本的标准形式。
   * 不可直接写字面量：ByteSink.text 经 latin1Bytes 处理，码位 ≥256 会被
   * 替换为 '?'，导致中文标题丢失。
   */
  function pdfText(s) {
    s = String(s);
    if (/^[\x20-\x7e]*$/.test(s)) return '(' + pdfEscape(s) + ')';

    var hex = 'FEFF';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      // 代理对成对处理，保证非 BMP 字符正确往返
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        var d = s.charCodeAt(i + 1);
        if (d >= 0xDC00 && d <= 0xDFFF) {
          var cp = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00);
          hex += ('0000' + (0xD800 + ((cp - 0x10000) >> 10)).toString(16)).slice(-4).toUpperCase();
          hex += ('0000' + (0xDC00 + ((cp - 0x10000) & 0x3FF)).toString(16)).slice(-4).toUpperCase();
          i++;
          continue;
        }
      }
      hex += ('0000' + c.toString(16)).slice(-4).toUpperCase();
    }
    return '<' + hex + '>';
  }

  /* ============================================================
     五、对外接口
     build() 返回 Promise，调用方必须 await。
     ============================================================ */

  var loaded = null;

  function load() {
    if (loaded) return loaded;
    if (typeof DecompressionStream !== 'function') {
      loaded = Promise.reject(new Error(
        '当前浏览器不支持 DecompressionStream，导出 PDF 需要较新的 Chrome / Edge / Firefox / Safari。'));
      loaded.catch(function () {});
      return loaded;
    }
    // 解压一段已知的空 deflate 流，验证实现可用
    var probe = new Uint8Array([0x03, 0x00]);
    try {
      var ds = new DecompressionStream('deflate-raw');
      var writer = ds.writable.getWriter();
      writer.write(probe);
      writer.close();
      loaded = new Response(ds.readable).arrayBuffer()
        .then(function () { return true; });
    } catch (e) {
      loaded = Promise.reject(e);
      loaded.catch(function () {});
    }
    return loaded;
  }

  ITB.pdf = {
    load: load,
    peek: peek,
    parseImage: parseImage,
    PdfWriter: PdfWriter,
    validate: validate,
    inflateRaw: inflateRaw
  };

})(window.ITB);
