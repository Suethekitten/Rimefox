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

  // ---------------- 悬停对照（DT.hover） ----------------
  function hoverOn(el) {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  }
  function withHoverFixture(html, fn) {
    var box = document.createElement('div');
    box.innerHTML = html;
    document.getElementById('fixture').appendChild(box);
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

  check('悬停对照：双语单元的原文和译文同时高亮，移开取消', function () {
    return withHoverFixture('<p id="hv-a">Hover over <b>this</b> line</p><p id="hv-b">Not translated</p>', function (box) {
      var a = box.querySelector('#hv-a');
      if (!DT.inject(a, '悬停这一行', 'zh-CN')) return 'inject 返回 false';
      var target = a.querySelector('[data-dt-target]');
      hoverOn(a.querySelector('b')); // 鼠标在原文的行内元素上
      if (a.getAttribute('data-dt-hover') !== 'src' || target.getAttribute('data-dt-hover') !== 'target') {
        return '没有配对高亮：' + a.getAttribute('data-dt-hover') + ' / ' + target.getAttribute('data-dt-hover');
      }
      hoverOn(target); // 移到译文上：仍是同一对
      if (a.getAttribute('data-dt-hover') !== 'src') return '移到译文上高亮丢了';
      hoverOn(box.querySelector('#hv-b')); // 移到没翻译的段落
      if (a.hasAttribute('data-dt-hover') || target.hasAttribute('data-dt-hover')) return '移开后没取消高亮';
      DT.state.enabled = false;
      hoverOn(a);
      return a.hasAttribute('data-dt-hover') ? '翻译关闭时不该高亮' : true;
    });
  });

  check('悬停对照：原地替换的单元用 DT.replaced 的原值弹气泡', function () {
    return withHoverFixture('<button id="hv-btn">Sign in now</button><p id="hv-c">Elsewhere</p>', function (box) {
      var btn = box.querySelector('#hv-btn');
      if (!DT.inject(btn, '立即登录', 'zh-CN')) return 'inject 返回 false';
      if (!btn.hasAttribute('data-dt-replaced')) return '按钮应原地替换';
      hoverOn(btn);
      var tip = document.querySelector('.dt-hover-tip');
      if (!tip || tip.hidden) return '没有弹出原文气泡';
      if (tip.textContent !== 'Sign in now') return '气泡里不是原文：' + tip.textContent;
      if (btn.getAttribute('data-dt-hover') !== 'replaced') return '替换单元没有标记';
      hoverOn(box.querySelector('#hv-c'));
      return tip.hidden && !btn.hasAttribute('data-dt-hover') ? true : '移开后气泡没收起';
    });
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
