/* ============================================================
   pool.js —— 左栏文件池
   负责：收文件、去重、量尺寸、排序、勾选、拖拽手动排序、渲染

   排序沿用原 png2pdf 的两套：natural（数字感知）和字典序，
   并保留「手动拖过之后就不再自动重排」的语义。
   ============================================================ */

window.ITB = window.ITB || {};

(function (ITB) {
  'use strict';

  var U = ITB.util;

  var listEl = null;
  // 缩略图直接缓存 canvas 元素，渲染时 clone 一份插进去。
  // 比 objectURL 干净：没有 URL 生命周期问题，也不会因为重渲染
  // 撤销了还挂在 DOM 上的旧 URL 而闪裂。
  var thumbCache = Object.create(null);   // id → canvas
  var thumbPending = Object.create(null);
  // 缩略图异步生成、直接替换 DOM 节点，不触发整块重渲染，
  // 所以每个文件「输出时的名字」得缓存下来，补图时才能补上这一行
  var finalNameCache = Object.create(null);

  /* ── 初始化 ─────────────────────────────────────────────── */

  function init() {
    listEl = U.$('pool-list');
    bindDrag();
    bindKeys();
  }

  /* ── 收文件 ─────────────────────────────────────────────── */

  /**
   * @param {FileList|Array} fileList
   * @param {function} onChanged 数据变动后的回调（由 app.js 负责重渲染和刷新统计）
   */
  function addFiles(fileList, onChanged) {
    var st = ITB.state;
    var incoming = [];
    var existing = Object.create(null);
    var i;

    // 用 名字+大小+修改时间 做去重指纹，比只比名字可靠
    for (i = 0; i < st.files.length; i++) {
      var f0 = st.files[i];
      existing[fp(f0.name, f0.size, f0.lastModified)] = true;
    }

    for (i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      if (!looksLikeImage(f)) continue;
      var key = fp(f.name, f.size, f.lastModified);
      if (existing[key]) continue;
      existing[key] = true;

      incoming.push({
        id: st.seq++,
        file: f,
        name: f.name,
        relPath: f.webkitRelativePath || '',
        size: f.size,
        lastModified: f.lastModified || 0,
        type: f.type || '',
        width: 0,
        height: 0,
        measured: false,
        selected: true
      });
    }

    if (!incoming.length) return 0;

    st.files = st.files.concat(incoming);
    applySort();

    // 顺手把尺寸量出来（只读文件头，很快），预览要用
    measure(incoming, onChanged);
    onChanged();

    return incoming.length;
  }

  function fp(name, size, mtime) {
    return String(name).toLowerCase() + '\u0000' + size + '\u0000' + mtime;
  }

  var IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif|avif)$/i;

  function looksLikeImage(file) {
    if (file.type && file.type.indexOf('image/') === 0) return true;
    return IMAGE_EXT.test(file.name || '');
  }

  function measure(files, onChanged) {
    var done = 0;
    var total = files.length;

    files.forEach(function (item) {
      U.loadImageBitmap(item.file).then(function (bmp) {
        item.width = bmp.width;
        item.height = bmp.height;
        item.measured = true;
        if (typeof bmp.close === 'function') bmp.close();
      }).catch(function () {
        item.measured = true;
      }).then(function () {
        done++;
        if (done === total && onChanged) onChanged();
      });
    });
  }

  /* ── 排序 ───────────────────────────────────────────────── */

  function comparator() {
    var st = ITB.state;
    var natural = st.sortMode === 'natural';
    var dir = st.sortOrder === 'desc' ? -1 : 1;

    return function (a, b) {
      var r = natural
        ? U.naturalCompare(a.name, b.name)
        : U.lexCompare(a.name, b.name);
      // 名字完全一样时用 id 兜底，保证排序结果稳定
      return r !== 0 ? r * dir : (a.id - b.id);
    };
  }

  function applySort() {
    var st = ITB.state;
    st.files.sort(comparator());
    st.baseOrder = st.files.map(function (f) { return f.id; });
  }

  /** 界面上的排序选项变了 */
  function setSort(mode, order) {
    var st = ITB.state;
    st.sortMode = mode;
    st.sortOrder = order;
    if (!st.manualOrder) applySort();
  }

  /** 还原成自动排序 */
  function resetOrder() {
    var st = ITB.state;
    st.manualOrder = false;
    applySort();
  }

  /** 手动把 fromId 挪到 toId 的位置（前或后） */
  function moveBefore(fromId, toId, after) {
    var st = ITB.state;
    var from = indexOf(fromId);
    var to = indexOf(toId);
    if (from < 0 || to < 0 || from === to) return false;

    var item = st.files.splice(from, 1)[0];
    // 拔掉之后目标下标可能往前挪了一位
    to = indexOf(toId);
    st.files.splice(after ? to + 1 : to, 0, item);
    st.manualOrder = true;
    return true;
  }

  function moveBy(id, delta) {
    var st = ITB.state;
    var i = indexOf(id);
    if (i < 0) return false;
    var j = i + delta;
    if (j < 0 || j >= st.files.length) return false;

    var item = st.files.splice(i, 1)[0];
    st.files.splice(j, 0, item);
    st.manualOrder = true;
    return true;
  }

  function indexOf(id) {
    var list = ITB.state.files;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return i;
    }
    return -1;
  }

  /* ── 勾选 ───────────────────────────────────────────────── */

  function setSelected(id, on, onChanged) {
    var f = ITB.findFile(id);
    if (!f || f.selected === on) return;
    f.selected = on;
    if (on) ITB.state.sampleId = id;
    if (onChanged) onChanged();
  }

  function setAllSelected(on, onChanged) {
    var list = ITB.state.files;
    for (var i = 0; i < list.length; i++) list[i].selected = on;
    if (on && list.length) ITB.state.sampleId = list[0].id;
    if (onChanged) onChanged();
  }

  function invertSelection(onChanged) {
    var list = ITB.state.files;
    for (var i = 0; i < list.length; i++) list[i].selected = !list[i].selected;
    if (onChanged) onChanged();
  }

  function removeAll(onChanged) {
    var st = ITB.state;
    releaseThumbs();
    st.files = [];
    st.baseOrder = [];
    st.manualOrder = false;
    st.sampleId = null;
    st.extOverrides = {};
    if (onChanged) onChanged();
  }

  function removeOne(id, onChanged) {
    var st = ITB.state;
    var i = indexOf(id);
    if (i < 0) return;
    delete thumbCache[id];
    st.files.splice(i, 1);
    if (st.sampleId === id) st.sampleId = null;
    if (onChanged) onChanged();
  }

  /* ── 渲染 ───────────────────────────────────────────────── */

  function render(onChanged) {
    var st = ITB.state;
    U.clear(listEl);

    if (!st.files.length) {
      U.el('div', {
        cls: 'pool-empty',
        text: '还没有图片。点上方「添加图片…」或「添加文件夹…」。',
        parent: listEl
      });
      return;
    }

    // 在文件池里也显示「这一张导出时会变成什么名字」，方便逐条核对。
    // 名字变化来自重命名分区，后缀变化来自转格式分区——两者都反映在这里。
    var finalNames = Object.create(null);
    try {
      var built = ITB.sections.shellPlan();
      var fmtExt = ITB.sections.formatExt();

      for (var k = 0; k < built.length; k++) {
        var item = built[k];
        var name = item.finalName;

        if (fmtExt) {
          var parts = U.splitExt(name);
          name = U.joinName(parts.base, fmtExt);
        }

        if (name !== item.originalName) finalNames[item.file.id] = name;
      }
    } catch (e) {
      finalNames = Object.create(null);   // 参数有误时不显示，各分区会另外提示
    }
    finalNameCache = finalNames;

    var frag = document.createDocumentFragment();
    var thumbBudget = st.limits.maxPreviewThumbs;

    for (var i = 0; i < st.files.length; i++) {
      frag.appendChild(renderRow(st.files[i], i + 1, i < thumbBudget, finalNames[st.files[i].id]));
    }
    listEl.appendChild(frag);

    if (st.files.length > thumbBudget) {
      U.el('div', {
        cls: 'pool-more',
        text: '⋯ 其余 ' + (st.files.length - thumbBudget) + ' 张不显示缩略图，但仍会全部处理',
        parent: listEl
      });
    }

    void onChanged;
  }

  function renderRow(item, seq, withThumb, finalName) {
    var st = ITB.state;

    var row = U.el('div', {
      cls: 'pool-item' + (item.selected ? '' : ' is-off') +
           (st.sampleId === item.id ? ' is-current' : ''),
      attrs: { 'data-id': item.id, title: item.relPath || item.name }
    });

    // 勾选
    var cb = U.el('input', {
      cls: 'pool-check',
      attrs: { type: 'checkbox' },
      props: { checked: item.selected }
    });
    cb.addEventListener('change', function () {
      item.selected = cb.checked;
      if (cb.checked) st.sampleId = item.id;
      row.classList.toggle('is-off', !cb.checked);
      ITB.app.onSelectionChanged();
    });
    row.appendChild(cb);

    // 缩略图
    if (withThumb) {
      row.appendChild(makeThumb(item));
    } else {
      U.el('span', { cls: 'pool-thumb pool-thumb-ph', text: extTag(item.name), parent: row });
    }

    // 名字 + 元信息
    var main = U.el('div', { cls: 'pool-main', parent: row });
    var nameEl = U.el('div', { cls: 'pool-name', text: item.name, parent: main });
    var meta = (item.relPath ? item.relPath + ' · ' : '') +
      (item.measured ? item.width + '×' + item.height + ' · ' : '') +
      U.formatBytes(item.size);
    U.el('div', { cls: 'pool-meta', text: meta, parent: main });

    // 会被重命名的，多显示一行「输出时会变成什么」——比只在右栏看前三条有用得多
    if (finalName) {
      U.el('div', { cls: 'pool-meta is-out', text: '→ ' + finalName, parent: main });
    }

    // 顺序号
    U.el('span', { cls: 'pool-seq', text: String(seq), parent: row });

    // 拖拽手柄
    U.el('span', { cls: 'pool-grip', text: '≡', parent: row, attrs: { title: '拖动调整顺序' } });

    nameEl.dataset.role = 'name';
    row.addEventListener('mousedown', function () {
      st.sampleId = item.id;
    });

    return row;
  }

  function makeThumb(item) {
    var cached = thumbCache[item.id];
    if (cached) {
      var clone = cached.cloneNode(false);      // 浅拷贝，像素数据共享
      clone.className = 'pool-thumb';
      clone.removeAttribute('data-thumb-for');
      return clone;
    }

    var ph = U.el('span', { cls: 'pool-thumb pool-thumb-ph', text: extTag(item.name) });
    ph.dataset.thumbFor = String(item.id);

    if (!thumbPending[item.id]) {
      thumbPending[item.id] = true;
      buildThumb(item).then(function (canvas) {
        delete thumbPending[item.id];
        if (!canvas) return;
        thumbCache[item.id] = canvas;

        var slot = listEl.querySelector('[data-thumb-for="' + item.id + '"]');
        if (!slot || !slot.parentNode) return;   // 已经被重渲染掉了

        var ready = canvas.cloneNode(false);
        ready.className = 'pool-thumb';
        ready.removeAttribute('data-thumb-for');

        var parent = slot.parentNode;
        parent.replaceChild(ready, slot);

        // 补上「输出时的名字」这一行（缩略图是异步来的，整块重渲染时还没有它）
        var outName = finalNameCache[item.id];
        var mainBox = parent.querySelector('.pool-main');
        if (outName && mainBox && !mainBox.querySelector('.pool-meta.is-out')) {
          U.el('div', { cls: 'pool-meta is-out', text: '→ ' + outName, parent: mainBox });
        }
      });
    }

    return ph;
  }

  function buildThumb(item) {
    return U.loadImageBitmap(item.file).then(function (bmp) {
      var size = 36;
      var canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;

      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#101216';
      ctx.fillRect(0, 0, size, size);
      if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';

      // 等比缩放进框内并居中，不裁切
      var scale = Math.min(size / bmp.width, size / bmp.height);
      var w = Math.max(1, Math.round(bmp.width * scale));
      var h = Math.max(1, Math.round(bmp.height * scale));
      ctx.drawImage(bmp, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h);
      if (typeof bmp.close === 'function') bmp.close();

      return canvas;
    }).catch(function () { return null; });
  }

  function extTag(name) {
    var parts = U.splitExt(name);
    var ext = parts.ext.replace('.', '');
    return ext ? ext.slice(0, 4) : 'img';
  }

  function releaseThumbs() {
    thumbCache = Object.create(null);
    thumbPending = Object.create(null);
  }

  /* ── 拖拽排序 ───────────────────────────────────────────── */

  var dragId = null;
  var dropTarget = null;
  var dropAfter = false;
  var dragging = false;

  function bindDrag() {
    listEl.addEventListener('mousedown', function (e) {
      var grip = e.target.closest ? e.target.closest('.pool-grip') : null;
      if (!grip) return;
      var row = grip.closest('.pool-item');
      if (!row) return;
      e.preventDefault();

      dragId = parseInt(row.dataset.id, 10);
      dragging = false;
      dropTarget = null;
    });

    document.addEventListener('mousemove', function (e) {
      if (dragId === null) return;

      if (!dragging) {
        dragging = true;
        var startRow = rowOf(dragId);
        if (startRow) startRow.classList.add('is-dragging');
      }

      var row = rowFromPoint(e.clientY);
      clearDropMarks();

      if (!row) {
        listEl.classList.add('is-dragover');
        dropTarget = null;
        return;
      }

      listEl.classList.remove('is-dragover');
      var id = parseInt(row.dataset.id, 10);
      if (id === dragId) { dropTarget = null; return; }

      var rect = row.getBoundingClientRect();
      dropAfter = (e.clientY - rect.top) > rect.height / 2;
      dropTarget = id;
      row.classList.add(dropAfter ? 'is-drop-after' : 'is-drop-before');
    });

    document.addEventListener('mouseup', function () {
      if (dragId === null) return;

      var from = dragId;
      var to = dropTarget;
      var after = dropAfter;

      clearDropMarks();
      var row = rowOf(from);
      if (row) row.classList.remove('is-dragging');
      listEl.classList.remove('is-dragover');

      dragId = null;
      dropTarget = null;
      dragging = false;

      if (to !== null && to !== from && moveBefore(from, to, after)) {
        ITB.app.onOrderChanged();
      }
    });
  }

  function rowOf(id) {
    return listEl.querySelector('.pool-item[data-id="' + id + '"]');
  }

  function rowFromPoint(y) {
    var rows = listEl.querySelectorAll('.pool-item');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i].getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) return rows[i];
    }
    return null;
  }

  function clearDropMarks() {
    var marked = listEl.querySelectorAll('.is-drop-before, .is-drop-after');
    for (var i = 0; i < marked.length; i++) {
      marked[i].classList.remove('is-drop-before', 'is-drop-after');
    }
  }

  function bindKeys() {
    listEl.addEventListener('keydown', function (e) {
      var st = ITB.state;
      if (!st.files.length) return;
      var current = st.sampleId !== null ? st.sampleId : st.files[0].id;
      var delta = 0;

      if (e.key === 'ArrowUp') delta = -1;
      else if (e.key === 'ArrowDown') delta = 1;
      else if (e.key === ' ') {
        e.preventDefault();
        var f = ITB.findFile(current);
        if (f) { f.selected = !f.selected; ITB.app.onDataChanged(); }
        return;
      } else return;

      e.preventDefault();
      if (moveBy(current, delta)) {
        st.sampleId = current;
        ITB.app.onOrderChanged();
        rowOf(current) && rowOf(current).scrollIntoView({ block: 'nearest' });
      }
    });
  }

  ITB.pool = {
    init: init,
    addFiles: addFiles,
    applySort: applySort,
    setSort: setSort,
    resetOrder: resetOrder,
    moveBefore: moveBefore,
    moveBy: moveBy,
    setSelected: setSelected,
    setAllSelected: setAllSelected,
    invertSelection: invertSelection,
    removeAll: removeAll,
    removeOne: removeOne,
    render: render,
    indexOf: indexOf
  };

})(window.ITB);
