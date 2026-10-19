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

  check('looksLikeTarget: 日文（汉字多）不能判成中文', function () {
    var cases = ['進捗状況を確認します', '無料プランのご案内です', '９月進捗其一のまとめ'];
    var bad = cases.filter(function (t) {
      return DT.looksLikeTarget(t, 'zh-CN') !== false;
    });
    return bad.length ? '这些日文被判成中文了：' + JSON.stringify(bad) : true;
  });

  check('looksLikeTarget: 目标日语时中文不能被跳过', function () {
    return DT.looksLikeTarget('这是一个完整的中文句子，用于测试识别效果。', 'ja') === false
      ? true
      : '中文被判成"已是日语"，会漏翻';
  });

  check('looksLikeTarget: 目标韩语时中文不能被跳过', function () {
    return DT.looksLikeTarget('这是一个完整的中文句子，用于测试识别效果。', 'ko') === false
      ? true
      : '中文被判成"已是韩语"，会漏翻';
  });

  check('looksLikeTarget: 目标日语时带假名的日文应跳过', function () {
    return DT.looksLikeTarget('進捗状況を確認します。', 'ja') === true ? true : '应判为已是日语';
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

  // 13 = 标题 / 2 段正文 / 2 个 li / 数字段 / td / flex 两项 / 自带样式标题 / 固定导航两项 / 绝对定位
  check('collect: 收集到全部 13 个单元', function () {
    units = DT.collect(fixture);
    return units.length === 13 ? true : '应为 13 个，实际 ' + units.length + '：' +
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

  check('collect: 表单里的按钮单独成单元，不整块替换', function () {
    var units2 = DT.collect(document.getElementById('fx-form-row'));
    var formUnit = units2.some(function (u) {
      return u.el && u.el.id === 'fx-form';
    });
    if (formUnit) return '整个 FORM 被当成了单元';
    var joined = units2.map(function (u) {
      return u.text;
    }).join(' | ');
    if (/hide branch protection settings/i.test(joined)) return '隐藏对话框文案被拼进了单元：' + joined;
    var hasBtn = units2.some(function (u) {
      return u.el && u.el.id === 'fx-form-btn';
    });
    if (!hasBtn) return '按钮没有单独成单元：' + joined;
    return true;
  });

  check('collect: 隐藏子树不产出单元', function () {
    var hidden = DT.collect(document.getElementById('fx-hidden-only'));
    return hidden.length === 0 ? true : '隐藏元素不该产出单元，实际 ' + hidden.length;
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
    var cs = getComputedStyle(node);
    if (cs.fontSize !== '28px') return '字号没继承：' + cs.fontSize;
    if (String(cs.fontWeight) !== '700') return '字重没继承：' + cs.fontWeight;
    if (cs.color.indexOf('200') === -1) return '颜色没继承：' + cs.color;
    return true;
  });

  // ---------------- 特殊站点排版（Aeon 回归） ----------------
  check('CJK 排版归一化：大标题缩放 / 紧行高 / 拉丁文不处理', function () {
    if (!DT.hasCjk('中文') || !DT.hasCjk('日本語') || !DT.hasCjk('한국어')) return 'CJK 识别失败';
    if (DT.hasCjk('Natural philosophy')) return '英文不应被判成 CJK';
    var a = DT.translationLayout('自然哲学的回归', 72, 72, true, false);
    if (!a.heading || !a.tight) return '大标题应 heading + tight：' + JSON.stringify(a);
    var b = DT.translationLayout('Natural philosophy redux', 72, 72, true, false);
    if (b.heading || b.tight) return '英文不应被 CJK 规则处理';
    var c = DT.translationLayout('中文正文', 20, 28, false, false);
    if (c.heading || c.tight) return '正常行高正文不应 tight';
    var d = DT.translationLayout('中文正文', 20, 18, false, false);
    if (!d.tight) return '紧行高正文应 tight';
    var e = DT.translationLayout('中文', 72, 72, true, true);
    if (e.heading || e.tight) return '行内译文不做块级归一化';
    return true;
  });

  check('Aeon 大标题：CJK 译文 0.8em / 行高 1.25，并跟随原站响应式字号', function () {
    var h = document.getElementById('fx-aeon-title');
    var u = DT.collect(h)[0];
    if (!u) return '没有收集到 Aeon 标题';
    if (!DT.inject(u.el, '自然哲学的回归', 'zh-CN')) return 'inject 返回 false';
    var node = h.querySelector('[data-dt-target]');
    if (!node || !node.classList.contains('dt-cjk-heading')) return '缺少 dt-cjk-heading';
    var fs = parseFloat(getComputedStyle(node).fontSize);
    var lh = parseFloat(getComputedStyle(node).lineHeight);
    if (Math.abs(fs - 57.6) > 0.5) return '字号应为 0.8×72=57.6，实际 ' + fs;
    if (Math.abs(lh - 72) > 0.5) return '行高应为 57.6×1.25=72，实际 ' + lh;
    h.style.fontSize = '42px';
    h.style.lineHeight = '42px';
    var fs2 = parseFloat(getComputedStyle(node).fontSize);
    var lh2 = parseFloat(getComputedStyle(node).lineHeight);
    if (Math.abs(fs2 - 33.6) > 0.5) return '缩放后字号应为 0.8×42=33.6，实际 ' + fs2;
    if (Math.abs(lh2 - 42) > 0.5) return '缩放后行高应为 42，实际 ' + lh2;
    h.style.fontSize = '72px';
    h.style.lineHeight = '72px';
    return true;
  });

  check('首字下沉：原站 ::first-letter 不会放大译文首字', function () {
    var p = document.getElementById('fx-aeon-dropcap');
    var u = DT.collect(p)[0];
    if (!u) return '没有收集到首字下沉段落';
    if (!DT.inject(u.el, '这是一个用于测试首字下沉的中文译文。', 'zh-CN')) return 'inject 返回 false';
    var node = p.querySelector('[data-dt-target]');
    if (!node) return '译文没有插入';
    var tfs = parseFloat(getComputedStyle(node).fontSize);
    var tfl = parseFloat(getComputedStyle(node, '::first-letter').fontSize);
    if (Math.abs(tfl - tfs) > 0.5) return '译文首字被放大：' + tfl + ' vs ' + tfs;
    var pfs = parseFloat(getComputedStyle(p).fontSize);
    var pfl = parseFloat(getComputedStyle(p, '::first-letter').fontSize);
    if (pfl <= pfs * 2) return '原站首字下沉不应被破坏：' + pfl + ' vs ' + pfs;
    return true;
  });

  check('仅译文 + 首字下沉：整段译文不会被塞进下沉字母', function () {
    var p = document.getElementById('fx-aeon-dropcap-span');
    var prev = DT.state.mode;
    DT.state.mode = 'translation';
    try {
      var u = DT.collect(p)[0];
      if (!u) return '没有收集到首字下沉段落';
      if (!DT.inject(u.el, '牛顿的归纳主义方法论今天仍然伴随着我们。', 'zh-CN')) return 'inject 返回 false';
      var drop = p.querySelector('.ld-dropcap');
      if (!drop) return '下沉节点不见了';
      if (drop.textContent.length !== 1) return '整段译文被塞进下沉节点（' + drop.textContent.length + ' 字）';
      if (drop.textContent !== '牛') return '下沉节点应是译文首字，实际：' + drop.textContent;
      var bodyText = p.textContent.slice(drop.textContent.length);
      if (bodyText.indexOf('归纳主义') === -1) return '正文没有拿到剩余译文：' + bodyText.slice(0, 30);
      return true;
    } finally {
      DT.state.mode = prev;
    }
  });

  check('紧行高正文：CJK 译文行高至少 1.25', function () {
    var p = document.getElementById('fx-aeon-tight');
    var u = DT.collect(p)[0];
    if (!u) return '没有收集到紧行高段落';
    if (!DT.inject(u.el, '这是一个紧行高测试段落。', 'zh-CN')) return 'inject 返回 false';
    var node = p.querySelector('[data-dt-target]');
    if (!node || !node.classList.contains('dt-cjk-tight')) return '缺少 dt-cjk-tight';
    var lh = parseFloat(getComputedStyle(node).lineHeight);
    if (Math.abs(lh - 25) > 0.5) return '行高应为 20×1.25=25，实际 ' + lh;
    return true;
  });

  check('引用 / 粗体 / 斜体 / 链接：原文结构保留，译文追加在内部', function () {
    var q = document.getElementById('fx-aeon-quote');
    var u = DT.collect(q)[0];
    if (!u) return '没有收集到引用段落';
    if (!DT.inject(u.el, '引用里的中文译文。', 'zh-CN')) return 'inject 返回 false';
    var p = q.querySelector('p');
    if (!p) return '引用里没有 p';
    if (!p.querySelector('b') || !p.querySelector('i') || !p.querySelector('a')) return '原文行内结构被破坏';
    if (!p.querySelector('[data-dt-target]')) return '译文没有追加';
    return true;
  });

  check('窄容器：长译文保持 nowrap，不出现一字一行', function () {
    var el = document.getElementById('fx-narrow');
    var u = DT.collect(el)[0];
    if (!u) return '没有收集到窄容器单元';
    if (!DT.inject(u.el, '窄侧栏里的长译文不应该一个字一行。', 'zh-CN')) return 'inject 返回 false';
    var node = el.querySelector('[data-dt-target]');
    if (!node || !node.classList.contains('dt-narrow')) return '缺少 dt-narrow';
    if (getComputedStyle(node).whiteSpace !== 'nowrap') return 'white-space 被基础规则覆盖了';
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

  // ---------------- 0.4.2 回归用例 ----------------
  function onlyText(id) {
    var got = DT.collect(document.getElementById(id));
    return got.length === 1 ? got[0].text : '收集到 ' + got.length + ' 个单元';
  }

  check('<br> 分隔的两行不会粘成一个词', function () {
    return eq(onlyText('fx-br'), 'First line Second line');
  });

  check('行内 <code> 留在句子里，不被丢掉', function () {
    return eq(onlyText('fx-code'), 'Run npm install first.');
  });

  check('<script> 内容不进原文', function () {
    return eq(onlyText('fx-script'), 'Visible text');
  });

  check('链接里的 SVG 图标：title 不进原文，替换后文字仍可见', function () {
    var a = document.getElementById('fx-svg-link');
    var u = DT.collect(a)[0];
    if (!u) return '没有收集到链接';
    if (u.text !== 'Home page') return '原文混进了图标 title：' + u.text;
    if (!DT.inject(u.el, '首页', 'zh-CN')) return 'inject 返回 false';
    var title = a.querySelector('title').textContent;
    if (title !== 'Home icon') return '译文被写进了 svg title：' + title;
    if (a.textContent.indexOf('Home page') >= 0) return '可见原文没被替换：' + a.textContent;
    return a.textContent.indexOf('首页') >= 0 ? true : '链接可见文字丢失：' + a.textContent;
  });

  check('替换型元素被站点改写后：放回待翻译', function () {
    var btn = document.getElementById('fx-counter-a');
    var u = DT.collect(btn)[0];
    if (!u || !DT.inject(u.el, '计数 2', 'zh-CN')) return '注入失败';
    if (btn.textContent !== '计数 2') return '按钮应原地替换：' + btn.textContent;
    if (DT.releaseReplaced() !== 0) return '站点没改时不该放回';
    btn.firstChild.nodeValue = 'Count 3'; // 模拟 SPA 原地更新文本节点
    var released = DT.releaseReplaced();
    if (released !== 1) return '应放回 1 个，实际 ' + released;
    if (btn.hasAttribute('data-dt-src')) return '仍被标记为已翻译，新内容永远不会再翻';
    return eq(onlyText('fx-counter-a'), 'Count 3');
  });

  check('替换型元素被站点改写后：还原不拿旧原文覆盖新内容', function () {
    var btn = document.getElementById('fx-counter-b');
    var u = DT.collect(btn)[0];
    if (!u || !DT.inject(u.el, '计数 2', 'zh-CN')) return '注入失败';
    btn.firstChild.nodeValue = 'Count 3';
    DT.restore();
    return eq(btn.textContent, 'Count 3');
  });

  check('collect 过滤：不收的单元不占上限名额', function () {
    var got = DT.collect(fixture, function (u) {
      return u.text.indexOf('List item') === 0;
    });
    if (got.length !== 2) return '应只收到 2 个列表项，实际 ' + got.length;
    if (DT.lastCollectFull) return '没收满却标记成已满';
    return true;
  });

  check('自己写入的文本可被识别（观察器据此忽略）', function () {
    var btn = document.getElementById('fx-counter-b');
    var u = DT.collect(btn)[0];
    if (!u || !DT.inject(u.el, '计数 3', 'zh-CN')) return '注入失败';
    if (!DT.isOwnWrite(btn.firstChild)) return '我们写入的文本没被识别';
    btn.firstChild.nodeValue = 'Count 4';
    if (DT.isOwnWrite(btn.firstChild)) return '站点改写后仍被当成自己写的';
    DT.restore();
    return true;
  });

  // ---------------- 区域模型（DT.areaOf） ----------------
  function unitsIn(id) {
    return DT.collect(document.getElementById(id)).filter(function (u) {
      return !DT.skipText(u.text);
    });
  }

  function texts(list) {
    return list.map(function (u) {
      return u.text;
    });
  }

  check('GitHub 顶栏：行内 span 套在链接里 → 原地替换，高度不变，只出现一次文字', function () {
    var nav = document.getElementById('fx-gh-nav');
    var links = nav.querySelectorAll('a');
    // 顶栏宽度收到刚好放下原文：追加任何文字都会把条目挤成两行（真实 GitHub 顶栏就是这么满）
    var bar = nav.querySelector('ul');
    var natural = 0;
    Array.prototype.forEach.call(bar.children, function (li) {
      natural += li.getBoundingClientRect().width;
    });
    bar.style.width = Math.ceil(natural) + 2 + 'px';
    var before = Array.prototype.map.call(links, function (a) {
      return a.getBoundingClientRect().height;
    });
    var got = unitsIn('fx-gh-nav');
    var names = eq(texts(got), ['Code', 'Issues', 'Pull requests']);
    if (names !== true) return names;
    var zh = { Code: '代码', Issues: '议题', 'Pull requests': '拉取请求' };
    for (var i = 0; i < got.length; i += 1) {
      var area = DT.areaOf(got[i].el);
      if (area !== 'control') return got[i].text + ' 判成了 ' + area;
      if (!DT.inject(got[i].el, zh[got[i].text], 'zh-CN')) return got[i].text + ' inject 返回 false';
    }
    if (nav.querySelector('[data-dt-target]')) return '顶栏里不该追加译文节点';
    for (var k = 0; k < links.length; k += 1) {
      var h = links[k].getBoundingClientRect().height;
      if (Math.abs(h - before[k]) > 0.5) return '第 ' + (k + 1) + ' 项高度变了：' + before[k] + ' → ' + h;
    }
    var shown = DT.normalizeText(nav.textContent);
    if (/Code|Issues|Pull requests/.test(shown)) return '原文还在：' + shown;
    return shown.split('代码').length === 2 ? true : '译文出现次数不对：' + shown;
  });

  check('按钮里的行内 span 判为控件', function () {
    var hit = byText(unitsIn('fx-btn-span'), 'Save changes');
    if (!hit) return '没收集到按钮文字';
    return eq(DT.areaOf(hit.el), 'control');
  });

  check('长卡片链接：按正文追加，不被替换', function () {
    var card = document.getElementById('fx-card');
    var u = unitsIn('fx-card')[0];
    if (!u) return '没收集到卡片标题';
    var area = DT.areaOf(u.el);
    if (area !== 'content') return '判成了 ' + area;
    if (!DT.inject(u.el, '新版本发布', 'zh-CN')) return 'inject 返回 false';
    if (!u.el.querySelector('[data-dt-target]')) return '应该追加译文，不是替换';
    return card.textContent.indexOf('Introducing') >= 0 ? true : '原文被替换掉了';
  });

  check('链接里的标题仍按正文处理', function () {
    var u = unitsIn('fx-link-heading')[0];
    if (!u) return '没收集到标题';
    return eq(DT.areaOf(u.el), 'content');
  });

  check('正文段落里的行内子元素（OWID）：整段一个单元，不逐句插', function () {
    var p = document.getElementById('fx-inline-para');
    var got = unitsIn('fx-inline-para');
    if (got.length !== 1) {
      return '应收集到 1 个单元，实际 ' + got.length + '：' + JSON.stringify(texts(got).map(function (t) {
        return t.slice(0, 24);
      }));
    }
    if (got[0].el !== p) return '单元不是整个 <p>，而是 <' + got[0].el.tagName.toLowerCase() + '>';
    if (got[0].text.indexOf('Here, scaling means') < 0) return '缺第一句';
    if (got[0].text.indexOf('Just a few years ago') < 0) return '缺第二句';
    return true;
  });

  check('整页 flex 布局：标题与正文不被替换', function () {
    var got = unitsIn('fx-pageflex');
    var names = eq(texts(got), ['Patch notes', 'Read more about this update']);
    if (names !== true) return names;
    var bad = got.filter(function (u) {
      return DT.areaOf(u.el) !== 'content';
    });
    return bad.length ? '被判成界面文字：' + JSON.stringify(texts(bad)) : true;
  });

  check('role="tabpanel" 不是控件', function () {
    var u = unitsIn('fx-tabpanel')[0];
    if (!u) return '没收集到面板文字';
    return eq(DT.areaOf(u.el), 'content');
  });

  check('目录条目：按正文追加，不替换', function () {
    var u = byText(unitsIn('fx-toc'), 'Description');
    if (!u) return '没收集到目录条目';
    var area = DT.areaOf(u.el);
    if (area !== 'content') return '判成了 ' + area;
    if (!DT.inject(u.el, '1 描述', 'zh-CN')) return 'inject 返回 false';
    return u.el.querySelector('[data-dt-target]') ? true : '目录条目被替换了';
  });

  check('导航里折成多行的行内文字：不替换', function () {
    var u = byText(unitsIn('fx-nav-wrap'), 'This inline label');
    if (!u) return '没收集到导航文字';
    return eq(DT.areaOf(u.el), 'content');
  });

  DT.restore();

  // ---------------- YouTube 字幕（DT.subs） ----------------
  // 夹具的结构照抄真实 json3 回包（时间、aAppend 换行事件、tOffsetMs 逐词偏移），文字是自己写的
  var MANUAL = {
    events: [
      { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Good morning.' }] },
      { tStartMs: 3100, dDurationMs: 1800, segs: [{ utf8: 'This sentence is split' }] },
      { tStartMs: 4950, dDurationMs: 1500, segs: [{ utf8: 'across two cues.' }] },
      { tStartMs: 6500, dDurationMs: 1000, segs: [{ utf8: '[Music]' }] },
      { tStartMs: 7600, dDurationMs: 1000, segs: [{ utf8: 'No ending here' }] },
      { tStartMs: 11000, dDurationMs: 1000, segs: [{ utf8: 'so this starts fresh.' }] }
    ]
  };
  var ASR = {
    events: [
      { tStartMs: 0, dDurationMs: 1205280, id: 1, segs: [] },
      { tStartMs: 6260, dDurationMs: 3880, wWinId: 1, segs: [{ utf8: '[Music]' }] },
      { tStartMs: 26550, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] },
      { tStartMs: 26560, dDurationMs: 6400, wWinId: 1, segs: [{ utf8: 'good', acAsrConf: 0 }, { utf8: ' morning', tOffsetMs: 160 }] },
      { tStartMs: 28390, dDurationMs: 4570, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] },
      {
        tStartMs: 28400, dDurationMs: 6240, wWinId: 1,
        segs: [{ utf8: 'how' }, { utf8: ' are', tOffsetMs: 240 }, { utf8: ' you', tOffsetMs: 440 },
          { utf8: " it's", tOffsetMs: 2320 }, { utf8: ' been', tOffsetMs: 2480 }, { utf8: ' great', tOffsetMs: 2639 }]
      }
    ]
  };

  check('字幕：人工字幕按句末标点合并，[Music] 单独成句，隔太久不合并', function () {
    var units = DT.subs.unitsOf(MANUAL, 'https://www.youtube.com/api/timedtext?v=x&lang=en&fmt=json3');
    var r = eq(units.map(function (u) { return u.text; }), [
      'Good morning.', 'This sentence is split across two cues.', '[Music]', 'No ending here', 'so this starts fresh.'
    ]);
    if (r !== true) return r;
    if (!units[2].tag) return '[Music] 没被标成音效（会白白送去翻译）';
    return eq([units[1].start, units[1].end], [3100, 6450]);
  });

  check('字幕：自动生成字幕按停顿拼句，跳过换行事件', function () {
    var url = 'https://www.youtube.com/api/timedtext?v=x&lang=en&kind=asr&fmt=json3';
    if (!DT.subs.isAsr(ASR, url) || DT.subs.isAsr(MANUAL, '')) return 'isAsr 判断不对';
    var units = DT.subs.unitsOf(ASR, url);
    return eq(units.map(function (u) { return u.text; }), ['[Music]', 'good morning', 'how are you', "it's been great"]);
  });

  check('字幕：自动生成字幕的每句不会一直挂到下一句', function () {
    var units = DT.subs.unitsOf(ASR, 'https://www.youtube.com/api/timedtext?kind=asr');
    var gm = units[1];
    if (gm.end > 28400) return '"good morning" 结束于 ' + gm.end + '，盖住了下一句';
    return gm.end > gm.start ? true : '结束时间不对：' + gm.end;
  });

  check('字幕：自动生成字幕的短句遇到中等停顿不断开（避免一两个词一段）', function () {
    var words = [{ t: 0, text: 'so', end: 5000 }, { t: 900, text: 'yeah', end: 5000 }, { t: 1100, text: 'that', end: 5000 },
      { t: 1300, text: 'was', end: 5000 }, { t: 1500, text: 'interesting', end: 5000 }, { t: 3200, text: 'next', end: 5000 }];
    return eq(DT.subs.chunksOf(words).map(function (u) { return u.text; }), ['so yeah that was interesting', 'next']);
  });

  check('字幕：unitAt 二分查找命中与空档', function () {
    var units = DT.subs.unitsOf(MANUAL, '');
    return eq([1500, 3200, 6000, 6450, 9500, 11500].map(function (ms) { return DT.subs.unitAt(units, ms); }), [0, 1, 1, -1, -1, 4]);
  });

  check('字幕：句末 1.5s 内继续显示上一句', function () {
    var last = { start: 1000, end: 2000 };
    return DT.subs.shouldLinger(last, 2400, 1500) === true ? true : '应保留上一句';
  });

  check('字幕：超过 1.5s / 句末之前 / 没有上一句都不保留', function () {
    var last = { start: 1000, end: 2000 };
    var bad = [];
    if (DT.subs.shouldLinger(last, 3600, 1500)) bad.push('超过 1.5s');
    if (DT.subs.shouldLinger(last, 1500, 1500)) bad.push('句末之前');
    if (DT.subs.shouldLinger(null, 2500, 1500)) bad.push('没有上一句');
    return bad.length ? bad.join(' / ') : true;
  });

  check('字幕：机翻轨道去掉 tlang 拿原文；语言比较认 zh-Hans ≈ zh-CN', function () {
    var url = 'https://www.youtube.com/api/timedtext?v=abc&lang=en&kind=asr&pot=TOKEN&tlang=zh-Hans&fmt=json3';
    var p = DT.subs.paramsOf(url);
    if (p.tlang !== 'zh-Hans' || p.lang !== 'en' || p.v !== 'abc') return '参数解析不对：' + JSON.stringify(p);
    var src = DT.subs.withoutTlang(url);
    if (/tlang=/.test(src) || src.indexOf('pot=TOKEN') < 0 || src.indexOf('kind=asr') < 0) return '去 tlang 不对：' + src;
    var cases = [['zh-Hans', 'zh-CN', true], ['zh-Hant', 'zh-CN', false], ['zh-Hant', 'zh-TW', true], ['en-US', 'en', true], ['en', 'zh-CN', false]];
    var bad = cases.filter(function (c) { return DT.subs.sameLanguage(c[0], c[1]) !== c[2]; });
    return bad.length ? '语言比较错：' + JSON.stringify(bad) : true;
  });

  // ---------------- 调度纯函数（从 main.js 抽到 core.js） ----------------
  check('distanceOf: 屏幕内为 0', function () {
    var d = DT.distanceOf({ top: 100, bottom: 120, width: 300, height: 20 }, 800);
    return d === 0 ? true : '应为 0，实际 ' + d;
  });

  check('distanceOf: 上方按 2 倍权重', function () {
    var d = DT.distanceOf({ top: -200, bottom: -50, width: 300, height: 150 }, 800);
    return d === 100 ? true : '应为 100，实际 ' + d;
  });

  check('distanceOf: 下方按距离', function () {
    var d = DT.distanceOf({ top: 900, bottom: 940, width: 300, height: 40 }, 800);
    return d === 100 ? true : '应为 100，实际 ' + d;
  });

  check('distanceOf: 不在布局里给极大值', function () {
    var d = DT.distanceOf({ top: 0, bottom: 0, width: 0, height: 0 }, 800);
    return d >= 1e9 ? true : '零尺寸应排最后，实际 ' + d;
  });

  check('nearView: 上方 1 屏内算近', function () {
    var rect = { top: -700, bottom: -600, width: 300, height: 100 };
    return DT.nearView(rect, 800) === true ? true : '上方 1 屏内应算近';
  });

  check('nearView: 上方超过 1 屏算远', function () {
    var rect = { top: -900, bottom: -850, width: 300, height: 50 };
    return DT.nearView(rect, 800) === false ? true : '上方 900px 应算远';
  });

  check('nearView: 下方 2 屏内算近', function () {
    var rect = { top: 2300, bottom: 2400, width: 300, height: 100 };
    return DT.nearView(rect, 800) === true ? true : '2400 应在 800*(1+2) 之内';
  });

  check('nearView: 下方超过 2 屏算远', function () {
    var rect = { top: 2450, bottom: 2500, width: 300, height: 50 };
    return DT.nearView(rect, 800) === false ? true : '2500 已超出范围';
  });

  check('batchLimits: 屏幕内 3 条 / 500 字', function () {
    var l = DT.batchLimits(0, 800, 8, 2000);
    return l.items === 3 && l.chars === 500 ? true : '实际 ' + JSON.stringify(l);
  });

  check('batchLimits: 一屏以内中等批次', function () {
    var l = DT.batchLimits(400, 800, 8, 2000);
    return l.items === 8 && l.chars === 1000 ? true : '实际 ' + JSON.stringify(l);
  });

  check('batchLimits: 远处用满', function () {
    var l = DT.batchLimits(3000, 800, 8, 2000);
    return l.items === 8 && l.chars === 2000 ? true : '实际 ' + JSON.stringify(l);
  });

  check('batchLimits: 用户设置更小时不能撑大', function () {
    var l = DT.batchLimits(0, 800, 2, 300);
    return l.items === 2 && l.chars === 300 ? true : '应取用户更小的值：' + JSON.stringify(l);
  });

  check('nextRetry: 第一次失败等 5s', function () {
    var p = DT.nextRetry(null, 'abc', 1000);
    return p.count === 1 && p.delay === 5000 && p.until === 6000 ? true : JSON.stringify(p);
  });

  check('nextRetry: 同一段连续失败 15s / 45s', function () {
    var p1 = DT.nextRetry({ text: 'abc', count: 1 }, 'abc', 1000);
    var p2 = DT.nextRetry({ text: 'abc', count: 2 }, 'abc', 1000);
    return p1.delay === 15000 && p2.delay === 45000 ? true : JSON.stringify([p1, p2]);
  });

  check('nextRetry: 第四次放弃（0 延迟）', function () {
    var p = DT.nextRetry({ text: 'abc', count: 3 }, 'abc', 1000);
    return p.count === 4 && p.delay === 0 ? true : JSON.stringify(p);
  });

  check('nextRetry: 文本变了重新计数', function () {
    var p = DT.nextRetry({ text: 'old', count: 3 }, 'new', 1000);
    return p.count === 1 && p.delay === 5000 ? true : JSON.stringify(p);
  });

  check('joinSlots: 丢空段、空格连接', function () {
    var s = DT.joinSlots(['第一段', '', undefined, '第二段']);
    return s === '第一段 第二段' ? true : '实际 ' + JSON.stringify(s);
  });

  check('matchesHotkey: alt+a 命中', function () {
    var ev = { altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, key: 'a', code: 'KeyA' };
    return DT.matchesHotkey(ev, 'alt+a') === true ? true : '应命中';
  });

  check('matchesHotkey: 没按 Alt 不命中', function () {
    var ev = { altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, key: 'a', code: 'KeyA' };
    return DT.matchesHotkey(ev, 'alt+a') === false ? true : '不应命中';
  });

  check('matchesHotkey: 配置要 Shift 但没按', function () {
    var ev = { altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, key: 'a', code: 'KeyA' };
    return DT.matchesHotkey(ev, 'alt+shift+a') === false ? true : '不应命中';
  });

  check('matchesHotkey: 带了 Meta 一律不命中', function () {
    var ev = { altKey: true, ctrlKey: false, shiftKey: false, metaKey: true, key: 'a', code: 'KeyA' };
    return DT.matchesHotkey(ev, 'alt+a') === false ? true : 'Meta 存在时应拒绝';
  });

  check('matchesHotkey: macOS Option+A 退回物理键位', function () {
    var ev = { altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, key: 'å', code: 'KeyA' };
    return DT.matchesHotkey(ev, 'alt+a') === true ? true : '非 ASCII 时应按 code 兜底';
  });

  check('keyFromCode: 字母 / 数字 / 其它键', function () {
    return DT.keyFromCode('KeyA') === 'a' && DT.keyFromCode('Digit5') === '5' && DT.keyFromCode('F5') === ''
      ? true
      : '解析结果不对';
  });

  check('isEditableTarget: 输入框 / 文本域 / 下拉 / contenteditable 都要拦', function () {
    var input = document.createElement('input');
    var ta = document.createElement('textarea');
    var sel = document.createElement('select');
    var ce = document.createElement('div');
    ce.setAttribute('contenteditable', 'true');
    document.body.appendChild(ce);

    var plain = document.createElement('div');
    var bad = [];
    if (!DT.isEditableTarget(input)) bad.push('input');
    if (!DT.isEditableTarget(ta)) bad.push('textarea');
    if (!DT.isEditableTarget(sel)) bad.push('select');
    if (!DT.isEditableTarget(ce)) bad.push('contenteditable');
    if (DT.isEditableTarget(plain)) bad.push('普通 div 不该算');

    ce.remove();
    return bad.length ? bad.join(' / ') : true;
  });

  // ---------------- 近似重复闸门（DT.isNearDuplicate） ----------------
  check('近似重复：已是中文的提交信息只改了前缀 → 跳过', function () {
    var cases = [
      ['feat: v0.4.7 - 界面美化', '新功能: v0.4.7 - 界面美化'],
      ['revert: 撤回 CRX 打包，恢复 v0.4.7 的发布流程', '回退: 撤回 CRX 打包，恢复 v0.4.7 的发布流程'],
      ['完全一样的一句话', '完全一样的一句话']
    ];
    var bad = cases.filter(function (c) { return !DT.isNearDuplicate(c[0], c[1], 'zh-CN'); });
    if (bad.length) return '应判为重复：' + JSON.stringify(bad);
    return DT.similarity(cases[0][0], cases[0][1]) >= 0.75 ? true : '相似度算低了：' + DT.similarity(cases[0][0], cases[0][1]);
  });

  check('近似重复：正常译文不误杀（英文原文 / 原文+括注 / 日文原文）', function () {
    var cases = [
      ['Total 42 commits', '共 42 次提交'],
      ['Settings', '设置（Settings）'],
      ['東京の天気は晴れです', '东京的天气晴朗'],
      ['我们发布了 new version，欢迎 try it out', '我们发布了新版本，欢迎试用']
    ];
    var bad = cases.filter(function (c) { return DT.isNearDuplicate(c[0], c[1], 'zh-CN'); });
    return bad.length ? '被误判为重复：' + JSON.stringify(bad) : true;
  });

  // ---------------- 趣味翻译（DT.unitStyle） ----------------
  check('趣味翻译：只改写正文里够长的段落', function () {
    var long = 'This paragraph is long enough to be rewritten.';
    var cases = [
      [DT.unitStyle('classical', long, 'content'), 'classical'],
      [DT.unitStyle('catgirl', long, 'content'), 'catgirl'],
      [DT.unitStyle('catgirl', 'Short', 'content'), 'plain'],
      [DT.unitStyle('catgirl', long, 'control'), 'plain'],
      [DT.unitStyle('catgirl', long, 'chrome'), 'plain'],
      [DT.unitStyle('plain', long, 'content'), 'plain'],
      [DT.unitStyle('unknown', long, 'content'), 'plain']
    ];
    var bad = cases.filter(function (c) { return c[0] !== c[1]; });
    return bad.length ? '判断错：' + JSON.stringify(bad) : true;
  });

  // ---------------- 悬停对照（DT.hover，逐句） ----------------
  // 夹具放在视口里：caretRangeFromPoint 只能命中屏幕上的文字（#fixture 在屏幕外）
  function withHoverFixture(html, fn) {
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:0;top:0;width:640px;z-index:2147483000;background:#fff;font:16px/1.6 sans-serif;padding:8px';
    box.innerHTML = html;
    document.body.appendChild(box);
    var wasEnabled = DT.state.enabled;
    DT.state.enabled = true;
    try {
      return fn(box);
    } finally {
      DT.hover.clear();
      DT.restore();
      DT.state.enabled = wasEnabled;
      box.remove();
    }
  }
  // 文本节点里第一次出现 word 的位置中心
  function pointOf(textNode, word) {
    var i = textNode.nodeValue.indexOf(word);
    var r = document.createRange();
    r.setStart(textNode, i);
    r.setEnd(textNode, i + word.length);
    var rect = r.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }
  function highlighted(name) {
    var h = CSS.highlights.get(name);
    if (!h) return '';
    var out = [];
    h.forEach(function (range) { out.push(range.toString()); });
    return out.join('|');
  }

  check('悬停对照：句子切分与对齐（句数不同按相对位置）', function () {
    var text = 'First one. Version 3.5 is out! 第三句。第四句？';
    var parts = DT.hover.sentencesOf(text).map(function (s) { return text.slice(s[0], s[1]); });
    var r = eq(parts, ['First one.', 'Version 3.5 is out!', '第三句。', '第四句？']);
    if (r !== true) return r;
    var a = [[0, 10], [11, 20], [21, 30]];
    var b = [[0, 15], [16, 30]];
    var got = [0, 1, 2].map(function (i) { return DT.hover.alignSentence(a, 30, b, 30, i); });
    if (JSON.stringify(got) !== '[0,1,1]') return '按位置对齐不对：' + JSON.stringify(got);
    return DT.hover.alignSentence(a, 30, a, 30, 2) === 2 ? true : '句数相同应按序号';
  });

  check('悬停对照：鼠标在第二句上，只高亮这一句原文和对应译文', function () {
    if (!window.Highlight || !CSS.highlights) return true; // 老浏览器走整段高亮的退路
    return withHoverFixture('<p id="hv-a">First sentence here. Second sentence follows. Third one ends.</p><p id="hv-b">Not translated</p>', function (box) {
      var a = box.querySelector('#hv-a');
      var srcText = a.firstChild;
      if (!DT.inject(a, '第一句在这里。第二句跟着来。第三句结束。', 'zh-CN')) return 'inject 返回 false';
      var target = a.querySelector('[data-dt-target]');
      var p = pointOf(srcText, 'Second');
      a.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: p.x, clientY: p.y }));
      if (highlighted('dt-hover-src') !== 'Second sentence follows.') return '原文高亮的不是这一句：' + highlighted('dt-hover-src');
      if (highlighted('dt-hover-target') !== '第二句跟着来。') return '译文高亮的不是对应句：' + highlighted('dt-hover-target');
      if (a.hasAttribute('data-dt-hover')) return '不该再整段高亮';
      p = pointOf(target.firstChild, '第三句');
      DT.hover.updateAt(p.x, p.y, target); // 鼠标移到译文的第三句
      if (highlighted('dt-hover-src') !== 'Third one ends.' || highlighted('dt-hover-target') !== '第三句结束。') {
        return '移到译文上没对上：' + highlighted('dt-hover-src') + ' / ' + highlighted('dt-hover-target');
      }
      var b = box.querySelector('#hv-b');
      p = pointOf(b.firstChild, 'Not');
      DT.hover.updateAt(p.x, p.y, b); // 移到没翻译的段落
      if (highlighted('dt-hover-src') || highlighted('dt-hover-target')) return '移开后高亮没取消';
      DT.state.enabled = false;
      p = pointOf(srcText, 'First');
      DT.hover.updateAt(p.x, p.y, a);
      return highlighted('dt-hover-src') ? '翻译关闭时不该高亮' : true;
    });
  });

  check('悬停对照：原地替换的单元，气泡只显示鼠标所在这句的原文', function () {
    if (!window.Highlight || !CSS.highlights) return true;
    return withHoverFixture('<button id="hv-btn">Sign in now. Then continue.</button><p id="hv-c">Elsewhere</p>', function (box) {
      var btn = box.querySelector('#hv-btn');
      if (!DT.inject(btn, '立即登录。然后继续。', 'zh-CN')) return 'inject 返回 false';
      if (!btn.hasAttribute('data-dt-replaced')) return '按钮应原地替换';
      var p = pointOf(btn.firstChild, '然后');
      DT.hover.updateAt(p.x, p.y, btn);
      var tip = document.querySelector('.dt-hover-tip');
      if (!tip || tip.hidden) return '没有弹出原文气泡';
      if (tip.textContent !== 'Then continue.') return '气泡里不是这一句原文：' + tip.textContent;
      if (highlighted('dt-hover-target') !== '然后继续。') return '页面上高亮的不是鼠标下这句：' + highlighted('dt-hover-target');
      var c = box.querySelector('#hv-c');
      p = pointOf(c.firstChild, 'Else');
      DT.hover.updateAt(p.x, p.y, c);
      return tip.hidden && !highlighted('dt-hover-target') ? true : '移开后气泡 / 高亮没收起';
    });
  });

  // ---------------- 站点规则（DT.setSiteRule） ----------------
  function siteFixture(html, fn) {
    var box = document.createElement('div');
    box.innerHTML = html;
    document.getElementById('fixture').appendChild(box);
    try {
      return fn(box);
    } finally {
      DT.setSiteRule(null);
      box.remove();
    }
  }

  check('站点规则：排除区域不收集，写错的选择器单独忽略', function () {
    return siteFixture('<div id="sr-a"><p>Keep this paragraph please.</p><p class="sr-skip">Skip this paragraph please.</p></div>', function (box) {
      DT.setSiteRule({ excludeSelectors: ['.sr-skip', 'p[[[bad'], textSelectors: [] });
      var got = DT.collect(box.querySelector('#sr-a')).map(function (u) { return u.text; });
      return eq(got, ['Keep this paragraph please.']);
    });
  });

  check('站点规则：只翻指定区域，嵌套的只留最外层', function () {
    return siteFixture('<div id="sr-b"><article class="sr-main"><p class="sr-main">Inside article.</p></article><aside>Outside text here.</aside></div>', function (box) {
      DT.setSiteRule({ textSelectors: ['.sr-main'], excludeSelectors: [] });
      var roots = DT.collectRoots();
      if (roots.length !== 1 || roots[0].tagName !== 'ARTICLE') return '根不对：' + roots.map(function (r) { return r.tagName; }).join(',');
      var texts = DT.collectAll().map(function (u) { return u.text; });
      if (texts.indexOf('Outside text here.') >= 0) return '指定区域外的文字也被收集了';
      DT.setSiteRule(null);
      return DT.collectRoots()[0] === document.body ? true : '清掉规则后应回到整个 body';
    });
  });

  // ---------------- 网页外观（content/appearance.js） ----------------
  check('外观：强调色 / 排版 / 自定义 CSS 写到 <html> 上，清掉后恢复', function () {
    var root = document.documentElement;
    DT.emitConfig({ pageDarkAdapt: true, page: { accent: '#0e9384', typo: { '--dt-font-scale': '1.2', '--dt-line-height': 'inherit', '--dt-gap': '0.6em', '--dt-indent': '0' }, customCss: 'color: #555', night: false } });
    var style = document.getElementById('dt-custom-css');
    var r = true;
    if (root.style.getPropertyValue('--dt-accent') !== '#0e9384') r = '强调色没写上';
    else if (root.getAttribute('data-dt-typo') !== 'on' || root.style.getPropertyValue('--dt-font-scale') !== '1.2') r = '排版变量没写上';
    else if (!style || style.textContent !== 'html[data-dt="on"] .dt-target{color: #555}') r = '自定义 CSS 没包进作用域：' + (style && style.textContent);
    DT.emitConfig({ pageDarkAdapt: true, page: {} });
    if (r !== true) return r;
    if (root.style.getPropertyValue('--dt-accent') || root.hasAttribute('data-dt-typo') || document.getElementById('dt-custom-css')) return '清掉后没恢复';
    return true;
  });

  check('外观：按页面背景判断明暗，夜间模式下不再判断', function () {
    var body = document.body;
    var old = body.style.backgroundColor;
    body.style.backgroundColor = 'rgb(18, 18, 20)';
    var dark = DT.pageScheme();
    body.style.backgroundColor = 'rgb(250, 250, 250)';
    var light = DT.pageScheme();
    body.style.backgroundColor = old;
    if (dark !== 'dark' || light !== 'light') return '判断错：' + dark + ' / ' + light;
    DT.emitConfig({ pageDarkAdapt: true, page: { night: true } });
    var night = document.documentElement.hasAttribute('data-dt-scheme');
    var nightOn = document.documentElement.getAttribute('data-dt-night') === 'on';
    DT.emitConfig({ pageDarkAdapt: true, page: {} });
    if (!nightOn) return '夜间模式没打开';
    return night ? '夜间模式下不该再判断明暗（页面已经反色）' : true;
  });

  // ---------------- 悬浮入口 ----------------
  // 和运行时一样：先放进 DT.state.config 再通知（main.js 的 loadConfig 就是这个顺序）
  function emitConfig(cfg) {
    DT.state.config = cfg;
    DT.emitConfig(cfg);
  }
  check('悬浮入口：默认不显示，打开后挂在网页边上（Shadow DOM，带 data-dt-ui）', function () {
    emitConfig({ page: {} });
    if (document.getElementById('dt-dock')) return '默认关闭时不该出现';
    emitConfig({ dockEnabled: true, page: { provider: 'DeepSeek · deepseek-chat' } });
    var host = DT.dock.host();
    if (!host || !host.isConnected) return '没有挂到页面上';
    if (host.getAttribute('data-dt-ui') !== '1') return '缺 data-dt-ui，会被当成正文切分';
    if (host.shadowRoot) return 'shadow 应该是 closed';
    var acts = [].map.call(DT.dock.root().querySelectorAll('button'), function (b) {
      return b.dataset.act;
    });
    return eq(acts, ['toggle', 'mode', 'selection', 'pin', 'provider', 'ball']);
  });

  check('悬浮入口：左右位置、自动隐藏、界面语言跟着配置走', function () {
    emitConfig({ dockEnabled: true, dockSide: 'left', dockAutoHide: false, uiLang: 'en', page: { provider: 'Gemini · flash' } });
    var host = DT.dock.host();
    var root = DT.dock.root();
    var dock = root.querySelector('.dock');
    var provider = root.querySelector('[data-act="provider"]').getAttribute('aria-label');
    var toggle = root.querySelector('[data-act="toggle"]').getAttribute('aria-label');
    DT.state.config = null;
    if (host.getAttribute('data-side') !== 'left') return '没切到左侧';
    if (dock.hasAttribute('data-auto')) return '关掉自动隐藏后不该半藏';
    if (toggle !== 'Translate this page') return '英文界面的说明不对：' + toggle;
    return provider === 'Current provider: Gemini · flash' ? true : '服务商说明不对：' + provider;
  });

  check('悬浮入口：收起时只有小球接收鼠标，看不见的面板不挡网页', function () {
    emitConfig({ dockEnabled: true, dockAutoHide: true, page: {} });
    var root = DT.dock.root();
    var panel = root.querySelector('.panel');
    var ball = root.querySelector('.ball');
    var closedPanel = getComputedStyle(panel).pointerEvents;
    var hostPe = getComputedStyle(DT.dock.host()).pointerEvents;
    DT.dock.setOpen(true);
    var openPanel = getComputedStyle(panel).pointerEvents;
    DT.dock.setOpen(false);
    return eq([hostPe, closedPanel, getComputedStyle(ball).pointerEvents, openPanel], ['none', 'none', 'auto', 'auto']);
  });

  check('悬浮入口：关掉后从页面上移除', function () {
    emitConfig({ dockEnabled: false, page: {} });
    DT.state.config = null;
    return document.getElementById('dt-dock') ? '关掉后还在' : true;
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
