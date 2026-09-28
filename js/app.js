/* ============================================================
   app.js —— 界面装配

   分四个互不干扰的分区，共用左栏一个文件池（那只是「处理哪些图」，
   不是流水线）。切换分区不丢设置，分区之间也互不影响。
   ============================================================ */

window.ITB = window.ITB || {};

(function (ITB) {
  'use strict';

  var U = ITB.util;
  var ui = {};

  var TABS = ['shell', 'resize', 'format', 'pdf'];

  var RUN_BUTTONS = {
    shell: 'rn-run',
    resize: 'rs-run',
    format: 'fm-run',
    pdf: 'pdf-run'
  };

  var TAB_HINTS = {
    shell: '只改文件名，图片内容不变',
    resize: '只改尺寸，格式和文件名不变',
    format: '只换图片编码，尺寸和文件名不变',
    pdf: '把所有勾选的图合并成一份 PDF'
  };

  var current = 'shell';

  /* ============================================================
     启动
     ============================================================ */

  function boot() {
    ui = {
      filePicker: U.$('file-picker'),
      folderPicker: U.$('folder-picker'),
      statCount: U.$('stat-count'),
      statSelected: U.$('stat-selected'),
      poolHint: U.$('pool-hint'),
      resetOrder: U.$('btn-reset-order'),
      chkRecursive: U.$('chk-recursive'),
      selSort: U.$('sel-sort'),
      selOrder: U.$('sel-order'),
      tabHint: U.$('tab-hint'),
      progressWrap: U.$('progress-wrap'),
      progressFill: U.$('progress-fill'),
      progressText: U.$('progress-text'),
      cancelBtn: U.$('btn-cancel'),
      resultBox: U.$('result-box')
    };

    ITB.pool.init();
    ITB.sections.init(onSettingsChanged);

    bindTabs();
    bindToolbar();
    bindRunButtons();
    bindProgress();

    ITB.pool.render();
    ITB.sections.refreshAll();
    refreshChrome();

    window.addEventListener('beforeunload', function (e) {
      if (ITB.state.busy) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  /* ============================================================
     分区切换
     ============================================================ */

  function bindTabs() {
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function () {
        switchTab(this.getAttribute('data-tab'));
      });
    }
  }

  function switchTab(id) {
    if (TABS.indexOf(id) < 0 || ITB.state.busy) return;
    current = id;
    ITB.state.tab = id;

    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('is-active', tabs[i].getAttribute('data-tab') === id);
    }

    var panels = document.querySelectorAll('.tab-panel');
    for (var k = 0; k < panels.length; k++) {
      panels[k].classList.toggle('is-active', panels[k].getAttribute('data-panel') === id);
    }

    ui.tabHint.textContent = TAB_HINTS[id] || '';

    // 切过去时重算一遍这个分区的预览
    ITB.sections.refresh(id);
    ITB.pool.render();
    hideResult();
  }

  /* ============================================================
     工具栏（文件池相关）
     ============================================================ */

  function bindToolbar() {
    U.$('btn-add-files').addEventListener('click', function () {
      ui.filePicker.click();
    });

    U.$('btn-add-folder').addEventListener('click', function () {
      ui.folderPicker.click();
    });

    ui.filePicker.addEventListener('change', function () {
      if (!this.files || !this.files.length) return;
      var n = ITB.pool.addFiles(this.files, onDataChanged);
      if (!n) U.toast('这些图片已经在列表里了。', 'warn');
      else U.toast('添加了 ' + n + ' 张图片。', 'ok');
      this.value = '';
    });

    ui.folderPicker.addEventListener('change', function () {
      if (!this.files || !this.files.length) return;

      var recursive = ui.chkRecursive.checked;
      var list = this.files;

      if (!recursive) {
        // 只留最外层：webkitRelativePath 里只有一个斜杠的就是顶层文件
        list = Array.prototype.filter.call(list, function (f) {
          var rel = f.webkitRelativePath || '';
          return rel.indexOf('/') === rel.lastIndexOf('/');
        });
      }

      var n = ITB.pool.addFiles(list, onDataChanged);
      if (!n) U.toast('这个文件夹里没有新的图片。', 'warn');
      else U.toast('添加了 ' + n + ' 张图片' + (recursive ? '（含子文件夹）' : ''), 'ok');
      this.value = '';
    });

    U.$('btn-clear').addEventListener('click', function () {
      if (ITB.state.busy || !ITB.state.files.length) return;
      if (!window.confirm('清空文件池？四个分区的设置都会保留。')) return;
      ITB.pool.removeAll(onDataChanged);
      U.toast('已清空文件池。');
    });

    U.$('btn-select-all').addEventListener('click', function () {
      ITB.pool.setAllSelected(true, onDataChanged);
    });
    U.$('btn-select-none').addEventListener('click', function () {
      ITB.pool.setAllSelected(false, onDataChanged);
    });
    U.$('btn-select-invert').addEventListener('click', function () {
      ITB.pool.invertSelection(onDataChanged);
    });

    ui.resetOrder.addEventListener('click', function () {
      ITB.pool.resetOrder();
      onDataChanged();
      U.toast('已恢复自动排序。');
    });

    ui.selSort.addEventListener('change', function () {
      ITB.pool.setSort(this.value, ui.selOrder.value);
      onDataChanged();
    });

    ui.selOrder.addEventListener('change', function () {
      ITB.pool.setSort(ui.selSort.value, this.value);
      onDataChanged();
    });
  }

  function bindProgress() {
    ui.cancelBtn.addEventListener('click', function () {
      ITB.state.cancelRequested = true;
      ui.cancelBtn.disabled = true;
      ui.progressText.textContent = '正在取消…';
    });
  }

  /* ============================================================
     执行
     ============================================================ */

  function bindRunButtons() {
    TABS.forEach(function (id) {
      var btn = U.$(RUN_BUTTONS[id]);
      if (!btn) return;
      btn.addEventListener('click', function () { execute(id); });
    });
  }

  function execute(id) {
    var st = ITB.state;
    if (st.busy) return;

    var selected = ITB.selectedFiles();
    if (!selected.length) {
      U.toast('先勾选要处理的图片。', 'warn');
      return;
    }

    // 重命名分区：有重名就直接拦住
    if (id === 'shell') {
      var plan = ITB.sections.get('shell').plan();
      var dup = ITB.rename.findDuplicates(plan.map(function (p) { return p.finalName; }));
      if (!dup.ok) {
        U.toast('有 ' + dup.dups.length + ' 个文件名会重复，先改规则。', 'danger');
        return;
      }
    }

    // 数量大时提醒一句
    if (selected.length > st.limits.warnCount) {
      var mem = U.formatBytes(ITB.transform.estimateMemory(selected, []));
      if (!window.confirm('这次要处理 ' + selected.length + ' 张图片。\n\n' +
          '浏览器内存吃紧时可能变慢甚至失败，建议分批。\n\n仍然继续？')) {
        return;
      }
      void mem;
    }

    st.busy = true;
    st.cancelRequested = false;
    setBusyUI(true);
    hideResult();
    setProgress(0, selected.length, '准备中…');

    ITB.exporter.runSection(id, onProgress, function () {
      return st.cancelRequested;
    }).then(function (res) {
      finishRun();

      if (res.cancelled) {
        showResult('warn', '已取消', '没有生成任何文件。');
        U.toast('已取消。', 'warn');
        return;
      }

      var filename = outputName(id, res);

      /* 下载可能失败（比如被浏览器拦下），单独兜住，
         免得文件没发出却报成「完成」 */
      try {
        U.downloadBlob(res.blob, filename);
      } catch (e) {
        showResult('danger', '生成成功了，但下载失败', String(e && e.message || e) +
          '\n可以试试换个浏览器，或检查下载拦截设置。');
        U.toast('下载失败。', 'danger');
        return;
      }

      reportSuccess(id, res, filename);
    }).catch(function (err) {
      finishRun();

      var msg = String(err && err.message || err);
      var where = locationOf(err);

      showResult('danger', '执行失败' + (where ? '（' + where + '）' : ''), msg);
      U.toast('执行失败：' + msg.split('\n')[0] + (where ? ' @ ' + where : ''), 'danger');

      if (window.console && console.error) console.error('[imgtoolbox] 执行失败', err);
    });
  }

  function reportSuccess(id, res, filename) {
    var sub;
    var failCount = (res.errors && res.errors.length) || 0;

    if (res.kind === 'pdf') {
      sub = '已合并 ' + res.pages + ' 页，共 ' + U.formatBytes(res.bytes) +
        '。页面尺寸 = 原图像素尺寸，生成后已通过结构自检。';
    } else {
      sub = '已打包 ' + res.entries + ' 个文件，共 ' + U.formatBytes(res.bytes) + '。';
    }

    sub += ' 下载已开始：' + filename;

    if (failCount) {
      showResult('warn', '完成，但有 ' + failCount + ' 个文件被跳过', sub, res.errors);
      U.toast('完成，但有 ' + failCount + ' 个文件失败。', 'warn');
    } else {
      showResult('ok', '完成：' + filename, sub);
      U.toast('完成：' + filename, 'ok');
    }

    void id;
  }

  /** 输出文件名（不带扩展名，扩展名按 kind 拼） */
  function outputName(id, res) {
    var st = ITB.state;
    var stamp = U.dateStamp();
    var prefix = {
      shell: '重命名',
      resize: '改分辨率',
      format: '转格式',
      pdf: '合并'
    }[id] || '输出';

    // 用第一张图所在目录名，或者文件名主干
    var base = '';
    var first = st.files[0];
    if (first) {
      var rel = first.relPath || '';
      if (rel) {
        var slash = rel.indexOf('/');
        if (slash > 0) base = rel.slice(0, slash);
      }
      if (!base) base = U.splitExt(first.name).base.replace(/[\s_\-]*\d+$/, '');
    }
    base = (base || '图片').replace(/[\\/:*?"<>|]/g, '_');

    if (id === 'pdf') {
      var custom = ITB.sections.get('pdf').outName();
      if (custom) return sanitize(custom) + '.pdf';
      return base + '_' + stamp + '.pdf';
    }

    return base + '_' + prefix + '_' + stamp + '.zip';
  }

  function sanitize(s) {
    return String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/\.(zip|pdf)$/i, '');
  }

  function locationOf(err) {
    var stack = String(err && err.stack || '');
    var lines = stack.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var m = /(js\/[\w.-]+\.js):(\d+):(\d+)/.exec(lines[i]);
      if (m) return m[1] + ':' + m[2];
    }
    return '';
  }

  function onProgress(done, total, label) {
    setProgress(done, total, label ? ('处理 ' + label) : '处理中…');
  }

  function setProgress(done, total, text) {
    var pct = total ? Math.round(done / total * 100) : 0;
    ui.progressFill.style.width = pct + '%';
    ui.progressText.textContent = text + '　' + done + ' / ' + total;
  }

  /* ============================================================
     状态刷新
     ============================================================ */

  function onSettingsChanged() {
    ITB.sections.refresh(current);
    ITB.pool.render();
    refreshChrome();
  }

  /** 手动调整过顺序（拖拽 / 方向键）：只影响页序和编号，刷新预览即可 */
  function onOrderChanged() {
    ITB.pool.render();
    ITB.sections.refreshAll();
    refreshChrome();
  }

  function onDataChanged() {
    ITB.pool.render();
    ITB.sections.refreshAll();
    refreshChrome();
  }

  /** 只是勾选变了：各分区的预览要跟着更新，但不用重建文件池 */
  function onSelectionChanged() {
    ITB.sections.refreshAll();
    ITB.pool.render();
    refreshChrome();
  }

  function refreshChrome() {
    var st = ITB.state;
    var selected = ITB.selectedFiles();

    if (ui.statCount) ui.statCount.textContent = String(st.files.length);
    if (ui.statSelected) ui.statSelected.textContent = '已选 ' + selected.length;

    if (ui.selSort) ui.selSort.value = st.sortMode;
    if (ui.selOrder) ui.selOrder.value = st.sortOrder;
    if (ui.resetOrder) ui.resetOrder.classList.toggle('is-hidden', !st.manualOrder);

    if (ui.poolHint) {
      if (!st.files.length) {
        ui.poolHint.textContent = '还没有图片。点上方「添加图片…」或「添加文件夹…」。';
      } else if (!selected.length) {
        ui.poolHint.textContent = '当前没有勾选任何图片。';
      } else if (st.manualOrder) {
        ui.poolHint.textContent = '已手动调整顺序 · 共 ' + st.files.length +
          ' 张，' + selected.length + ' 张参与处理';
      } else {
        ui.poolHint.textContent = '共 ' + st.files.length + ' 张，' +
          selected.length + ' 张参与处理';
      }
    }
  }

  function setBusyUI(busy) {
    ui.progressWrap.classList.toggle('is-hidden', !busy);
    ui.cancelBtn.disabled = false;

    ui.filePicker.disabled = busy;
    ui.folderPicker.disabled = busy;

    var list = document.querySelectorAll(
      '.btn-run, .btn-add, #btn-add-files, #btn-add-folder, #btn-clear, ' +
      '#btn-select-all, #btn-select-none, #btn-select-invert, #btn-reset-order, ' +
      '#sel-sort, #sel-order, .tab, .chip, #rs-value, #rs-upscale, #fm-quality');
    for (var i = 0; i < list.length; i++) list[i].disabled = busy;

    if (!busy) {
      // 交回各分区自己决定按钮是否可用
      ITB.sections.refreshAll();
    }
  }

  function finishRun() {
    ITB.state.busy = false;
    ITB.state.cancelRequested = false;
    setBusyUI(false);
    refreshChrome();
  }

  /* ============================================================
     结果提示
     ============================================================ */

  function showResult(kind, title, sub, list) {
    U.clear(ui.resultBox);
    ui.resultBox.classList.remove('is-hidden');
    ui.resultBox.className = 'result-box is-' + kind;

    U.el('div', { cls: 'result-title', text: title, parent: ui.resultBox });

    if (sub) {
      // sub 里可能有换行
      var parts = String(sub).split('\n');
      for (var i = 0; i < parts.length; i++) {
        U.el('div', { cls: i === 0 ? 'result-sub' : 'result-sub mono', text: parts[i], parent: ui.resultBox });
      }
    }

    if (list && list.length) {
      var ul = U.el('ul', { parent: ui.resultBox });
      for (var k = 0; k < Math.min(8, list.length); k++) {
        U.el('li', { text: list[k], parent: ul });
      }
      if (list.length > 8) {
        U.el('li', { text: '⋯ 还有 ' + (list.length - 8) + ' 个', parent: ui.resultBox });
      }
    }
  }

  function hideResult() {
    ui.resultBox.classList.add('is-hidden');
    U.clear(ui.resultBox);
  }

  /* ============================================================
     对外接口
     ============================================================ */

  ITB.app = {
    refresh: refreshChrome,
    renderPool: function () { ITB.pool.render(); },
    onDataChanged: onDataChanged,
    onSelectionChanged: onSelectionChanged,
    onOrderChanged: onOrderChanged,
    onSettingsChanged: onSettingsChanged,
    switchTab: switchTab,
    currentTab: function () { return current; },
    runSection: execute
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})(window.ITB);
