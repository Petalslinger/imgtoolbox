/* ============================================================
   rename.js —— 重命名规则引擎
   纯字符串运算，不碰像素，所以几百张图也能瞬时出预览。

   规则按固定顺序叠加，每一步都能单独关掉：
     1. 查找替换（可选正则、可选区分大小写）
     2. 加前缀 / 加后缀
     3. 追加编号（起始值 / 步长 / 补零位数 / 升序降序 / 位置 / 分隔符）
     4. 统一加固定后缀串（「文件名尾部」）
   ============================================================ */

window.ITB = window.ITB || {};

(function (ITB) {
  'use strict';

  var U = ITB.util;

  function defaultParams() {
    return {
      // 查找替换
      replaceOn: false,
      find: '',
      replaceWith: '',
      useRegex: false,
      caseSensitive: false,

      // 前后缀
      prefixOn: false,
      prefix: '',
      suffixOn: false,
      suffix: '',

      // 编号
      numberOn: false,
      startAt: 1,
      stepBy: 1,
      padTo: 3,
      numberOrder: 'asc',        // 'asc' | 'desc'
      numberPos: 'suffix',       // 'prefix' | 'suffix'
      numberSep: '_'
    };
  }

  function isDefault(p) {
    return !p.replaceOn && !p.prefixOn && !p.suffixOn && !p.numberOn;
  }

  /**
   * 把一个主名（不含扩展名）按规则变换。
   * @param {string} base      当前主名
   * @param {number} index     该文件在选中集合里的序号（从 0 开始）
   * @param {number} total     选中总数
   * @param {object} p         参数
   */
  function applyRules(base, index, total, p) {
    var name = base;

    /* 1. 查找替换 */
    if (p.replaceOn && p.find !== '') {
      if (p.useRegex) {
        try {
          var flags = 'g' + (p.caseSensitive ? '' : 'i');
          name = name.replace(new RegExp(p.find, flags), p.replaceWith);
        } catch (e) {
          // 正则写错了就先跳过这一步，界面上会另外标红提示
        }
      } else if (p.caseSensitive) {
        name = splitJoin(name, p.find, p.replaceWith);
      } else {
        name = splitJoinInsensitive(name, p.find, p.replaceWith);
      }
    }

    /* 2. 前后缀 */
    if (p.prefixOn && p.prefix) name = p.prefix + name;
    if (p.suffixOn && p.suffix) name = name + p.suffix;

    /* 3. 编号 */
    if (p.numberOn) {
      var start = num(p.startAt, 1);
      var step = num(p.stepBy, 1);
      var n;
      if (p.numberOrder === 'desc') {
        n = start + (total - 1 - index) * step;
      } else {
        n = start + index * step;
      }
      var width = Math.max(1, Math.min(12, num(p.padTo, 3)));
      var token = U.pad(n, width);
      var sep = p.numberSep || '';
      name = p.numberPos === 'prefix' ? token + sep + name : name + sep + token;
    }

    return name;
  }

  /* 用一个不会误伤替换结果的方式做字面量替换：
     先把匹配处换成占位符，最后统一填回，避免替换串里含查找串时无限套娃 */
  function splitJoin(name, find, repl) {
    var out = name.split(find);
    return out.join(repl);
  }

  function splitJoinInsensitive(name, find, repl) {
    if (!find) return name;
    var lowerName = name.toLowerCase();
    var lowerFind = find.toLowerCase();
    var out = '';
    var i = 0;

    while (true) {
      var at = lowerName.indexOf(lowerFind, i);
      if (at < 0) { out += name.slice(i); break; }
      out += name.slice(i, at) + repl;
      i = at + find.length;
    }
    return out;
  }

  function num(v, dflt) {
    var n = parseInt(v, 10);
    return isNaN(n) ? dflt : n;
  }

  /**
   * 批量算出 主名 → 新主名 的映射。
   * @param {Array} names 选中文件的主名数组，顺序即编号顺序
   * @returns {string[]}
   */
  function mapNames(names, p) {
    var out = [];
    for (var i = 0; i < names.length; i++) {
      out.push(applyRules(names[i], i, names.length, p));
    }
    return out;
  }

  /**
   * 冲突检测：重命名之后是否有两个文件叫同一个名字。
   * 纯下载模式下不会覆盖磁盘文件，但 ZIP 里重名会让条目互相顶掉，
   * 所以照样要拦住。
   * @returns {{ok: boolean, dups: string[]}}
   */
  function findDuplicates(finalNames) {
    var seen = Object.create(null);
    var dups = Object.create(null);

    for (var i = 0; i < finalNames.length; i++) {
      var key = String(finalNames[i]).toLowerCase();
      if (seen[key]) dups[finalNames[i]] = true;
      else seen[key] = true;
    }

    return { ok: Object.keys(dups).length === 0, dups: Object.keys(dups) };
  }

  /* ── 给步骤卡片用的一行摘要 ─────────────────────────────── */

  function summarize(p) {
    var bits = [];

    if (p.replaceOn && p.find) {
      bits.push('「' + clip(p.find) + '」→「' + clip(p.replaceWith) + '」' + (p.useRegex ? ' 正则' : ''));
    }
    if (p.prefixOn && p.prefix) bits.push('前缀 ' + clip(p.prefix));
    if (p.suffixOn && p.suffix) bits.push('后缀 ' + clip(p.suffix));
    if (p.numberOn) {
      var w = Math.max(1, Math.min(12, num(p.padTo, 3)));
      bits.push('编号 ' + U.pad(num(p.startAt, 1), w) +
        '起 步' + num(p.stepBy, 1) +
        ' 补' + w + '位' +
        (p.numberOrder === 'desc' ? ' 降序' : '') +
        (p.numberPos === 'prefix' ? ' 前置' : ' 后置'));
    }

    if (!bits.length) return '未设置规则（文件名不变）';
    return bits.join(' · ');
  }

  function clip(s) {
    s = String(s);
    return s.length > 14 ? s.slice(0, 13) + '…' : s;
  }

  ITB.rename = {
    defaultParams: defaultParams,
    isDefault: isDefault,
    applyRules: applyRules,
    mapNames: mapNames,
    findDuplicates: findDuplicates,
    summarize: summarize
  };

})(window.ITB);
