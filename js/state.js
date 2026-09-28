/* ============================================================
   state.js —— 全局状态
   全应用只有这一份可变状态，各分区和文件池都读写它。
   ============================================================ */

window.ITB = window.ITB || {};

(function (ITB) {
  'use strict';

  ITB.state = {
    /* 文件池。数组顺序即导出顺序，等同于 PDF 页序与重命名编号顺序。
       四个分区共用这一批图片，此处仅表示「处理哪些图」，无流水线语义。 */
    files: [],
    seq: 1,

    /* 界面配置 */
    sortMode: 'natural',        // 'natural' | 'lex'
    sortOrder: 'asc',           // 'asc' | 'desc'
    manualOrder: false,         // 是否已手动调整顺序（调整后不再自动重排）

    /* 当前分区：'shell' | 'resize' | 'format' | 'pdf' */
    tab: 'shell',

    /* 预览样本文件，供改分辨率分区计算示例目标尺寸。
       由文件池维护：点选图片时指向该图，键盘移动时同步更新。 */
    sampleId: null,

    /* 运行状态 */
    busy: false,
    cancelRequested: false,

    /* 常量 */
    limits: {
      maxPreviewThumbs: 600,    // 缩略图数量上限，避免大批量时渲染卡顿
      warnCount: 100            // 超过该数量时给出软警告
    }
  };

  /* ── 文件池查询 ─────────────────────────────────────────── */

  ITB.selectedFiles = function () {
    return ITB.state.files.filter(function (f) { return f.selected; });
  };

  ITB.findFile = function (id) {
    var list = ITB.state.files;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  };

  /* 预览样本：优先取用户点选的图片，否则取第一张已选中的图片 */
  ITB.sampleFile = function () {
    var st = ITB.state;
    if (st.sampleId) {
      var f = ITB.findFile(st.sampleId);
      if (f && f.selected) return f;
    }
    var sel = ITB.selectedFiles();
    return sel.length ? sel[0] : null;
  };

})(window.ITB);
