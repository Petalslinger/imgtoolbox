/* ============================================================
   pdfwriter.js —— 自研 PDF 写出器，零依赖
   替代 pdf-lib。设计约束（刻意收窄，换取可靠）：

     · 只接受两种输入，正好是 canvas.toBlob() 能产出的东西：
         JPEG          → /DCTDecode，原始字节直接内嵌，不解码不重编码
         8 位非隔行 PNG → /FlateDecode，IDAT 片段原样搬运
       调色板 / 16 位 / 隔行扫描的 PNG 由上层先用 canvas 规范化。
     · 一张图 = 一页，页面尺寸 = 图片像素尺寸，1px = 1pt。

   【最重要的一条】build() 写完一版之后会**自己验一遍**：
     走完整张交叉引用表、核对每个对象偏移、把每个 /FlateDecode 流
     真的解压出来，检查解出的字节数是否等于
        高度 × (1 + 宽度 × 通道数)
     对不上的页会被换成 JPEG 版本重写一版。
   因为「文件能下载但打不开」是最坏的失败模式，宁可在写出时多花
   一点 CPU，也不能把一个坏 PDF 交出去。
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

  /* ── JPEG：扫 marker 找 SOF，拿宽高和分量数 ─────────────── */

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
        // CMYK 的 JPEG 在 PDF 里要按 Adobe 反相约定处理，浏览器不会产出，
        // 直接判为不支持，让上层重新编码，总比写出颜色反了的文件好
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

    // 4=灰度+alpha，6=RGB+alpha：告诉上层「这张需要垫白底」
    var hasAlpha = (ctype === 4 || ctype === 6);

    if (depth !== 8) return { format: 'png', needsFlatten: true, reason: 'bit-depth' };
    if (interlace !== 0) return { format: 'png', needsFlatten: true, reason: 'interlaced' };
    if (ctype === 3) return { format: 'png', needsFlatten: true, reason: 'palette' };

    var cs;
    if (ctype === 0 || ctype === 4) cs = 'DeviceGray';
    else if (ctype === 2 || ctype === 6) cs = 'DeviceRGB';
    else return { format: 'png', needsFlatten: true, reason: 'colortype' };

    // 扫 chunk，把 IDAT 片段收集起来。
    // 顺手把「看到了哪些 chunk」记下来：万一 IDAT 没扫到，
    // 这些诊断信息能让失败信息说清到底发生了什么。
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
      // 返回一个带诊断的「需要重编码」结果，而不是 null。
      // 上层看到这个会走 canvas 重编码，而不是把图丢掉。
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
   * 读图片字节的元信息。
   *   needsFlatten=true 表示这张图不能直接内嵌，得先垫白底重编码。
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

  // 每张图原始扫描线的规定长度，用来验证解压结果
  var CHANNELS = { DeviceGray: 1, DeviceRGB: 3 };

  function PdfWriter() {
    this.pages = [];
    this.meta = {};
  }

  /**
   * 加一页：JPEG 原样内嵌。
   */
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
   * 加一页：8 位无 alpha 的 PNG，IDAT 片段原样搬运。
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
   * 组装完整 PDF 字节流。**异步**：因为要真的把流解压出来验证。
   * @returns {Promise<{blob, bytes, pages, reencoded}>}
   */
  PdfWriter.prototype.build = function () {
    if (!this.pages.length) return Promise.reject(new Error('没有可写入 PDF 的页面。'));

    var self = this;

    // 结构自检：报清楚是哪一页缺什么，而不是在深层循环里炸
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

    /* 拼一版，然后自己验一遍。
       现在是「统一重编码成基线 JPEG」的路线，所以每一页都应该是
       /DCTDecode；validate() 会逐字段走交叉引用表、并把每个图片流
       真的解压出来核对尺寸。验不过就报错，绝不把坏文件交出去——
       「能下载但打不开」是比「明确报错」糟糕得多的结果。 */
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

    /* 二进制标记行，告诉工具这个文件含二进制内容 */
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

      /* 内容流：把图片铺满整页 */
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

    /* 预留的标准字体，方便以后要加页眉页脚 */
    mark(fontId);
    sink.text('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica' +
      ' /Encoding /WinAnsiEncoding >>\n');
    end();

    /* 文档信息 */
    var infoId = reserve();
    mark(infoId);
    sink.text('<< /Producer (' + pdfEscape(this.meta.producer || 'imgtoolbox') + ')' +
      ' /Creator (' + pdfEscape(this.meta.creator || 'imgtoolbox') + ')');
    if (this.meta.title) sink.text(' /Title (' + pdfEscape(this.meta.title) + ')');
    sink.text(' >>\n');
    end();

    /* 文档目录 */
    var catalogId = reserve();
    mark(catalogId);
    sink.text('<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>\n');
    end();

    /* 交叉引用表：每行必须正好 20 字节，偏移量左补零到 10 位 */
    var xrefOffset = sink.size;
    var count = offsets.length;
    var rows = ['xref\n0 ' + count + '\n', '0000000000 65535 f \n'];

    for (i = 1; i < count; i++) {
      rows.push(U.pad(offsets[i] || 0, 10) + ' 00000 n \n');
    }
    sink.text(rows.join(''));

    sink.text('trailer\n<< /Size ' + count +
      ' /Root ' + catalogId + ' 0 R' +
      ' /Info ' + infoId + ' 0 R >>\n' +
      'startxref\n' + xrefOffset + '\n%%EOF\n');

    /* 按声明顺序拼成单个字节数组 */
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
     四、验证：像真正的阅读器那样把 PDF 走一遍
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
   * @returns {Promise<{problems:string[], pages:Array, reassemble:boolean}>}
   */
  function validate(pdf) {
    var problems = [];
    var pages = [];
    var reassemble = false;

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

          if (!/^\d{10} \d{5} [nf]/.test(entry)) {
            problems.push('第 ' + k + ' 条 xref 条目格式不对：' + JSON.stringify(entry));
          }
          if (entry.charAt(18) !== '\n' && entry.charAt(18) !== '\r') {
            reassemble = true;   // 结尾字节不对，重写一次
            problems.push('第 ' + k + ' 条 xref 条目结尾不是换行');
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
    var imgRe = /\/Subtype\s*\/Image/g;
    var im;
    var imgDicts = [];
    while ((im = imgRe.exec(text)) !== null) imgDicts.push(im.index);

    var streamRe = /<<((?:[^<>]|<<[^>]*>>)*)>>\s*stream(\r\n|\r|\n)/g;
    var sm;
    var checks = [];

    while ((sm = streamRe.exec(text)) !== null) {
      var dict = sm[1];
      var dataStart = sm.re.lastIndex;
      var lenM = /\/Length\s+(\d+)/.exec(dict);

      if (!lenM) { problems.push('某个 stream 字典里没有 /Length'); continue; }

      var declared = parseInt(lenM[1], 10);
      var after = dataStart + declared;

      if (after > pdf.length) {
        problems.push('某个 stream 声明 /Length=' + declared + ' 超出文件长度');
        continue;
      }
      if (!/^\s*endstream/.test(text.slice(after, after + 12))) {
        reassemble = true;
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

    /* 6. 逐张验证图片流。
          现在所有图片都是 /DCTDecode（基线 JPEG），所以主要检查两件事：
            · 字节范围在文件内，且确实是完整的 JPEG（SOI 开头、EOI 结尾）
            · /Width /Height /ColorSpace 齐全
          这是我能对 JPEG「解出来的尺寸对不对」做的最强验证。 */
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

      /* FlateDecode（留给以后可能恢复的 PNG 无损内嵌）：
         解压出来长度必须等于 高度 × (1 + 宽度 × 通道数) */
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
        reassemble: reassemble,
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

  /* ============================================================
     五、对外的门面
     build() 是异步的：它要解压验证，所以调用方必须 await。
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
    // 解一段已知的空 deflate 流，纯粹为了把浏览器内置的字典预热好
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
