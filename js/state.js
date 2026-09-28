/* ============================================================
   state.js —— 全局状态
   全应用只有这一份可变状态，各分区和文件池都读写它。
   ============================================================ */

window.ITB = window.ITB || {};

(function (ITB) {
  'use strict';

  ITB.state = {
    /* 文件池。顺序就是导出顺序，也就是 PDF 页序和重命名编号顺序。
       四个分区共用这一批图——这只是「处理哪些图」，不是流水线。 */
    files: [],
    seq: 1,

    /* 界面配置 */
    sortMode: 'natural',        // 'natural' | 'lex'
    sortOrder: 'asc',           // 'asc' | 'desc'
    manualOrder: false,         // 是否手动拖过顺序（拖过就不再自动重排）
    baseOrder: [],              // 自动排序下的 id 顺序，用于「还原排序」

    /* 当前分区：'shell' | 'resize' | 'format' | 'pdf' */
    tab: 'shell',

    /* 预览用的样本文件 */
    sampleId: null,

    /* 运行状态 */
    busy: false,
    cancelRequested: false,

    /* 常量 */
    limits: {
      maxPreviewThumbs: 600,    // 缩略图最多给这么多张，避免上千张时卡
      warnCount: 100            // 超过这个数量给软警告
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

  /* 预览样本：优先用用户点过的那张，否则用第一张选中的 */
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
