/* ============================================================
   pool.js —— 左栏文件池
   职责：接收文件、去重、尺寸测量、排序、勾选、拖拽手动排序、渲染

   排序沿用 png2pdf 的两套规则：natural（数字感知）与字典序，
   并保留手动调整顺序后不再自动重排的语义。
   ============================================================ */

window.ITB = window.ITB || {};

(function (ITB) {
  'use strict';

  var U = ITB.util;

  var listEl = null;
  // 缩略图缓存 canvas 元素本身，渲染时 clone 后插入。
  // 相比 objectURL 无 URL 生命周期管理问题，也不会因重渲染撤销
  // 仍挂载于 DOM 的旧 URL 而导致显示中断。
  var thumbCache = Object.create(null);   // id → canvas
  var thumbPending = Object.create(null);
  // 拖动时的大图预览（120px）。只缓存最近用过的若干张，避免大批量时占内存
  var previewCache = Object.create(null);
  var previewPending = Object.create(null);
  var previewQueue = [];
  var PREVIEW_CACHE_LIMIT = 24;
  // 缩略图异步生成并直接替换 DOM 节点，不触发整体重渲染，
  // 因此需缓存每个文件的输出名称，以便补图时同步补充该行
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

    // 以 名称+大小+修改时间 作为去重标识，比仅比较名称更可靠
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

    /* 手动排序下不重排：新图片追加到末尾，已有顺序保持不变；
       自动排序下则与已有图片一起重新排序。 */
    if (!isManual()) applySort();

    // 同步触发尺寸测量（仅读取文件头），供预览使用
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
      // 名称完全相同时以 id 作为次级键，保证排序结果稳定
      return r !== 0 ? r * dir : (a.id - b.id);
    };
  }

  function applySort() {
    var st = ITB.state;
    st.files.sort(comparator());
  }

  function isManual() {
    return ITB.state.sortMode === 'manual';
  }

  /**
   * 进入手动排序。记录此前的自动排序方式，供「还原排序」恢复。
   * 拖动 ≡ 或按方向键时自动调用；也可直接从排序下拉框选择「手动排序」。
   */
  function enterManual() {
    var st = ITB.state;
    if (st.sortMode === 'manual') return;

    st.autoSortMode = st.sortMode;
    st.autoSortOrder = st.sortOrder;
    st.sortMode = 'manual';
  }

  /** 界面排序选项变更 */
  function setSort(mode, order) {
    var st = ITB.state;

    if (mode === 'manual') {
      enterManual();
      return;
    }

    st.sortMode = mode;
    st.sortOrder = order === 'desc' ? 'desc' : 'asc';
    st.autoSortMode = st.sortMode;
    st.autoSortOrder = st.sortOrder;
    applySort();
  }

  /** 恢复自动排序（回到进入手动排序前的方式） */
  function resetOrder() {
    var st = ITB.state;
    st.sortMode = st.autoSortMode || 'natural';
    st.sortOrder = st.autoSortOrder || 'asc';
    applySort();
  }

  /** 将 fromId 移动至 toId 的位置（前或后） */
  function moveBefore(fromId, toId, after) {
    var st = ITB.state;
    var from = indexOf(fromId);
    var to = indexOf(toId);
    if (from < 0 || to < 0 || from === to) return false;

    enterManual();

    var item = st.files.splice(from, 1)[0];
    // 移除元素后目标下标可能前移一位
    to = indexOf(toId);
    st.files.splice(after ? to + 1 : to, 0, item);
    return true;
  }

  function moveBy(id, delta) {
    var st = ITB.state;
    var i = indexOf(id);
    if (i < 0) return false;
    var j = i + delta;
    if (j < 0 || j >= st.files.length) return false;

    enterManual();

    var item = st.files.splice(i, 1)[0];
    st.files.splice(j, 0, item);
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
    st.sortMode = 'natural';
    st.sortOrder = 'asc';
    st.autoSortMode = 'natural';
    st.autoSortOrder = 'asc';
    st.sampleId = null;
    if (onChanged) onChanged();
  }

  /* ── 渲染 ───────────────────────────────────────────────── */

  /** 仅负责渲染文件池；数据变更后由调用方另行触发相应分区的刷新 */
  function render() {
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

    /* 每行显示该文件导出时的名称（**预览**，非单次执行结果）。
       该名称由 shellPlan() 的重命名结果叠加 formatExt() 的后缀变更构成；
       重命名与格式转换分属两个相互独立的分区，一次只执行其一，
       因此此处是两个分区分别作用于同一文件的结果，仅作对照展示。 */
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
      finalNames = Object.create(null);   // 参数错误时不显示，各分区另行提示
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
      attrs: { type: 'checkbox' },      props: { checked: item.selected }
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

    // 名称与元信息
    var main = U.el('div', { cls: 'pool-main', parent: row });
    var nameEl = U.el('div', { cls: 'pool-name', text: item.name, parent: main });
    var meta = (item.relPath ? item.relPath + ' · ' : '') +
      (item.measured ? item.width + '×' + item.height + ' · ' : '') +
      U.formatBytes(item.size);
    U.el('div', { cls: 'pool-meta', text: meta, parent: main });

    // 名称将发生变化的条目额外显示输出名称，优于仅在右栏查看前三条
    if (finalName) {
      U.el('div', { cls: 'pool-meta is-out', text: '→ ' + finalName, parent: main });
    }

    // 顺序号
    U.el('span', { cls: 'pool-seq', text: String(seq), parent: row });

    // 拖拽手柄
    U.el('span', { cls: 'pool-grip', text: '≡', parent: row, attrs: { title: '拖动调整顺序' } });

    // 点击该行即将其设为预览样本（改分辨率分区据此计算示例尺寸），
    // 同时把焦点交给列表，方向键便能立即调整这一行
    row.addEventListener('mousedown', function (e) {
      st.sampleId = item.id;
      if (e.button === 0 && e.target !== cb) {
        listEl.focus({ preventScroll: true });
      }
    });
    return row;
  }

  function makeThumb(item) {
    var cached = thumbCache[item.id];
    if (cached) {
      var clone = cloneCanvas(cached);
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
        if (!slot || !slot.parentNode) return;   // 已被重渲染移除

        var ready = cloneCanvas(canvas);
        ready.className = 'pool-thumb';
        ready.removeAttribute('data-thumb-for');

        var parent = slot.parentNode;
        parent.replaceChild(ready, slot);

        // 补充输出名称行（缩略图异步到达，整体重渲染时尚不可用）
        var outName = finalNameCache[item.id];
        var mainBox = parent.querySelector('.pool-main');
        if (outName && mainBox && !mainBox.querySelector('.pool-meta.is-out')) {
          U.el('div', { cls: 'pool-meta is-out', text: '→ ' + outName, parent: mainBox });
        }
      });
    }

    return ph;
  }

  /**
   * Canvas 的 cloneNode 只复制属性、不复制画布像素（Chrome 实测如此），
   * 因此用 drawImage 复制一份，否则缩略图与拖动预览会显示为空白。
   */
  function cloneCanvas(source) {
    var copy = document.createElement('canvas');
    copy.width = source.width;
    copy.height = source.height;
    copy.getContext('2d').drawImage(source, 0, 0);
    return copy;
  }

  function buildThumb(item) {
    return U.loadImageBitmap(item.file).then(function (bmp) {
      var canvas = drawContained(bmp, 36);
      if (typeof bmp.close === 'function') bmp.close();
      return canvas;
    }).catch(function () { return null; });
  }

  /** 把图片等比放进 size×size 的方框并居中，空余处填工具栏底色 */
  function drawContained(bmp, size) {
    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;

    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#101216';
    ctx.fillRect(0, 0, size, size);
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';

    var scale = Math.min(size / bmp.width, size / bmp.height);
    var w = Math.max(1, Math.round(bmp.width * scale));
    var h = Math.max(1, Math.round(bmp.height * scale));
    ctx.drawImage(bmp, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h);
    return canvas;
  }

  /** 拖动预览用的大图；同一文件只解码一次，LRU 限制缓存数量 */
  function getPreview(item) {
    if (previewCache[item.id]) return Promise.resolve(previewCache[item.id]);
    if (previewPending[item.id]) return previewPending[item.id];

    var task = U.loadImageBitmap(item.file).then(function (bmp) {
      var canvas = drawContained(bmp, 120);
      if (typeof bmp.close === 'function') bmp.close();
      rememberPreview(item.id, canvas);
      return canvas;
    }).catch(function () {
      return null;
    }).then(function (canvas) {
      delete previewPending[item.id];
      return canvas;
    });

    previewPending[item.id] = task;
    return task;
  }

  function rememberPreview(id, canvas) {
    previewCache[id] = canvas;
    previewQueue.push(id);
    while (previewQueue.length > PREVIEW_CACHE_LIMIT) {
      delete previewCache[previewQueue.shift()];
    }
  }

  function extTag(name) {
    var parts = U.splitExt(name);
    var ext = parts.ext.replace('.', '');
    return ext ? ext.slice(0, 4) : 'img';
  }

  function releaseThumbs() {
    thumbCache = Object.create(null);
    thumbPending = Object.create(null);
    previewCache = Object.create(null);
    previewPending = Object.create(null);
    previewQueue = [];
  }

  /* ── 拖拽排序 ───────────────────────────────────────────── */

  var dragId = null;
  var dropTarget = null;
  var dropAfter = false;
  var dragging = false;
  var dragStartX = 0;
  var dragStartY = 0;
  var ghostEl = null;
  var ghostFrame = null;
  var ghostW = 0;
  var ghostH = 0;

  // 按住手柄后先移动一小段才算拖动，避免单纯点击时误触发
  var DRAG_THRESHOLD = 4;

  function bindDrag() {
    listEl.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;

      var grip = e.target.closest ? e.target.closest('.pool-grip') : null;
      if (!grip) return;
      var row = grip.closest('.pool-item');
      if (!row) return;
      e.preventDefault();

      dragId = parseInt(row.dataset.id, 10);
      dragging = false;
      dropTarget = null;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
    });

    document.addEventListener('mousemove', function (e) {
      if (dragId === null) return;

      if (!dragging) {
        if (Math.abs(e.clientX - dragStartX) < DRAG_THRESHOLD &&
            Math.abs(e.clientY - dragStartY) < DRAG_THRESHOLD) return;

        dragging = true;
        var startRow = rowOf(dragId);
        if (startRow) startRow.classList.add('is-dragging');
        showGhost(dragId, e.clientX, e.clientY);
      }

      moveGhost(e.clientX, e.clientY);

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
      removeGhost();

      dragId = null;
      dropTarget = null;
      dragging = false;

      if (to !== null && to !== from && moveBefore(from, to, after)) {
        ITB.app.onOrderChanged();
      }
    });

    // 拖到一半按 Esc 或窗口失焦：取消本次拖动，顺序保持不变
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') cancelDrag();
    });
    window.addEventListener('blur', cancelDrag);
  }

  /** 拖动时跟随光标的放大预览：图片 + 文件名 + 原序号 */
  function showGhost(id, x, y) {
    removeGhost();

    var item = ITB.findFile(id);
    if (!item) return;

    var root = U.el('div', { cls: 'pool-drag-ghost', attrs: { 'aria-hidden': 'true' } });
    var frame = U.el('div', { cls: 'pool-drag-frame', parent: root });
    var seq = indexOf(id) + 1;
    if (seq > 0) U.el('span', { cls: 'pool-drag-seq', text: String(seq), parent: frame });

    // 先用缓存的小缩略图占位，避免等待大图解码时预览卡空白
    if (thumbCache[id]) {
      var small = cloneCanvas(thumbCache[id]);
      small.className = 'pool-drag-thumb';
      frame.appendChild(small);
    } else {
      U.el('span', { cls: 'pool-drag-ph', text: extTag(item.name), parent: frame });
    }

    U.el('div', { cls: 'pool-drag-name', text: item.name, parent: root });

    root.style.visibility = 'hidden';
    document.body.appendChild(root);
    ghostEl = root;
    ghostFrame = frame;
    ghostW = root.offsetWidth;
    ghostH = root.offsetHeight;
    moveGhost(x, y);
    root.style.visibility = '';

    getPreview(item).then(function (canvas) {
      if (!canvas || !ghostEl || ghostFrame !== frame || dragId !== id) return;
      if (!frame.parentNode) return;

      var ready = cloneCanvas(canvas);
      ready.className = 'pool-drag-thumb';
      var old = frame.querySelector('.pool-drag-thumb, .pool-drag-ph');
      if (old) frame.replaceChild(ready, old);
      else frame.appendChild(ready);
    });
  }

  function moveGhost(x, y) {
    if (!ghostEl) return;

    // 尺寸在创建时量一次即可，避免 mousemove 中反复触发布局计算
    var w = ghostW || ghostEl.offsetWidth;
    var h = ghostH || ghostEl.offsetHeight;
    var px = x + 18;
    var py = y + 18;

    // 靠近视口右/下边缘时翻到光标另一侧，始终完整可见
    if (px + w > window.innerWidth - 8) px = x - w - 18;
    if (py + h > window.innerHeight - 8) py = y - h - 18;
    if (px < 8) px = 8;
    if (py < 8) py = 8;

    ghostEl.style.transform = 'translate3d(' + px + 'px,' + py + 'px,0)';
  }

  function removeGhost() {
    if (ghostEl && ghostEl.parentNode) ghostEl.parentNode.removeChild(ghostEl);
    ghostEl = null;
    ghostFrame = null;
    ghostW = 0;
    ghostH = 0;
  }

  function cancelDrag() {
    if (dragId === null) return;

    clearDropMarks();
    var row = rowOf(dragId);
    if (row) row.classList.remove('is-dragging');
    listEl.classList.remove('is-dragover');
    removeGhost();

    dragId = null;
    dropTarget = null;
    dragging = false;
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
    setSort: setSort,
    resetOrder: resetOrder,
    moveBefore: moveBefore,
    moveBy: moveBy,
    setSelected: setSelected,
    setAllSelected: setAllSelected,
    invertSelection: invertSelection,
    removeAll: removeAll,
    render: render
  };

})(window.ITB);
