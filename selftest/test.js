// 离线自检：不联网、不依赖构建工具
// 覆盖 0.2.0 的"容器 vs 段落"切分 + "插到元素内部"注入策略
(function () {
  'use strict';

  var DT = window.__DT;
  var results = [];

  function check(name, fn) {
    try {
      var out = fn();
      if (out === true) results.push({ name: name, ok: true, detail: '' });
      else results.push({ name: name, ok: false, detail: String(out) });
    } catch (err) {
      results.push({ name: name, ok: false, detail: '抛异常：' + ((err && err.message) || String(err)) });
    }
  }

  function eq(actual, expected) {
    var a = JSON.stringify(actual);
    var e = JSON.stringify(expected);
    return a === e ? true : '期望 ' + e + '，实际 ' + a;
  }

  function byText(list, needle) {
    return list.filter(function (u) {
      return u.text.indexOf(needle) >= 0;
    })[0];
  }

  // ---------------- 文本工具 ----------------
  check('skipText: 纯数字跳过', function () {
    return DT.skipText('1234567890') === true ? true : '应跳过';
  });

  check('skipText: 单字符跳过', function () {
    return DT.skipText('A') === true ? true : '1 字符应视为过短';
  });

  check('skipText: 正常英文保留', function () {
    return DT.skipText('Hello world') === false ? true : '不应跳过';
  });

  check('skipText: 纯标点跳过', function () {
    return DT.skipText('。，！？…') === true ? true : '应跳过';
  });

  check('looksLikeTarget: 纯中文', function () {
    return DT.looksLikeTarget('这是一个完整的中文句子，用于测试识别效果。', 'zh-CN') === true
      ? true
      : '应判定为目标语言';
  });

  check('looksLikeTarget: 纯英文', function () {
    return DT.looksLikeTarget('This is a normal English sentence for testing.', 'zh-CN') === false
      ? true
      : '不应判定为目标语言';
  });

  check('looksLikeTarget: 中英混排仍要翻译', function () {
    var text =
      "Arknight's Theresa skin for Greece Leopard 2a6HEL 今天带来的依旧是先为豹2A7V制作的特蕾西娅涂装的兼容";
    return DT.looksLikeTarget(text, 'zh-CN') === false ? true : '中英混排被判成已达标，会漏翻';
  });

  check('normalizeText: 折叠空白', function () {
    return eq(DT.normalizeText('  a \n\t b  '), 'a b');
  });

  check('splitLong: 短文本不拆分', function () {
    return eq(DT.splitLong('short text', 1200), ['short text']);
  });

  check('splitLong: 长文本按句子拆分且不丢内容', function () {
    var sentence = 'This is a sentence number one. ';
    var text = sentence.repeat(120);
    var parts = DT.splitLong(text, 300);
    if (parts.length < 2) return '应拆成多段，实际 ' + parts.length;
    var tooLong = parts.filter(function (p) {
      return p.length > 300 * 1.6 + 2;
    });
    if (tooLong.length) return '存在超长分段：' + tooLong[0].length;
    var joined = parts.join(' ').replace(/\s/g, '').length;
    var source = text.replace(/\s/g, '').length;
    if (joined < source * 0.98) return '内容丢失：' + joined + ' / ' + source;
    return true;
  });

  // ---------------- DOM 引擎 ----------------
  var fixture = document.getElementById('fx-root');
  var units = [];

  check('collect: 收集到全部 12 个单元', function () {
    units = DT.collect(fixture);
    return units.length === 12 ? true : '应为 12 个，实际 ' + units.length + '：' +
      JSON.stringify(units.map(function (u) { return u.text.slice(0, 14); }));
  });

  check('collect: 跳过 pre / translate=no / 隐藏元素', function () {
    var bad = units.filter(function (u) {
      return (
        u.text.indexOf('const a = 1') >= 0 ||
        u.text.indexOf('Do not translate') >= 0 ||
        u.text.indexOf('Hidden paragraph') >= 0
      );
    });
    if (bad.length) return '不该收集到：' + JSON.stringify(bad.map(function (u) { return u.text; }));
    return true;
  });

  check('skipText: 数字段落会被主流程过滤', function () {
    var numUnit = byText(units, '1234567890');
    if (!numUnit) return true;
    return DT.skipText(numUnit.text) === true ? true : '数字段没有被 skipText 过滤';
  });

  check('collect: 正文都在（标题 / 列表 / 表格）', function () {
    var need = ['Test heading for translation', 'List item one', 'Cell text here'];
    var missing = need.filter(function (n) {
      return !byText(units, n);
    });
    if (missing.length) return '缺少：' + JSON.stringify(missing);
    return true;
  });

  check('collect: 段落文本完整（含行内标签）', function () {
    var hit = byText(units, 'Second paragraph with');
    if (!hit) return '没找到目标段落';
    if (hit.text.indexOf('bold text') === -1 || hit.text.indexOf('link') === -1) {
      return '行内文本丢失：' + hit.text;
    }
    return true;
  });

  check('collect: 段落不因行内标签被拆碎', function () {
    var hits = units.filter(function (u) {
      return u.text.indexOf('Second paragraph') >= 0;
    });
    return hits.length === 1 ? true : '同一段落被拆成了 ' + hits.length + ' 个单元';
  });

  check('collect: flex 行拆成两个独立单元', function () {
    var flex = document.getElementById('fx-flex');
    var got = DT.collect(flex).map(function (u) {
      return u.text;
    });
    return eq(got, ['User Name', 'Added camouflage - 3 Oct, 07:51']);
  });

  // ---------------- 双语注入 ----------------
  check('inject: 译文插到源元素内部末尾', function () {
    var target = byText(units, 'This is the first paragraph');
    if (!target) return '没找到目标段落';
    var ok = DT.inject(target.el, '这是第一段。它有两句话。', 'zh-CN');
    if (!ok) return 'inject 返回 false';
    var node = target.el.querySelector('[data-dt-target]');
    if (!node) return '译文没有插到源元素内部';
    if (node.textContent !== '这是第一段。它有两句话。') return '译文内容不对：' + node.textContent;
    if (!target.el.hasAttribute('data-dt-src')) return '原文没有被标记';
    return true;
  });

  check('inject: 重复注入被拒绝', function () {
    var target = byText(units, 'This is the first paragraph');
    return DT.inject(target.el, '重复注入', 'zh-CN') === false ? true : '应该拒绝重复注入';
  });

  check('collect: 已翻译段落不再重复收集', function () {
    var again = DT.collect(fixture).filter(function (u) {
      return u.text.indexOf('This is the first paragraph') >= 0;
    });
    return again.length === 0 ? true : '已翻译段落被再次收集';
  });

  check('inject: li 内部追加，不破坏列表', function () {
    var li = fixture.querySelector('li');
    var u = units.filter(function (x) {
      return x.el === li;
    })[0];
    if (!u) return '没找到 li 单元';
    if (!DT.inject(u.el, '列表项一', 'zh-CN')) return 'inject 返回 false';
    return li.querySelector('[data-dt-target]') ? true : '译文没有进入 li 内部';
  });

  // ---------------- 排版继承 ----------------
  check('排版继承：标题译文不会变小变淡', function () {
    var h = document.getElementById('fx-heading');
    var u = DT.collect(h)[0];
    if (!u) return '没有收集到标题单元';
    if (!DT.inject(u.el, '带自有样式的标题', 'zh-CN')) return 'inject 返回 false';
    var node = h.querySelector('[data-dt-target]');
    if (!node) return '译文没有插进标题';
    if (node.style.fontSize !== '28px') return '字号没继承：' + node.style.fontSize;
    if (String(node.style.fontWeight) !== '700') return '字重没继承：' + node.style.fontWeight;
    if (node.style.color.indexOf('200') === -1) return '颜色没继承：' + node.style.color;
    return true;
  });

  // ---------------- 定位元素 / 仅译文 ----------------
  check('绝对定位：原地替换文本，不追加节点（避免溢出）', function () {
    var el = document.getElementById('fx-abs');
    var u = DT.collect(el)[0];
    if (!u) return '没有收集到绝对定位单元';
    if (!DT.inject(u.el, '绝对定位标签', 'zh-CN')) return 'inject 返回 false';
    if (el.querySelector('[data-dt-target]')) return '不该追加节点，应原地替换';
    return el.textContent.trim() === '绝对定位标签' ? true : '文本没被替换：' + el.textContent;
  });

  check('仅译文模式：原地替换文本节点', function () {
    var td = fixture.querySelector('td');
    var u = DT.collect(td)[0];
    if (!u) return '没有收集到表格单元';
    DT.state.mode = 'translation';
    var ok = DT.inject(u.el, '单元格文字', 'zh-CN');
    DT.state.mode = 'dual';
    if (!ok) return 'inject 返回 false';
    if (td.querySelector('[data-dt-target]')) return '仅译文模式不该追加节点';
    return td.textContent.trim() === '单元格文字' ? true : '文本没被替换：' + td.textContent;
  });

  // —— 回归用例：导航栏里的短标签必须原地替换 ——
  check('导航短标签：原地替换，不追加节点', function () {
    var span = document.querySelector('#fx-flex > span');
    if (!span) return '找不到夹具';
    var u = DT.collect(span)[0];
    if (!u) return '没有收集到该单元';
    if (!DT.inject(u.el, '用户名', 'zh-CN')) return 'inject 返回 false';
    if (span.querySelector('[data-dt-target]')) return '不该追加节点（会挤出格子）';
    return span.textContent.trim() === '用户名' ? true : '文本没被替换：' + span.textContent;
  });

  // —— 回归用例：正文不能被"替换"，必须保留原文 ——
  check('正文段落：追加双语，不替换原文', function () {
    var p = byText(units, 'Second paragraph with');
    if (!p) return '没找到目标段落';
    if (!DT.inject(p.el, '第二段，含粗体和链接。', 'zh-CN')) return 'inject 返回 false';
    var node = p.el.querySelector('[data-dt-target]');
    if (!node) return '正文应该是追加译文，不是替换';
    if (p.el.textContent.indexOf('Second paragraph with') === -1) return '原文被覆盖了';
    return true;
  });

  // ---------------- 还原 ----------------
  check('restore: 还原被就地替换的文本', function () {
    DT.restore();
    var td = fixture.querySelector('td');
    var abs = document.getElementById('fx-abs');
    var flexSpan = document.querySelector('#fx-flex > span');
    if (td.textContent.trim() !== 'Cell text here') return 'td 文本没还原：' + td.textContent;
    if (abs.textContent.trim() !== 'Absolute Label Text') return '绝对定位元素没还原';
    if (flexSpan.textContent.trim() !== 'User Name') return '导航项没还原：' + flexSpan.textContent;
    return true;
  });

  check('restore: 清空译文节点与标记', function () {
    var targets = fixture.querySelectorAll('[data-dt-target]');
    var sources = fixture.querySelectorAll('[data-dt-src]');
    if (targets.length) return '还有 ' + targets.length + ' 个译文节点';
    if (sources.length) return '还有 ' + sources.length + ' 个原文标记';
    return true;
  });

  check('restore 后可再次完整收集', function () {
    var again = DT.collect(fixture);
    return again.length === units.length
      ? true
      : '收集数量不一致：' + again.length + ' vs ' + units.length;
  });

  // ---------------- 渲染 ----------------
  var list = document.getElementById('list');
  var passed = 0;

  results.forEach(function (r) {
    if (r.ok) passed += 1;
    var li = document.createElement('li');
    var title = document.createElement('div');
    title.className = 'name';
    title.textContent = r.name;
    var state = document.createElement('span');
    state.className = r.ok ? 'ok' : 'no';
    state.textContent = r.ok ? ' PASS' : ' FAIL';
    title.appendChild(state);
    li.appendChild(title);
    if (r.detail) {
      var d = document.createElement('div');
      d.className = 'detail';
      d.textContent = r.detail;
      li.appendChild(d);
    }
    list.appendChild(li);
  });

  var summary = document.getElementById('summary');
  var allPass = passed === results.length;
  summary.className = allPass ? 'pass' : 'fail';
  summary.textContent = passed + ' / ' + results.length + (allPass ? '  全部通过' : '  存在失败项');
})();
