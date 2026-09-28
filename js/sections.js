/* ============================================================
   sections.js —— 四个相互独立的功能分区

   不使用「操作队列」模型：每个分区各自持有一份参数、一个执行按钮，
   走一条独立的执行路径。分区之间唯一的共享对象是文件池，
   它仅表示「处理哪些图片」，不具备流水线语义。

   四个分区：
     shell   批量重命名   → 仅改文件名，输出 ZIP
     resize  改分辨率     → 仅改尺寸，输出 ZIP
     format  转格式       → 仅换编码，输出 ZIP
     pdf     导出 PDF     → 合并为一份 PDF
   ============================================================ */

window.ITB = window.ITB || {};

(function (ITB) {
  'use strict';

  var U = ITB.util;

  /* ============================================================
     一、批量重命名
     ============================================================ */

  var shell = {
    id: 'shell',
    els: {},

    params: function () {
      var e = shell.els;
      return {
        replaceOn: e.replaceOn.checked,
        find: e.find.value,
        replaceWith: e.replace.value,
        useRegex: e.regex.checked,
        caseSensitive: e.caseCase.checked,

        prefixOn: e.prefixOn.checked,
        prefix: e.prefix.value,

        numberOn: e.numberOn.checked,
        startAt: parseInt(e.start.value, 10) || 0,
        stepBy: parseInt(e.step.value, 10) || 1,
        padTo: parseInt(e.pad.value, 10) || 3,
        numberOrder: e.order.value,
        numberPos: e.pos.value,
        numberSep: e.sep.value
      };
    },

    init: function (onChange) {
      var e = shell.els = {
        replaceOn: U.$('rn-replace-on'),
        find: U.$('rn-find'),
        replace: U.$('rn-replace'),
        regex: U.$('rn-regex'),
        caseCase: U.$('rn-case'),
        prefixOn: U.$('rn-prefix-on'),
        prefix: U.$('rn-prefix'),
        numberOn: U.$('rn-number-on'),
        start: U.$('rn-start'),
        step: U.$('rn-step'),
        pad: U.$('rn-pad'),
        sep: U.$('rn-sep'),
        pos: U.$('rn-pos'),
        order: U.$('rn-order'),

        numberPreview: U.$('rn-number-preview'),
        summary: U.$('rn-summary'),
        preview: U.$('rn-preview'),
        status: U.$('rn-status'),
        run: U.$('rn-run')
      };

      var inputs = document.querySelectorAll(
        '#rn-replace-on, #rn-find, #rn-replace, #rn-regex, #rn-case, ' +
        '#rn-prefix-on, #rn-prefix, #rn-number-on, #rn-start, #rn-step, ' +
        '#rn-pad, #rn-sep, #rn-pos, #rn-order');
      for (var i = 0; i < inputs.length; i++) {
        inputs[i].addEventListener('input', onChange);
        inputs[i].addEventListener('change', onChange);
      }

      // 执行按钮由 app.js 统一绑定（需接入进度、取消与结果提示），
      // 此处不再重复绑定，否则一次点击会触发两次下载
    },

    /** 计算每个选中文件的最终文件名 */
    plan: function () {
      var selected = ITB.selectedFiles();
      var p = shell.params();
      var bases = selected.map(function (f) { return U.splitExt(f.name).base; });
      var newBases = ITB.rename.mapNames(bases, p);

      var out = [];
      for (var i = 0; i < selected.length; i++) {
        var f = selected[i];
        var ext = U.splitExt(f.name).ext;
        var finalName = U.joinName(newBases[i], ext);
        out.push({
          file: f,
          originalName: f.name,
          finalName: finalName,
          changed: finalName !== f.name
        });
      }
      return out;
    },

    refresh: function () {
      var e = shell.els;
      var selected = ITB.selectedFiles();
      var anyRule = e.replaceOn.checked || e.prefixOn.checked || e.numberOn.checked;

      // 编号示意
      if (e.numberOn.checked) {
        var w = Math.max(1, Math.min(12, parseInt(e.pad.value, 10) || 3));
        var start = parseInt(e.start.value, 10) || 0;
        var step = parseInt(e.step.value, 10) || 1;
        var sep = e.sep.value || '';
        var a = U.pad(start, w);
        var b = U.pad(start + step, w);
        e.numberPreview.textContent = '编号长这样：' +
          (e.pos.value === 'prefix' ? sep + a + '、' + sep + b : a + sep + '、' + b + sep);
      } else {
        e.numberPreview.textContent = '勾选后才能填编号参数。';
      }

      var plan = shell.plan();
      var dup = ITB.rename.findDuplicates(plan.map(function (n) { return n.finalName; }));
      var changed = plan.filter(function (n) { return n.changed; });

      /* 预览列表 */
      U.clear(e.preview);
      if (!selected.length) {
        e.summary.textContent = '先勾选要处理的图片。';
      } else if (!anyRule) {
        e.summary.textContent = '还没有启用任何规则，文件名不会改变（ZIP 里还是原名）。';
      } else {
        e.summary.textContent = '共 ' + selected.length + ' 张，其中 ' +
          changed.length + ' 个文件名会变。' +
          (dup.ok ? '' : ' ⚠ 有重名，见下方红字。');
      }

      var shown = changed.length ? changed : plan.slice(0, 0);
      if (shown.length) {
        var table = U.el('div', { cls: 'rename-rows', parent: e.preview });
        var limit = Math.min(shown.length, 300);
        for (var i = 0; i < limit; i++) {
          var row = U.el('div', { cls: 'rename-row', parent: table });
          U.el('span', { cls: 'rename-idx', text: String(i + 1), parent: row });
          U.el('span', { cls: 'rename-old', text: shown[i].originalName, parent: row });
          U.el('span', { cls: 'rename-arrow', text: '→', parent: row });
          U.el('span', { cls: 'rename-new', text: shown[i].finalName, parent: row });
        }
        if (shown.length > limit) {
          U.el('p', { cls: 'sec-hint', text: '⋯ 还有 ' + (shown.length - limit) + ' 个同样会改名', parent: e.preview });
        }
      } else if (selected.length) {
        U.el('p', { cls: 'sec-hint', text: '所有文件名都保持不变。', parent: e.preview });
      }

      /* 重名 */
      if (!dup.ok && selected.length) {
        var box = U.el('div', { cls: 'inline-alert', parent: e.preview });
        U.el('strong', { text: '有 ' + dup.dups.length + ' 个名字会重复：', parent: box });
        var ul = U.el('ul', { parent: box });
        for (var k = 0; k < Math.min(6, dup.dups.length); k++) {
          U.el('li', { text: dup.dups[k], parent: ul });
        }
        if (dup.dups.length > 6) U.el('li', { text: '⋯', parent: ul });
        U.el('p', { cls: 'sec-hint', text: 'ZIP 里同名条目会互相顶掉，改一下规则再执行。', parent: box });
      }

      /* 状态与按钮 */
      var ok = selected.length > 0 && dup.ok;
      e.run.disabled = ITB.state.busy || !ok;

      if (!selected.length) {
        e.status.textContent = '先勾选要处理的图片。';
      } else if (!dup.ok) {
        e.status.textContent = '有重名，无法执行。';
        e.status.className = 'run-status is-danger';
      } else if (!anyRule) {
        e.status.textContent = '规则都没启用，导出后文件名和原来一样。';
        e.status.className = 'run-status is-warn';
      } else {
        e.status.textContent = '将给 ' + changed.length + ' 张图改名，打包为 ZIP。';
        e.status.className = 'run-status';
      }

      return plan;
    }
  };

  /* ============================================================
     二、改分辨率
     ============================================================ */

  var RESIZE_PRESETS = [
    { mode: 'width', v: 1920, t: '1920' },
    { mode: 'width', v: 1280, t: '1280' },
    { mode: 'width', v: 1080, t: '1080' },
    { mode: 'width', v: 800, t: '800' },
    { mode: 'width', v: 640, t: '640' },
    { mode: 'percent', v: 50, t: '50%' },
    { mode: 'percent', v: 25, t: '25%' }
  ];

  var resize = {
    id: 'resize',
    els: {},

    mode: function () {
      var list = document.querySelectorAll('input[name="rs-mode"]');
      for (var i = 0; i < list.length; i++) {
        if (list[i].checked) return list[i].value;
      }
      return 'width';
    },

    params: function () {
      var e = resize.els;
      var mode = resize.mode();
      var value = parseFloat(e.value.value);
      if (!isFinite(value) || value <= 0) value = (mode === 'percent') ? 100 : 1920;

      return {
        mode: mode,
        width: mode === 'width' ? value : 0,
        height: mode === 'height' ? value : 0,
        percent: mode === 'percent' ? value : 0,
        allowUpscale: e.upscale.checked
      };
    },

    init: function (onChange) {
      var e = resize.els = {
        value: U.$('rs-value'),
        unit: U.$('rs-unit'),
        presets: U.$('rs-presets'),
        hint: U.$('rs-hint'),
        upscale: U.$('rs-upscale'),
        status: U.$('rs-status'),
        run: U.$('rs-run')
      };

      var radios = document.querySelectorAll('input[name="rs-mode"]');
      for (var i = 0; i < radios.length; i++) {
        radios[i].addEventListener('change', function () {
          // 切换模式时填入合理的默认值
          if (resize.mode() === 'percent' && parseFloat(e.value.value) > 400) {
            e.value.value = '50';
          } else if (resize.mode() !== 'percent' && parseFloat(e.value.value) <= 100) {
            e.value.value = '1920';
          }
          onChange();
        });
      }

      e.value.addEventListener('input', onChange);
      e.upscale.addEventListener('change', onChange);

      /* 预设按钮 */
      RESIZE_PRESETS.forEach(function (p) {
        var chip = U.el('button', {
          cls: 'chip',
          text: p.t,
          attrs: { type: 'button', 'data-mode': p.mode, 'data-value': p.v },
          parent: e.presets
        });
        chip.addEventListener('click', function () {
          var list = document.querySelectorAll('input[name="rs-mode"]');
          for (var i = 0; i < list.length; i++) list[i].checked = (list[i].value === p.mode);
          e.value.value = String(p.v);
          onChange();
        });
      });

      // 执行按钮由 app.js 统一绑定
    },

    refresh: function () {
      var e = resize.els;
      var selected = ITB.selectedFiles();
      var mode = resize.mode();
      var p = resize.params();

      e.unit.textContent = (mode === 'percent') ? '%' : 'px';

      // 高亮当前预设
      var chips = e.presets.querySelectorAll('.chip');
      for (var i = 0; i < chips.length; i++) {
        var on = chips[i].getAttribute('data-mode') === mode &&
                 parseFloat(chips[i].getAttribute('data-value')) ===
                 (mode === 'percent' ? p.percent : (mode === 'height' ? p.height : p.width));
        chips[i].classList.toggle('is-on', on);
      }

      var sample = ITB.sampleFile();

      if (!selected.length) {
        e.hint.textContent = '先勾选要处理的图片。';
        e.status.textContent = '先勾选要处理的图片。';
        e.status.className = 'run-status';
        e.run.disabled = true;
        return;
      }

      if (!sample || !sample.measured) {
        e.hint.textContent = '正在读取尺寸…';
        e.status.textContent = '正在读取图片尺寸…';
        e.run.disabled = true;
        return;
      }

      var t = ITB.transform.computeTarget(sample.width, sample.height, p);

      var lines = [];
      lines.push('以「' + sample.name + '」为例：' + sample.width + ' × ' + sample.height +
        '  →  ' + t.width + ' × ' + t.height);
      if (t.blockedByUpscale) {
        lines.push('⚠ 目标比原图大，已按「禁止放大」保持原尺寸。要放大请勾上上面的选项。');
      }
      if (t.unchanged) {
        lines.push('尺寸和目标一致，图片不会被重新编码。');
      }

      // 统计尺寸实际发生变化的图片数量
      var willShrink = 0;
      var willSkip = 0;
      var up = 0;
      var sel = ITB.selectedFiles();
      for (var k = 0; k < sel.length; k++) {
        if (!sel[k].measured) continue;
        var tk = ITB.transform.computeTarget(sel[k].width, sel[k].height, p);
        if (tk.unchanged) willSkip++;
        else if (tk.blockedByUpscale) { willShrink++; up++; }
        else if (tk.width > sel[k].width) up++;
        else willShrink++;
      }
      lines.push('共 ' + sel.length + ' 张：' + willShrink + ' 张会改变尺寸，' +
        willSkip + ' 张保持不变' + (up ? '，其中 ' + up + ' 张因为「禁止放大」而没有按目标放大' : '') + '。');

      e.hint.textContent = lines.join(' ');
      e.status.textContent = '按' + (mode === 'percent' ? '百分比' : (mode === 'height' ? '高度' : '宽度')) +
        '输出，打包为 ZIP（不改文件名）。';
      e.status.className = t.blockedByUpscale ? 'run-status is-warn' : 'run-status';
      e.run.disabled = ITB.state.busy;
    }
  };

  /* ============================================================
     三、转格式
     ============================================================ */

  var FORMATS = [
    { id: 'png', label: 'PNG', desc: '无损，体积大，支持透明' },
    { id: 'jpeg', label: 'JPEG', desc: '有损，体积小，透明会垫白底' },
    { id: 'webp', label: 'WebP', desc: '有损但效率高，支持透明' }
  ];

  var format = {
    id: 'format',
    els: {},
    current: 'jpeg',

    init: function (onChange) {
      var e = format.els = {
        formats: U.$('fm-formats'),
        quality: U.$('fm-quality'),
        hint: U.$('fm-hint'),
        keepExt: U.$('fm-keep-ext'),
        status: U.$('fm-status'),
        run: U.$('fm-run')
      };

      FORMATS.forEach(function (f) {
        var chip = U.el('button', {
          cls: 'chip chip-lg',
          text: f.label,
          attrs: { type: 'button', 'data-fmt': f.id, title: f.desc },
          parent: e.formats
        });
        chip.addEventListener('click', function () {
          format.current = f.id;
          onChange();
        });
      });

      e.quality.addEventListener('input', onChange);
      e.keepExt.addEventListener('change', onChange);

      // 执行按钮由 app.js 统一绑定
    },

    params: function () {
      var pct = parseFloat(format.els.quality.value);
      if (!isFinite(pct) || pct <= 0) pct = 92;
      return {
        format: format.current,
        quality: Math.max(0.01, Math.min(1, pct / 100))
      };
    },

    refresh: function () {
      var e = format.els;
      var selected = ITB.selectedFiles();
      var p = format.params();

      var chips = e.formats.querySelectorAll('[data-fmt]');
      for (var i = 0; i < chips.length; i++) {
        chips[i].classList.toggle('is-on', chips[i].getAttribute('data-fmt') === format.current);
      }

      var isPng = format.current === 'png';
      e.quality.disabled = isPng || ITB.state.busy;

      var label = ITB.transform.labelOf(format.current);
      var ext = ITB.transform.extOf(format.current);

      if (isPng) {
        e.hint.textContent = 'PNG 是无损格式，没有质量参数。';
      } else if (format.current === 'jpeg') {
        e.hint.textContent = '数值越低体积越小，画质损失越明显。推荐 85–95。' +
          'JPEG 不支持透明，透明区域会自动垫成白色（和原 png2pdf 一致）。';
      } else {
        e.hint.textContent = '数值越低体积越小。WebP 支持透明，不需要垫白底。';
      }

      var sameCount = 0;
      for (var k = 0; k < selected.length; k++) {
        var src = ITB.transform.formatFromMime(selected[k].file.type);
        if (src === format.current) sameCount++;
      }

      if (!selected.length) {
        e.status.textContent = '先勾选要处理的图片。';
        e.status.className = 'run-status';
      } else {
        var msg = '全部转成 ' + label +
          (isPng ? '' : '（质量 ' + Math.round(p.quality * 100) + '%）') +
          '，打包为 ZIP。';
        if (sameCount) msg += ' 其中 ' + sameCount + ' 张本来就是 ' + label + '，会重新编码一遍。';
        if (e.keepExt.checked) msg += ' 后缀会改成 ' + ext + '。';
        e.status.textContent = msg;
        e.status.className = 'run-status';
      }

      e.run.disabled = ITB.state.busy || !selected.length;

      /* 同步刷新文件池中显示的目标后缀 */
      ITB.app.renderPool();
    }
  };

  /* ============================================================
     四、导出 PDF
     ============================================================ */

  var pdf = {
    id: 'pdf',
    els: {},

    init: function (onChange) {
      var e = pdf.els = {
        name: U.$('pdf-name'),
        stamp: U.$('pdf-stamp'),
        nameHint: U.$('pdf-name-hint'),
        uniform: U.$('pdf-uniform'),
        uniformHint: U.$('pdf-uniform-hint'),
        summary: U.$('pdf-summary'),
        pages: U.$('pdf-pages'),
        status: U.$('pdf-status'),
        run: U.$('pdf-run')
      };

      e.name.addEventListener('input', onChange);
      // 勾选框仅影响最终文件名，切换后重算预览即可
      if (e.stamp) e.stamp.addEventListener('change', onChange);
      // 统一宽度会改变各页的最终尺寸，需重算页面列表
      if (e.uniform) e.uniform.addEventListener('change', onChange);

      // 执行按钮由 app.js 统一绑定
    },

    outName: function () {
      return pdf.els.name.value.trim();
    },

    /** 自动命名时是否附加时间戳。默认附加（勾选框默认选中） */
    stampOn: function () {
      var el = pdf.els.stamp;
      return el ? el.checked : true;
    },

    /** 是否将所有页统一为最宽一张的宽度。默认启用 */
    uniformOn: function () {
      var el = pdf.els.uniform;
      return el ? el.checked : true;
    },

    /** 自动命名所用主干：第一张参与处理图片的目录名，或文件名主干 */
    autoBase: function () {
      var picked = ITB.selectedFiles();
      if (!picked.length) return '图片';

      var first = picked[0];
      var rel = first.relPath || '';
      if (rel) {
        var slash = rel.indexOf('/');
        if (slash > 0) return rel.slice(0, slash);
      }
      return U.splitExt(first.name).base.replace(/[\s_\-]*\d+$/, '') || '图片';
    },

    /** 最终文件名的预览；已填写文件名时以填写内容为准 */
    namePreview: function () {
      var custom = pdf.outName();
      if (custom) return custom + '.pdf';

      var base = pdf.autoBase();
      return pdf.stampOn() ? base + '_' + U.dateStamp() + '.pdf' : base + '.pdf';
    },

    refresh: function () {
      var e = pdf.els;
      var selected = ITB.selectedFiles();

      U.clear(e.pages);

      // 实时显示最终文件名，使勾选框的效果立即可见
      if (e.nameHint) {
        e.nameHint.textContent = pdf.outName()
          ? '用你填的名字：' + pdf.namePreview()
          : '自动命名：' + pdf.namePreview() +
            (pdf.stampOn() ? '' : '（不带时间戳）');
      }

      if (!selected.length) {
        e.summary.textContent = '先勾选要合并的图片。';
        e.status.textContent = '先勾选要合并的图片。';
        e.status.className = 'run-status';
        e.run.disabled = true;
        return;
      }

      /* 启用统一宽度时，先求最宽一张的宽度，各页按该宽度等比折算。
         与 pdfBuild.build() 采用同一算法，避免预览与实际产物不一致。 */
      var uniform = pdf.uniformOn();
      var maxW = 0;
      var k;
      if (uniform) {
        for (k = 0; k < selected.length; k++) {
          if (selected[k].measured && selected[k].width > maxW) maxW = selected[k].width;
        }
      }

      /* 各页最终的 pt 尺寸。宽高采用同一比例，因此不会变形。 */
      function finalSize(f) {
        if (!f.measured || !f.width || !f.height) return null;
        if (!uniform || !maxW) return { width: f.width, height: f.height };
        return {
          width: maxW,
          height: Math.max(1, Math.round(f.height * (maxW / f.width)))
        };
      }

      e.summary.textContent = '共 ' + selected.length + ' 页，按左栏顺序排列：' +
        (uniform && maxW ? '（统一宽度 ' + maxW + ' pt）' : '');

      var list = U.el('div', { cls: 'page-rows', parent: e.pages });
      var limit = Math.min(selected.length, 200);
      for (var i = 0; i < limit; i++) {
        var f = selected[i];
        var row = U.el('div', { cls: 'page-row', parent: list });
        U.el('span', { cls: 'page-idx', text: String(i + 1), parent: row });
        U.el('span', { cls: 'page-name', text: f.name, parent: row });

        var size = finalSize(f);
        U.el('span', {
          cls: 'page-size',
          text: size ? (size.width + '×' + size.height + ' pt')
                     : (f.measured ? '尺寸未知' : '读取中…'),
          parent: row
        });
      }
      if (selected.length > limit) {
        U.el('p', { cls: 'sec-hint', text: '⋯ 还有 ' + (selected.length - limit) + ' 页未列出', parent: e.pages });
      }

      // 体积粗估：JPEG 0.92 约每像素 0.5 字节，按最终尺寸计算
      var pixels = 0;
      for (k = 0; k < selected.length; k++) {
        var sz = finalSize(selected[k]);
        if (sz) pixels += sz.width * sz.height;
      }
      var est = Math.round(pixels * 0.5);

      // 统一宽度提示：区分放大与缩小，避免误解为图像被压缩
      if (e.uniformHint) {
        if (!uniform) {
          e.uniformHint.textContent =
            '未勾选：每页各按自己的原图尺寸，一页一张图互不影响。';
        } else if (!maxW) {
          e.uniformHint.textContent = '正在读取尺寸…';
        } else {
          var up = 0;
          var down = 0;
          for (k = 0; k < selected.length; k++) {
            if (!selected[k].measured) continue;
            if (selected[k].width < maxW) up++;
            else if (selected[k].width > maxW) down++;
          }
          e.uniformHint.textContent = '统一宽度 ' + maxW + ' pt：' +
            (up ? up + ' 张窄图会等比放大' : '没有需要放大的图') +
            (down ? '，' + down + ' 张宽图会等比缩小' : '') + '。';
        }
      }

      e.status.textContent = '将合并 ' + selected.length + ' 页' +
        (est ? '，粗估 ' + U.formatBytes(est) + '（实际取决于图片内容）' : '') +
        (uniform && maxW
          ? '。页面统一宽度 ' + maxW + ' pt，高度按各自比例。'
          : '。页面尺寸 = 原图像素尺寸（1px = 1pt）。');
      e.status.className = 'run-status';
      e.run.disabled = ITB.state.busy;
    }
  };

  /* ============================================================
     统一入口
     ============================================================ */

  var ALL = { shell: shell, resize: resize, format: format, pdf: pdf };

  ITB.sections = {
    init: function (onChange) {
      // 逐个分区初始化：单个分区异常不应影响其余三个
      [shell, resize, format, pdf].forEach(function (s) {
        try {
          s.init(onChange);
        } catch (e) {
          if (window.console && console.error) {
            console.error('[imgtoolbox] 分区 ' + s.id + ' 初始化失败', e);
          }
        }
      });
    },

    refreshAll: function () {
      [shell, resize, format, pdf].forEach(function (s) {
        try {
          s.refresh();
        } catch (e) {
          if (window.console && console.error) {
            console.error('[imgtoolbox] 分区 ' + s.id + ' 刷新失败', e);
          }
        }
      });
    },

    refresh: function (id) {
      var s = ALL[id];
      if (!s) return;
      try {
        s.refresh();
      } catch (e) {
        if (window.console && console.error) {
          console.error('[imgtoolbox] 分区 ' + id + ' 刷新失败', e);
        }
      }
    },

    get: function (id) { return ALL[id]; },

    /** 供文件池显示导出名称时调用 */
    shellPlan: function () { return shell.plan(); },

    /** 转格式分区是否改变扩展名 */
    formatExt: function () {
      if (!format.els.keepExt || !format.els.keepExt.checked) return null;
      return ITB.transform.extOf(format.current);
    }
  };

})(window.ITB);
