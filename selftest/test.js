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

  // 需要真实时间（计时器、异步滚动事件）的用例：先排队，等所有同步用例跑完再逐个执行，
  // 避免挂在屏幕上的夹具挡住后面按坐标取字的同步用例。fn 返回 Promise，resolve 成 true 或失败说明；
  // 3 秒没结果算失败（CI 的 --virtual-time-budget 会快进计时器）
  var asyncChecks = [];
  function checkAsync(name, fn) {
    var slot = results.length;
    results.push({ name: name, ok: false, detail: '没有执行' });
    asyncChecks.push(function () {
      var timer;
      var timeout = new Promise(function (resolve) {
        timer = setTimeout(function () {
          resolve('超时（3 秒没有结果）');
        }, 3000);
      });
      var run;
      try {
        run = Promise.resolve(fn());
      } catch (err) {
        run = Promise.resolve('抛异常：' + ((err && err.message) || String(err)));
      }
      return Promise.race([run, timeout])
        .catch(function (err) {
          return '抛异常：' + ((err && err.message) || String(err));
        })
        .then(function (out) {
          clearTimeout(timer);
          results[slot] = out === true ? { name: name, ok: true, detail: '' } : { name: name, ok: false, detail: String(out) };
        });
    });
  }
  function wait(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
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

  check('looksLikeTarget: 简体 / 繁体不算同一种目标语言', function () {
    var hans = '这是一个完整的中文句子，用于测试识别效果。';
    var hant = '這是一個完整的中文句子，用於測試識別效果。';
    return eq(
      [
        DT.looksLikeTarget(hans, 'zh-TW'),
        DT.looksLikeTarget(hant, 'zh-TW'),
        DT.looksLikeTarget(hant, 'zh-CN'),
        DT.looksLikeTarget(hans, 'zh-CN'),
        DT.looksLikeTarget('人工智能研究所', 'zh-TW'), // 两边写法相同的字：看不出来，按已是目标语言
        DT.chineseScript(hans),
        DT.chineseScript(hant)
      ],
      [false, true, false, true, true, 'hans', 'hant']
    );
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
  check('整块早退不会漏掉后来显示的隐藏段落', function () {
    var box = document.createElement('div');
    box.innerHTML = '<p>Visible paragraph before hidden dialog.</p><div id="dt-hidden-probe" style="display:none"><p>Hidden paragraph that appears later.</p></div>';
    document.body.appendChild(box);
    var visible = DT.collect(box);
    if (!visible.length) { box.remove(); return '可见段没有收集到'; }
    DT.state.mode = 'dual';
    if (!DT.inject(visible[0], '可见段译文', 'zh-CN')) { box.remove(); return '可见段注入失败'; }
    box.querySelector('#dt-hidden-probe').style.display = 'block';
    var after = DT.collect(box);
    var ok = after.some(function (u) { return u.text.indexOf('Hidden paragraph') >= 0; });
    DT.restore();
    box.remove();
    return ok ? true : '隐藏段显示后没有被重新收集';
  });

  check('pruneDetached: 页面删除的节点会被释放，不拖到 restore', function () {
    var host = document.createElement('div');
    host.innerHTML = '<p>Detached paragraph stays out of the live tree.</p>';
    document.body.appendChild(host);
    var u = DT.collect(host)[0];
    if (!u) { host.remove(); return '没有收集到单元'; }
    DT.state.mode = 'dual';
    if (!DT.inject(u, '已脱离页面的译文', 'zh-CN')) { host.remove(); return 'inject 返回 false'; }
    host.remove();
    var removed = DT.pruneDetached();
    if (removed < 1) return '没有释放已脱离页面的记录';
    return true;
  });

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

  check('<br> 分隔的两行不会粘成一个词（0.8.4 起按换行送翻）', function () {
    return eq(onlyText('fx-br'), 'First line\nSecond line');
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

  check('近似重复：简体转繁体的译文不当成重复丢掉', function () {
    var src = '这是一个测试段落，内容很普通，说明这个问题。';
    var out = '這是一個測試段落，內容很普通，說明這個問題。';
    if (DT.isNearDuplicate(src, out, 'zh-TW')) return '简繁转换被当成近似重复丢掉了';
    return DT.isNearDuplicate(out, out, 'zh-TW') ? true : '完全相同仍应判为重复';
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
  function withHoverFixture(html, fn, extraStyle) {
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:0;top:0;width:640px;z-index:2147483000;background:#fff;font:16px/1.6 sans-serif;padding:8px' + (extraStyle ? ';' + extraStyle : '');
    box.innerHTML = html;
    document.body.appendChild(box);
    var wasEnabled = DT.state.enabled;
    var prevDt = document.documentElement.getAttribute('data-dt');
    DT.state.enabled = true;
    document.documentElement.setAttribute('data-dt', 'on');
    try {
      return fn(box);
    } finally {
      DT.hover.clear();
      DT.restore();
      DT.state.enabled = wasEnabled;
      if (prevDt === null) document.documentElement.removeAttribute('data-dt');
      else document.documentElement.setAttribute('data-dt', prevDt);
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

  check('悬停对照：句子切分 + 结构化对齐校验（不按长度 / 句界比例猜）', function () {
    var text = 'First one. Version 3.5 is out! 第三句。第四句？';
    var parts = DT.hover.sentencesOf(text).map(function (s) { return text.slice(s[0], s[1]); });
    var r = eq(parts, ['First one.', 'Version 3.5 is out!', '第三句。', '第四句？']);
    if (r !== true) return r;
    var target = '第一句。3.5 版出了！第三句。第四句？';
    var ok = DT.units.alignmentOf([{ n: 1, t: '第一句。' }, { n: 1, t: '3.5 版出了！' }, { n: 1, t: '第三句。' }, { n: 1, t: '第四句？' }], target, 4);
    if (!ok || !ok.reliable) return '合法的一一对应没有被接受';
    if (DT.units.partAt(ok, 2).srcFrom !== 2) return '第 3 句的源范围不对';
    if (DT.units.alignmentOf([{ n: 1, t: '第一句。' }, { n: 1, t: '第二句。' }], target, 4)) return 'n 总和不够也算对齐';
    if (DT.units.alignmentOf([{ n: 1, t: '译文里没有这句' }], target, 1)) return '片段不在译文里也算对齐';
    var merged = DT.units.alignmentOf([{ n: 2, t: '第一句。3.5 版出了！' }, { n: 1, t: '第三句。' }, { n: 1, t: '第四句？' }], target, 4);
    if (!merged || merged.parts[0].srcTo !== 2) return '多源一译（n=2）没有正确覆盖';
    return true;
  });

  check('悬停对照：鼠标在第二句上，只高亮这一句原文和对应译文', function () {
    if (!window.Highlight || !CSS.highlights) return true; // 老浏览器走整段高亮的退路
    return withHoverFixture('<p id="hv-a">First sentence here. Second sentence follows. Third one ends.</p><p id="hv-b">Not translated</p>', function (box) {
      var a = box.querySelector('#hv-a');
      var srcText = a.firstChild;
      var targetText = '第一句在这里。第二句跟着来。第三句结束。';
      var align = DT.units.alignmentOf(
        [{ n: 1, t: '第一句在这里。' }, { n: 1, t: '第二句跟着来。' }, { n: 1, t: '第三句结束。' }],
        targetText,
        3
      );
      if (!DT.inject(a, targetText, 'zh-CN', align)) return 'inject 返回 false';
      var target = a.querySelector('[data-dt-target]');
      var p = pointOf(srcText, 'Second');
      a.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: p.x, clientY: p.y }));
      DT.hover.flushMove();
      if (highlighted('dt-hover-src') !== 'Second sentence follows.') return '原文高亮的不是这一句：' + highlighted('dt-hover-src');
      if (highlighted('dt-hover-target') !== '第二句跟着来。') return '译文高亮的不是对应句：' + highlighted('dt-hover-target');
      if (a.hasAttribute('data-dt-hover')) return '不该再整段高亮';
      // 双语：原文和译文都在页面上，只高亮，不弹气泡（0.9.1 的气泡会挡住下面的正文）
      var tip = document.querySelector('.dt-hover-tip');
      if (tip && !tip.hidden) return '双语模式不该弹气泡：' + tip.textContent;
      p = pointOf(target.firstChild, '第三句');
      DT.hover.updateAt(p.x, p.y, target); // 鼠标移到译文的第三句
      if (highlighted('dt-hover-src') !== 'Third one ends.' || highlighted('dt-hover-target') !== '第三句结束。') {
        return '移到译文上没对上：' + highlighted('dt-hover-src') + ' / ' + highlighted('dt-hover-target');
      }
      tip = document.querySelector('.dt-hover-tip');
      if (tip && !tip.hidden) return '双语模式译文上也不该弹气泡';
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

  check('悬停对照·双语没有模型对齐（旧缓存 / 后台重启）：本地对齐照样逐句高亮，不退回整段、不弹气泡', function () {
    if (!window.Highlight || !CSS.highlights) return true;
    // 真实页面形状（Our World in Data）：脚注号 <sup>11</sup> 紧跟句号，译文把脚注号放到下一句开头
    var html =
      '<p id="hv-owid">The 9 charts show the data for different regions in the world. On the horizontal axis of each chart, you find the average income (GDP per capita) and on the vertical axis you see the share living in extreme poverty. ' +
      'The starting point of each trajectory shows the data for 1820 and it tells us that two centuries ago the majority of people lived in extreme poverty, no matter where in the world they were at home.<sup>11</sup> ' +
      'Since then, all world regions achieved growth – the production of goods and services increased – and the share living in poverty declined.</p>';
    return withHoverFixture(html, function (box) {
      var el = box.querySelector('#hv-owid');
      var targetText =
        '这9张图表展示了世界不同地区的数据。每张图表的横轴是平均收入（人均GDP），纵轴是生活在极端贫困中的人口比例。' +
        '每条轨迹的起点显示的是1820年的数据，它告诉我们，两个世纪前，无论人们身处世界何处，大多数人都生活在极端贫困之中。' +
        '11 自那时起，世界所有地区都实现了增长——商品和服务的生产增加了——生活在贫困中的人口比例下降了。';
      if (!DT.inject(el, targetText, 'zh-CN')) return 'inject 返回 false';
      var unit = DT.unitOfNode(el.firstChild);
      if (!unit || unit.align) return '夹具应没有模型对齐';
      if (unit.sentences.length !== 4) return '原文应切成 4 句（home.11 后断开）：' + unit.sentences.length;
      var p = pointOf(el.firstChild, 'starting point');
      DT.hover.updateAt(p.x, p.y, el);
      var src = highlighted('dt-hover-src');
      var tgt = highlighted('dt-hover-target');
      // 第三句一直到脚注号（Range 末端落在 <sup> 里）
      if (src.indexOf('The starting point') !== 0 || src.slice(-7) !== 'home.11') return '原文高亮的不是第三句：' + src;
      if (tgt.indexOf('每条轨迹') !== 0 || tgt.slice(-1) !== '。' || tgt.indexOf('自那时起') >= 0) return '译文高亮的不是对应句：' + tgt;
      var tip = document.querySelector('.dt-hover-tip');
      if (tip && !tip.hidden) return '双语模式不该弹「行级对应」气泡';
      // 译文上：第四句（含被挪到句首的脚注号）对回原文第四句
      var t = el.querySelector('[data-dt-target]').firstChild;
      p = pointOf(t, '自那时起');
      DT.hover.updateAt(p.x, p.y, t.parentElement);
      src = highlighted('dt-hover-src');
      if (src.indexOf('Since then') !== 0) return '译文第四句没有对回原文第四句：' + src;
      return true;
    });
  });

  check('悬停对照：原地替换的单元，气泡只显示鼠标所在这句的原文', function () {
    if (!window.Highlight || !CSS.highlights) return true;
    return withHoverFixture('<button id="hv-btn">Sign in now. Then continue.</button><p id="hv-c">Elsewhere</p>', function (box) {
      var btn = box.querySelector('#hv-btn');
      var targetText = '立即登录。然后继续。';
      var align = DT.units.alignmentOf([{ n: 1, t: '立即登录。' }, { n: 1, t: '然后继续。' }], targetText, 2);
      if (!DT.inject(btn, targetText, 'zh-CN', align)) return 'inject 返回 false';
      if (!btn.hasAttribute('data-dt-replaced')) return '按钮应原地替换';
      var p = pointOf(btn.firstChild, '然后');
      DT.hover.updateAt(p.x, p.y, btn);
      var tip = document.querySelector('.dt-hover-tip');
      if (!tip || tip.hidden) return '没有弹出原文气泡';
      var tipBody = tip.querySelector('.dt-hover-body');
      if (!tipBody || tipBody.textContent !== 'Then continue.') return '气泡里不是这一句原文：' + (tipBody ? tipBody.textContent : tip.textContent);
      if (highlighted('dt-hover-target') !== '然后继续。') return '页面上高亮的不是鼠标下这句：' + highlighted('dt-hover-target');
      var c = box.querySelector('#hv-c');
      p = pointOf(c.firstChild, 'Else');
      DT.hover.updateAt(p.x, p.y, c);
      return tip.hidden && !highlighted('dt-hover-target') ? true : '移开后气泡 / 高亮没收起';
    });
  });

  check('悬停对照：超长段落气泡有尺寸上限、标段落级、可展开/收起/关闭', function () {
    if (!window.Highlight || !CSS.highlights) return true;
    var prevMode = DT.state.mode;
    DT.state.mode = 'translation';
    try {
      return withHoverFixture('<p id="hv-long" style="white-space:pre-wrap"></p><p id="hv-other">Other text</p>', function (box) {
        var p = box.querySelector('#hv-long');
        var orig = '';
        for (var i = 1; i <= 8; i += 1) orig += 'Original sentence number ' + i + ' is deliberately long. ';
        p.textContent = orig;
        if (!DT.inject(p, '第一段。\n第二段。', 'zh-CN')) return 'inject 返回 false';
        if (!p.hasAttribute('data-dt-replaced')) return '长段落应原地替换';
        var tip = document.querySelector('.dt-hover-tip');
        if (!tip) return '没有气泡';
        var txt = p.firstChild;
        var pt = pointOf(txt, '第一段');
        DT.hover.updateAt(pt.x, pt.y, p);
        if (tip.hidden) return '长段落没有弹出气泡';
        if (!tip.classList.contains('is-rich')) return '长段落应使用可交互气泡';
        var label = tip.querySelector('.dt-hover-label').textContent;
        if (label.indexOf('段落级对应') < 0) return '没有标段落级：' + label;
        var body = tip.querySelector('.dt-hover-body');
        if (body.textContent.length >= orig.length) return '长段落应先显示节选';
        if (body.textContent.slice(-1) !== '…') return '节选没有省略号';
        var r = tip.getBoundingClientRect();
        if (r.width > Math.min(420, window.innerWidth - 24) + 1) return '气泡太宽：' + r.width;
        if (r.height > window.innerHeight * 0.4 + 1) return '气泡太高：' + r.height;
        if (r.left < 0 || r.top < 0 || r.right > window.innerWidth || r.bottom > window.innerHeight) {
          return '气泡超出视口：' + JSON.stringify({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
        }
        var expand = tip.querySelector('.dt-hover-expand');
        if (!expand || expand.hidden) return '长段落没有展开按钮';
        expand.click();
        if (body.textContent !== orig.trim() && body.textContent !== orig) return '展开后不是完整原文';
        if (expand.textContent !== '收起') return '展开按钮文案不对：' + expand.textContent;
        expand.click();
        if (body.textContent.slice(-1) !== '…') return '收起后没有回到节选';
        tip.querySelector('.dt-hover-close').click();
        if (!tip.hidden) return '关闭按钮没有收起气泡';
        if (highlighted('dt-hover-target')) return '关闭后高亮没有清除';
        // 再显示一次，测试 Escape
        DT.hover.updateAt(pt.x, pt.y, p);
        if (tip.hidden) return '重新悬停没有显示';
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return tip.hidden ? true : 'Escape 没有关闭气泡';
      }, 'left:auto;right:0;bottom:0;top:auto;');
    } finally {
      DT.state.mode = prevMode;
    }
  });

  check('悬停对照：配置关闭后立即清除气泡与高亮，重新开启可再次触发', function () {
    if (!window.Highlight || !CSS.highlights) return true;
    var prev = DT.state.config;
    try {
      DT.state.config = { hoverCompare: true, uiLang: 'zh' };
      return withHoverFixture('<button id="hv-toggle">Sign in now. Then continue.</button>', function (box) {
        var btn = box.querySelector('#hv-toggle');
        var toggled = '立即登录。然后继续。';
        var align = DT.units.alignmentOf([{ n: 1, t: '立即登录。' }, { n: 1, t: '然后继续。' }], toggled, 2);
        if (!DT.inject(btn, toggled, 'zh-CN', align)) return 'inject 返回 false';
        var pt = pointOf(btn.firstChild, '然后');
        DT.hover.updateAt(pt.x, pt.y, btn);
        var tip = document.querySelector('.dt-hover-tip');
        if (!tip || tip.hidden) return '没有弹出';
        DT.state.config = { hoverCompare: false, uiLang: 'zh' };
        DT.emitConfig(DT.state.config);
        if (!tip.hidden) return '关闭后气泡没有立即消失';
        if (highlighted('dt-hover-target') || btn.hasAttribute('data-dt-hover')) return '关闭后高亮/属性没有清除';
        DT.hover.updateAt(pt.x, pt.y, btn);
        if (!tip.hidden || highlighted('dt-hover-target')) return '关闭后不应再触发';
        DT.state.config = { hoverCompare: true, uiLang: 'zh' };
        DT.emitConfig(DT.state.config);
        DT.hover.updateAt(pt.x, pt.y, btn);
        return !tip.hidden && highlighted('dt-hover-target') === '然后继续。' ? true : '重新开启后没有恢复：' + highlighted('dt-hover-target');
      });
    } finally {
      DT.state.config = prev;
    }
  });

  // ---------------- 0.8.6 悬停气泡：节选 / 内部滚动 / 鼠标进出 ----------------
  check('悬停气泡节选：末尾是 s 的英文不丢字，截断处空白去掉，短文本原样，中日文和 emoji 不截坏', function () {
    var P = DT.hover.tipPreview;
    var LIMIT = 180; // 与 hover.js 的 TIP_PREVIEW_CHARS 一致
    var bad = [];
    function expect(input, want, label) {
      var got = P(input);
      if (got !== want) bad.push(label + '：' + JSON.stringify(got.slice(-12)) + ' ≠ ' + JSON.stringify(want.slice(-12)));
    }
    expect(new Array(LIMIT).join('a') + 's and more words', new Array(LIMIT).join('a') + 's…', '截断处是 s');
    expect(new Array(LIMIT - 3).join('b') + ' \t\n ' + 'tail text here', new Array(LIMIT - 3).join('b') + '…', '截断处是空白');
    expect('Short text ends with s', 'Short text ends with s', '短文本');
    expect('末尾有空格的短文本 ', '末尾有空格的短文本 ', '短文本不改');
    expect(new Array(LIMIT + 21).join('漢'), new Array(LIMIT + 1).join('漢') + '…', '中文');
    expect(new Array(LIMIT / 2 + 11).join('あs'), new Array(LIMIT / 2 + 1).join('あs') + '…', '日文与 s 混排');
    expect(new Array(LIMIT).join('x') + '😀tail', new Array(LIMIT).join('x') + '…', 'emoji 不截成半个字');
    return bad.length ? bad.join('；') : true;
  });

  function withHoverFixtureAsync(html, fn, extraStyle) {
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:0;top:0;width:640px;z-index:2147483000;background:#fff;font:16px/1.6 sans-serif;padding:8px' + (extraStyle ? ';' + extraStyle : '');
    box.innerHTML = html;
    document.body.appendChild(box);
    var wasEnabled = DT.state.enabled;
    var prevMode = DT.state.mode;
    var prevDt = document.documentElement.getAttribute('data-dt');
    DT.state.enabled = true;
    document.documentElement.setAttribute('data-dt', 'on');
    function cleanup() {
      DT.hover.clear();
      DT.restore();
      DT.state.enabled = wasEnabled;
      DT.state.mode = prevMode;
      if (prevDt === null) document.documentElement.removeAttribute('data-dt');
      else document.documentElement.setAttribute('data-dt', prevDt);
      box.remove();
    }
    return Promise.resolve()
      .then(function () {
        return fn(box);
      })
      .then(
        function (out) {
          cleanup();
          return out;
        },
        function (err) {
          cleanup();
          throw err;
        }
      );
  }

  checkAsync('悬停气泡：正文内部滚动、点按钮、鼠标移进移出都不误收；网页滚动 / 其它容器滚动 / Escape 照常收起', function () {
    if (!window.Highlight || !CSS.highlights) return true;
    var orig = '';
    for (var i = 1; i <= 24; i += 1) orig += 'Original sentence number ' + i + ' is deliberately long so the bubble scrolls. ';
    return withHoverFixtureAsync('<p id="hv-scroll" style="white-space:pre-wrap"></p>', function (box) {
      var p = box.querySelector('#hv-scroll');
      p.textContent = orig;
      DT.state.mode = 'translation';
      if (!DT.inject(p, '第一段。\n第二段。', 'zh-CN')) return 'inject 返回 false';
      var tip, body, expand, pt;
      function show() {
        pt = pointOf(p.firstChild, '第一段');
        DT.hover.updateAt(pt.x, pt.y, p);
        tip = document.querySelector('.dt-hover-tip');
        body = tip.querySelector('.dt-hover-body');
        expand = tip.querySelector('.dt-hover-expand');
      }
      function visible() {
        return !!tip && !tip.hidden && !!highlighted('dt-hover-target');
      }
      show();
      if (!visible() || !tip.classList.contains('is-rich')) return '长段落没有弹出可交互气泡';
      expand.click();
      if (body.scrollHeight <= body.clientHeight) return '夹具不够长，正文不能滚动';
      body.scrollTop = 80; // 真实滚动：scroll 事件异步派发，捕获阶段的监听也会收到
      return wait(120)
        .then(function () {
          if (!visible()) throw new Error('气泡正文内部滚动后气泡被收起了');
          if (body.scrollTop < 1) throw new Error('正文没有滚动');
          expand.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          if (!visible()) throw new Error('在气泡按钮上按下鼠标就被收起了');
          expand.click(); // 收起：scrollTop 归零，又一次内部 scroll
          return wait(120);
        })
        .then(function () {
          if (!visible()) throw new Error('点「收起」后气泡消失了');
          if (body.textContent.slice(-1) !== '…') throw new Error('收起后没有回到节选');
          DT.hover.updateAt(1, 1, body); // 鼠标在气泡里移动
          tip.dispatchEvent(new MouseEvent('mouseleave'));
          return wait(60);
        })
        .then(function () {
          tip.dispatchEvent(new MouseEvent('mouseenter')); // 200ms 内又移回来
          return wait(300);
        })
        .then(function () {
          if (!visible()) throw new Error('鼠标移出又很快移回，气泡不该收起');
          tip.dispatchEvent(new MouseEvent('mouseleave'));
          return wait(300);
        })
        .then(function () {
          if (visible() || !tip.hidden) throw new Error('鼠标离开气泡后应延迟收起');
          show();
          if (!visible()) throw new Error('重新悬停没有显示');
          document.dispatchEvent(new Event('scroll')); // 网页滚动：锚点位置失效
          if (!tip.hidden || highlighted('dt-hover-target')) throw new Error('网页滚动后气泡 / 高亮没有清掉');
          show();
          box.dispatchEvent(new Event('scroll')); // 网页里别的容器在滚
          if (!tip.hidden) throw new Error('网页其它容器滚动后气泡没有收起');
          show();
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          if (!tip.hidden || highlighted('dt-hover-target')) throw new Error('Escape 没有关闭');
          return true;
        })
        .catch(function (err) {
          return err && err.message ? err.message : String(err);
        });
    }, 'left:auto;right:0;bottom:0;top:auto;');
  });

  // ---------------- 0.8.4 小说正文：分行保留 / 按行写回 / 还原 ----------------
  function mountNovel() {
    var box = document.createElement('div');
    box.appendChild(document.getElementById('tpl-novel').content.cloneNode(true));
    document.getElementById('fixture').appendChild(box);
    return box;
  }
  // 模拟遵守分行规则的模型：每行加前缀，行数不变
  function fakeLines(text) {
    return text.split('\n').map(function (line) { return line ? '译：' + line : ''; }).join('\n');
  }
  function withNovel(mode, fn) {
    var box = mountNovel();
    var prev = DT.state.mode;
    DT.state.mode = mode;
    try {
      return fn(box, function (cls) { return box.querySelector('.' + cls); });
    } finally {
      DT.state.mode = prev;
      DT.restore();
      box.remove();
    }
  }
  function unitOfEl(el) {
    return DT.collect(el).filter(function (u) { return u.el === el; })[0];
  }
  // 页面上实际排出来的行（innerText 认 <br>、pre-*、display:none）
  function shownLines(el) {
    return el.innerText.replace(/\n+$/, '').split('\n');
  }

  // ---------------- 0.9.0 振假名：<rt> / <rp> 不是正文 ----------------
  function withRuby(mode, fn) {
    var box = document.createElement('div');
    box.appendChild(document.getElementById('tpl-ruby').content.cloneNode(true));
    document.getElementById('fixture').appendChild(box);
    var prev = DT.state.mode;
    DT.state.mode = mode;
    try {
      return fn(box, box.querySelector('#fx-ruby'));
    } finally {
      DT.state.mode = prev;
      DT.restore();
      box.remove();
    }
  }

  check('振假名：<rt> 读音 / <rp> 括号不进送翻文本，也不单独成段', function () {
    return withRuby('dual', function (box) {
      var units = DT.collect(box);
      var texts = units.map(function (u) { return u.text; });
      if (texts.indexOf('ふりがな') >= 0) return '读音被当成独立段落送翻：' + JSON.stringify(texts);
      if (texts.join('').indexOf('ふりがな') >= 0) return '读音混进了原文：' + JSON.stringify(texts);
      if (texts.join('').indexOf('(') >= 0) return '<rp> 的括号混进了原文：' + JSON.stringify(texts);
      return eq(texts, ['漢字振り仮名のテスト。']);
    });
  });

  check('振假名：仅译文模式替换基字，<rt> 读音节点原样留着', function () {
    return withRuby('translation', function (box, p) {
      var u = unitOfEl(p);
      if (!u) return '没收集到这个段落';
      if (!DT.inject(u.el, 'A test with ruby.', 'zh-CN', u.own)) return 'inject 返回 false';
      var rt = p.querySelector('rt');
      if (!rt) return '<rt> 被删掉了';
      if (rt.textContent !== 'ふりがな') return '读音被改写了：' + rt.textContent;
      if (/漢字|振り仮名|のテスト/.test(p.textContent)) return '原文没被替换：' + p.textContent;
      return p.textContent.indexOf('A test with ruby.') >= 0 ? true : '没有写入译文：' + p.textContent;
    });
  });


  // ---------------- 0.9.1 段落单元 / Ruby / 锚点 ----------------
  function withTemplate(id, mode, fn) {
    var box = document.createElement('div');
    box.appendChild(document.getElementById(id).content.cloneNode(true));
    document.getElementById('fixture').appendChild(box);
    var prev = DT.state.mode;
    DT.state.mode = mode;
    try {
      return fn(box);
    } finally {
      DT.state.mode = prev;
      DT.restore();
      box.remove();
    }
  }

  check('青空文库式：同一容器内连续 <br> 拆成 3 个段落单元，各有独立锚点', function () {
    return withTemplate('tpl-aozora', 'dual', function (box) {
      var div = box.querySelector('.main_text');
      var units = DT.collect(box);
      if (units.length !== 3) return '应为 3 个段落单元，实际 ' + units.length + '：' + JSON.stringify(units.map(function (u) { return u.text.slice(0, 10); }));
      var r = eq(units.map(function (u) { return u.text.slice(0, 6); }), ['ある日の暮方', '広い門の下に', '羅生門が、朱']);
      if (r !== true) return '段落文本：' + r;
      for (var i = 0; i < 2; i += 1) {
        if (!units[i].anchor || units[i].anchor.before.tagName !== 'BR') return '第 ' + (i + 1) + ' 段缺少分隔 <br> 锚点';
      }
      if (units[2].anchor) return '最后一段应追加到容器内部末尾';
      units.forEach(function (u, k) {
        if (!DT.inject(u, '译文' + (k + 1), 'zh-CN')) throw new Error('第 ' + (k + 1) + ' 段注入失败');
      });
      var seq = [];
      Array.prototype.forEach.call(div.childNodes, function (n) {
        if (n.nodeType === 3) {
          if (n.nodeValue.trim()) seq.push('T:' + n.nodeValue.trim().slice(0, 4));
        } else if (n.tagName === 'BR') seq.push('BR');
        else if (n.getAttribute('data-dt-target')) seq.push('TGT:' + n.textContent);
      });
      var want = ['T:ある日の', 'TGT:译文1', 'BR', 'BR', 'T:広い門の', 'TGT:译文2', 'BR', 'BR', 'T:羅生門が', 'TGT:译文3'];
      var rr = eq(seq, want);
      if (rr !== true) return '译文没有跟在各自段落后面：' + rr;
      if (DT.collect(box).length) return '已翻译的段落又被收集（重复翻译风险）';
      return true;
    });
  });

  check('青空文库式·仅译文：每段原地写回，空行与 <br> 不动，还原逐字一致', function () {
    return withTemplate('tpl-aozora', 'translation', function (box) {
      var div = box.querySelector('.main_text');
      var html = div.innerHTML;
      var brs = div.querySelectorAll('br').length;
      var units = DT.collect(box);
      units.forEach(function (u, k) {
        if (!DT.inject(u, '译文' + (k + 1), 'zh-CN')) throw new Error('第 ' + (k + 1) + ' 段注入失败');
      });
      var texts = [];
      Array.prototype.forEach.call(div.childNodes, function (n) {
        if (n.nodeType === 3 && n.nodeValue.trim()) texts.push(n.nodeValue.trim());
      });
      var r = eq(texts, ['译文1', '译文2', '译文3']);
      if (r !== true) return '仅译文没有逐段写回：' + r;
      if (div.querySelectorAll('br').length !== brs) return '<br> 数量变了';
      if (DT.collect(box).length) return '已翻译的段落又被收集';
      DT.restore();
      if (div.innerHTML !== html) return '还原后结构不一致：' + div.innerHTML;
      return true;
    });
  });

  check('Ruby：普通 rt / rp / 多个 Ruby 混合普通文字，rt/rp 不进送翻文本', function () {
    return withTemplate('tpl-ruby-mix', 'dual', function (box) {
      var p = box.querySelector('#fx-ruby-mix');
      var units = DT.collect(box);
      var u = units.filter(function (one) { return one.el === p; })[0];
      if (!u) return '没收集到 Ruby 段落';
      var r = eq(u.text, '彼は羅生門の下で、雨やみを待っていた。');
      if (r !== true) return '送翻文本：' + r;
      if (!u.ruby || u.ruby.length !== 4) return '应关联 4 个 rt/rp 节点（1 + 3），实际 ' + (u.ruby ? u.ruby.length : 0);
      return true;
    });
  });

  check('Ruby·仅译文：译文不写进 ruby/rb/rt/rp；只隐藏本段注音；其他 Ruby 不受影响；可完整还原', function () {
    return withTemplate('tpl-ruby-mix', 'translation', function (box) {
      var p = box.querySelector('#fx-ruby-mix');
      var other = box.querySelector('#fx-ruby-other');
      var html = box.innerHTML;
      var units = DT.collect(box);
      var u = units.filter(function (one) { return one.el === p; })[0];
      if (!u) return '没收集到 Ruby 段落';
      if (!DT.inject(u, '他在罗生门下等待雨停。', 'zh-CN')) return '注入失败';
      var rts = p.querySelectorAll('rt');
      if (rts.length !== 2) return 'rt 数量变了';
      for (var i = 0; i < rts.length; i += 1) {
        if (rts[i].getAttribute('data-dt-rt-hidden') !== '1') return '关联的 rt 没有标记隐藏';
        if (getComputedStyle(rts[i]).display !== 'none') return '关联的 rt 没有真正隐藏：' + getComputedStyle(rts[i]).display;
      }
      if (!p.querySelector('ruby')) return 'Ruby 节点被删掉了';
      if (!p.querySelector('strong')) return '行内标签被删掉了';
      if (p.innerText.indexOf('罗生门') < 0) return '译文没显示';
      if (p.innerText.indexOf('らしょうもん') >= 0 || p.innerText.indexOf('あめ') >= 0) return '仅译文模式残留假名：' + p.innerText;
      var rubies = p.querySelectorAll('ruby');
      for (var k = 0; k < rubies.length; k += 1) {
        if (rubies[k].textContent.indexOf('罗生门') >= 0 || rubies[k].textContent.indexOf('等待') >= 0) return '整句译文被写进了 ruby：' + rubies[k].textContent;
      }
      var otherRt = other.querySelector('rt');
      if (!otherRt) return '未翻译段落的 rt 被删了';
      if (otherRt.getAttribute('data-dt-rt-hidden') || getComputedStyle(otherRt).display === 'none') return '未翻译段落的注音被全局隐藏了';
      DT.restore();
      if (box.innerHTML !== html) return '还原后结构不一致';
      if (getComputedStyle(p.querySelector('rt')).display === 'none') return '还原后注音仍然是隐藏的';
      return true;
    });
  });

  check('Ruby·仅译文：<rb> 基字不被写入整句译文，Ruby 结构保留', function () {
    return withTemplate('tpl-ruby-mix', 'translation', function (box) {
      var p = box.querySelector('#fx-ruby-rb');
      var units = DT.collect(box);
      var u = units.filter(function (one) { return one.el === p; })[0];
      if (!u) return '没收集到带 rb 的段落';
      if (!DT.inject(u, '汉字的测试。', 'zh-CN')) return '注入失败';
      var rb = p.querySelector('rb');
      if (!rb) return '<rb> 被删掉了';
      if (rb.textContent.indexOf('汉字的测试') >= 0) return '整句译文被写进了 <rb>：' + rb.textContent;
      if (p.querySelector('ruby').textContent.indexOf('汉字的测试') >= 0) return '译文写进了 ruby';
      if (p.innerText.indexOf('汉字的测试') < 0) return '译文没显示：' + p.innerText;
      DT.restore();
      if (p.querySelector('rb').textContent !== '字') return '还原后 <rb> 没有恢复：' + p.querySelector('rb').textContent;
      return true;
    });
  });

  check('Ruby·双语：注音原样可见，译文追加在段落末尾，不写进 ruby', function () {
    return withTemplate('tpl-ruby-mix', 'dual', function (box) {
      var p = box.querySelector('#fx-ruby-mix');
      var units = DT.collect(box);
      var u = units.filter(function (one) { return one.el === p; })[0];
      if (!DT.inject(u, '他在罗生门下等待雨停。', 'zh-CN')) return '注入失败';
      var rt = p.querySelector('rt');
      if (rt.getAttribute('data-dt-rt-hidden') || getComputedStyle(rt).display === 'none') return '双语模式不该隐藏注音';
      var target = p.querySelector('[data-dt-target]');
      if (!target || target.textContent !== '他在罗生门下等待雨停。') return '没有追加译文';
      if (p.querySelector('ruby').textContent.indexOf('他在') >= 0) return '译文写进了 ruby';
      return true;
    });
  });

  check('生命周期：旧代际的译文不能写进页面（晚到的 API 结果）', function () {
    return withTemplate('tpl-aozora', 'dual', function (box) {
      var units = DT.collect(box);
      if (!units.length) return '没收集到单元';
      DT.bumpGeneration();
      if (DT.inject(units[0], '过期的译文', 'zh-CN')) return '旧代际的单元仍被注入';
      return box.querySelector('[data-dt-target]') ? '页面上出现了过期译文' : true;
    });
  });


  check('生命周期：站点改了某一个段落 → 只撤掉这一段，兄弟段落保持不动', function () {
    return withTemplate('tpl-aozora', 'dual', function (box) {
      var div = box.querySelector('.main_text');
      var units = DT.collect(box);
      units.forEach(function (u, k) {
        if (!DT.inject(u, '译文' + (k + 1), 'zh-CN')) throw new Error('注入失败');
      });
      // 只改第二段的文字（模拟 SPA 重渲染复用同一个容器）
      var textNodes = [];
      Array.prototype.forEach.call(div.childNodes, function (n) {
        if (n.nodeType === 3 && n.nodeValue.trim()) textNodes.push(n);
      });
      textNodes[1].nodeValue = 'サイトが書き換えた新しい段落。';
      if (DT.refreshStale() !== 1) return 'refreshStale 应只撤掉被改的那一段';
      var left = div.querySelectorAll('[data-dt-target]').length;
      if (left !== 2) return '兄弟段落的译文不该被撤掉，剩余 ' + left;
      var again = DT.collect(box);
      if (again.length !== 1) return '应只重新收集被改的那一段，实际 ' + again.length;
      return again[0].text === 'サイトが書き換えた新しい段落。' ? true : '收集到的不是新内容：' + again[0].text;
    });
  });

  check('生命周期：Ruby 段落的基字被站点改写 → releaseReplaced 恢复注音与其余文本', function () {
    return withTemplate('tpl-ruby-mix', 'translation', function (box) {
      var p = box.querySelector('#fx-ruby-mix');
      var units = DT.collect(box);
      var u = units.filter(function (one) { return one.el === p; })[0];
      if (!u) return '没收集到 Ruby 段落';
      if (!DT.inject(u, '他在罗生门下等待雨停。', 'zh-CN')) return '注入失败';
      var rt = p.querySelector('rt');
      if (getComputedStyle(rt).display !== 'none') return '注音没有先隐藏';
      // 站点改写了一个被清空的基字节点：说明这一段的 DOM 已经不是我们写的样子
      p.querySelector('strong').textContent = '変わった';
      if (DT.releaseReplaced() !== 1) return '没有把被改写的 Ruby 段落放回待翻译';
      if (p.querySelector('[data-dt-target]')) return '译文节点没有移除';
      if (getComputedStyle(rt).display === 'none') return '注音仍然隐藏';
      return p.textContent.indexOf('彼は') === 0 ? true : '其余原文没有恢复：' + p.textContent.slice(0, 30);
    });
  });

  check('生命周期：SPA 把容器内容整体换掉 → refreshStale 清掉失效译文，重新收集新内容', function () {
    return withTemplate('tpl-aozora', 'dual', function (box) {
      var div = box.querySelector('.main_text');
      var units = DT.collect(box);
      units.forEach(function (u) {
        DT.inject(u, '旧译文', 'zh-CN');
      });
      div.innerHTML = '新しい第一段。<br><br>新しい第二段。';
      var changed = DT.refreshStale();
      if (changed < 1) return 'refreshStale 没有发现节点被整体替换';
      var again = DT.collect(box);
      if (again.length !== 2) return '应重新收集两段新内容，实际 ' + again.length;
      return again[0].text.indexOf('新しい第一段') === 0 ? true : '新内容不对：' + again[0].text;
    });
  });


  // ---------------- 0.9.2 真实《罗生门》DOM 夹具回归 ----------------
  function rectOfNode(node) {
    var r = document.createRange();
    r.selectNodeContents(node);
    return r.getBoundingClientRect();
  }
  function realAozoraMetrics(box) {
    var mt = box.querySelector('.main_text');
    var targets = Array.prototype.slice.call(mt.querySelectorAll('[data-dt-target]'));
    var pieces = [];
    Array.prototype.forEach.call(mt.childNodes, function (n) {
      if (n.nodeType === 3) {
        if (n.nodeValue.trim()) {
          var b = rectOfNode(n);
          if (b.height > 0) pieces.push({ top: b.top, height: b.height });
        }
      } else if (n.nodeType === 1 && n.tagName !== 'BR') {
        var rb = n.getBoundingClientRect();
        if (rb.height > 0) pieces.push({ top: rb.top, height: rb.height });
      }
    });
    pieces.sort(function (a, b) { return a.top - b.top; });
    var maxGap = 0;
    for (var i = 1; i < pieces.length; i += 1) {
      var g = pieces[i].top - (pieces[i - 1].top + pieces[i - 1].height);
      if (g > maxGap) maxGap = g;
    }
    return {
      top: mt.getBoundingClientRect().top,
      height: mt.getBoundingClientRect().height,
      targets: targets,
      maxGap: maxGap
    };
  }

  check('真实罗生门夹具：单 <br> + 全角缩进分成 6 个段落单元（不是整篇一个）', function () {
    return withTemplate('tpl-aozora-real', 'dual', function (box) {
      var mt = box.querySelector('.main_text');
      var units = DT.collect(box);
      if (units.length !== 6) {
        return '应为 6 个段落单元，实际 ' + units.length + '：' + JSON.stringify(units.map(function (u) { return u.text.slice(0, 10); }));
      }
      var r = eq(units[0].text.indexOf('げにん') < 0 && units[0].text.indexOf('（') < 0, true);
      if (r !== true) return '<rb>/<rt>/<rp> 混进了正文';
      if (units[0].text.indexOf('ある日の暮方') !== 0) return '首段文本不对：' + units[0].text.slice(0, 20);
      if (units[0].ruby.length !== 6) return '首段应关联 6 个 rt/rp，实际 ' + units[0].ruby.length;
      if (units[3].map.text.split('\n').length !== 2) return '对白续行应与上一段同段（2 行），实际 ' + units[3].map.text.split('\n').length;
      if (units[3].text.indexOf('「おのれ、どこへ行く。」') < 0) return '对白续行丢了';
      if (units[4].text !== '「では、また。」') return '全角缩进的对白段落不对：' + units[4].text;
      if (units[5].map.text.split('\n').length !== 2) return '无缩进续行不应拆段';
      if (units[5].text.indexOf('インデントのない続きの行。') < 0) return '续行文本丢了';
      for (var i = 0; i < 5; i += 1) {
        if (!units[i].anchor || units[i].anchor.before.tagName !== 'BR') return '第 ' + (i + 1) + ' 段缺少分隔 <br> 锚点';
      }
      if (units[5].anchor) return '最后一段在当前夹具里应追加到容器末尾';
      if (DT.sourceChanged(units[0]) || DT.sourceChanged(units[5])) return '采集后原文快照就变了';
      return true;
    });
  });

  check('真实罗生门·双语：译文交错在各自段落后，首段译文不在页尾', function () {
    return withTemplate('tpl-aozora-real', 'dual', function (box) {
      var html = box.innerHTML;
      var units = DT.collect(box);
      units.forEach(function (u, i) {
        if (!DT.inject(u, '中文译文' + (i + 1), 'zh-CN')) throw new Error('第 ' + (i + 1) + ' 段注入失败');
      });
      var m = realAozoraMetrics(box);
      if (m.targets.length !== 6) return '应有 6 个译文节点，实际 ' + m.targets.length;
      var tops = m.targets.map(function (t) { return t.getBoundingClientRect().top; });
      for (var i = 1; i < tops.length; i += 1) {
        if (tops[i] < tops[i - 1]) return '译文节点顺序不对';
      }
      var firstParaTop = box.querySelector('.main_text').getBoundingClientRect().top;
      if (tops[0] - firstParaTop > 120) return '首段译文离首段原文太远（' + Math.round(tops[0] - firstParaTop) + 'px）';
      // 每个译文节点都在本段原文之后、下一段原文之前
      for (var k = 0; k < units.length; k += 1) {
        var srcNode = units[k].groups.filled[0].pieces[0].node;
        var srcRect = rectOfNode(srcNode);
        var tgtRect = m.targets[k].getBoundingClientRect();
        if (tgtRect.top < srcRect.top - 2) return '第 ' + (k + 1) + ' 段译文跑到了原文前面';
        if (k + 1 < units.length) {
          var nextNode = units[k + 1].groups.filled[0].pieces[0].node;
          var nextRect = rectOfNode(nextNode);
          if (tgtRect.top > nextRect.top + 2) return '第 ' + (k + 1) + ' 段译文跑到了下一段原文之后';
        }
      }
      var text = box.innerText;
      var order = [1, 2, 3, 4, 5, 6].map(function (n) { return text.indexOf('中文译文' + n); });
      for (var j = 1; j < order.length; j += 1) if (order[j] < order[j - 1]) return '译文阅读顺序不对：' + JSON.stringify(order);
      DT.restore();
      if (box.innerHTML !== html) return '双语还原后结构不一致';
      return true;
    });
  });

  check('真实罗生门·仅译文：首段译文在原位置、无巨大空白、无可见假名、Ruby 不被写入', function () {
    return withTemplate('tpl-aozora-real', 'translation', function (box) {
      var html = box.innerHTML;
      var m0 = realAozoraMetrics(box);
      var units = DT.collect(box);
      units.forEach(function (u, i) {
        if (!DT.inject(u, '中文译文' + (i + 1), 'zh-CN')) throw new Error('第 ' + (i + 1) + ' 段注入失败');
      });
      var m = realAozoraMetrics(box);
      if (m.targets.length < 1) return '没有独立译文节点';
      var firstTop = m.targets[0].getBoundingClientRect().top - m.top;
      if (firstTop > 80) return '首段译文离容器顶部太远（' + Math.round(firstTop) + 'px，疑似巨大空白）';
      if (m.maxGap > 80) return '正文中出现巨大空白（最大 ' + Math.round(m.maxGap) + 'px）';
      if (m.height > m0.height * 1.3) return '仅译文高度异常：' + Math.round(m.height) + ' vs ' + Math.round(m0.height);
      var rt = Array.prototype.slice.call(box.querySelectorAll('rt'));
      var visible = rt.filter(function (x) { return getComputedStyle(x).display !== 'none'; });
      if (visible.length) return '还有 ' + visible.length + ' 个注音可见';
      var text = box.innerText;
      if (/[\u3040-\u30ff]/.test(text)) return '页面上残留假名：' + text.slice(0, 60);
      var rubies = box.querySelectorAll('ruby');
      for (var i = 0; i < rubies.length; i += 1) {
        if (rubies[i].textContent.indexOf('中文译文') >= 0) return '整句译文被写进了 ruby：' + rubies[i].textContent.slice(0, 30);
      }
      var rb = box.querySelector('rb');
      if (!rb) return 'rb 节点被删掉了';
      if (rb.textContent.indexOf('中文译文') >= 0) return '译文被写进了 rb';
      DT.restore();
      if (box.innerHTML !== html) return '仅译文还原后结构不一致';
      if (getComputedStyle(box.querySelector('rt')).display === 'none') return '还原后注音仍隐藏';
      return true;
    });
  });

  check('真实罗生门·生命周期：模式切换 / 重新开启 / 动态新增段落都不重复', function () {
    return withTemplate('tpl-aozora-real', 'dual', function (box) {
      var html = box.innerHTML;
      function injectAll(label) {
        var us = DT.collect(box);
        us.forEach(function (u, i) {
          if (!DT.inject(u, label + (i + 1), 'zh-CN')) throw new Error(label + ' 注入失败');
        });
        return us.length;
      }
      if (injectAll('A') !== 6) return '首轮应 6 段';
      if (box.querySelectorAll('[data-dt-target]').length !== 6) return '双语节点数不对';
      DT.state.mode = 'translation';
      DT.restore();
      if (injectAll('B') <= 0) return '仅译文没有重新收集';
      DT.state.mode = 'dual';
      DT.restore();
      if (injectAll('C') !== 6) return '切回双语应重新 6 段';
      DT.restore();
      if (box.innerHTML !== html) return '生命周期还原不一致';

      // 动态新增：单个 <br> + 全角缩进
      injectAll('D');
      var mt = box.querySelector('.main_text');
      var br = document.createElement('br');
      mt.appendChild(br);
      var tn = document.createTextNode('\n　動的に追加した段落。');
      mt.insertBefore(tn, br.nextSibling);
      var added = DT.collect(mt);
      if (added.length !== 1) return '动态新增应只收集 1 段，实际 ' + added.length;
      if (!DT.inject(added[0], '动态译文', 'zh-CN')) return '动态段落注入失败';
      if (box.querySelectorAll('[data-dt-target]').length !== 7) return '动态补翻后节点数不对';
      // 先把站点自己新增的节点移除，再还原我们注入的内容
      if (tn.parentNode) tn.parentNode.removeChild(tn);
      if (br.parentNode) br.parentNode.removeChild(br);
      DT.restore();
      if (box.innerHTML !== html) return '动态新增节点移除后还原不一致';
      return true;
    });
  });

  check('真实罗生门·对齐：Ruby 段落的句子映射与悬停配对可用', function () {
    return withTemplate('tpl-aozora-real', 'dual', function (box) {
      var units = DT.collect(box);
      var u = units[1]; // 第二段 4 句，含多个 ruby
      if (u.sentences.length !== 4) return '夹具第二段应为 4 句，实际 ' + u.sentences.length;
      var texts = ['中一。', '中二。', '中三。', '中四。'];
      var joined = texts.join('');
      var align = DT.units.alignmentOf(texts.map(function (t) { return { n: 1, t: t }; }), joined, u.sentences.length);
      if (!align) return '合法对齐没有建立';
      if (!DT.inject(u, joined, 'zh-CN', align)) return '带对齐注入失败';
      var pair = DT.hover.pairDual(u, joined, false, u.sentences[2].start);
      if (!pair || pair.scope !== 'sentence') return '有对齐时没有句级对应';
      if (pair.targetText !== '中三。') return '目标句不对：' + pair.targetText;
      if (pair.sourceText !== u.sentences[2].text) return '源句不对：' + pair.sourceText;
      var hit = DT.hover.pairReplaced(u, joined, joined.indexOf('中二'));
      if (!hit || hit.scope !== 'sentence' || hit.sourceText !== u.sentences[1].text) return '目标文本上反查源句失败';
      return true;
    });
  });


  check('降级策略：无法识别的巨型多行单元按行拆分，不静默 append 到页尾', function () {
    var box = document.createElement('div');
    box.style.cssText = 'width:600px;font:16px/1.6 sans-serif';
    var line = 'This line has no full-width indent and no blank line around it, but it is part of a long block.';
    var lines = [];
    for (var i = 0; i < 12; i += 1) lines.push(line);
    box.innerHTML = lines.join('<br>');
    document.getElementById('fixture').appendChild(box);
    try {
      var units = DT.collect(box);
      if (units.length < 8) return '应降级为多行单元，实际 ' + units.length;
      if (units[0].fallback !== 'line') return '没有标记 fallback=line';
      units.forEach(function (u, k) {
        if (!DT.inject(u, '按行译文' + (k + 1), 'zh-CN')) {
          throw new Error('降级单元注入失败 #' + k);
        }
      });
      if (box.querySelectorAll('[data-dt-target]').length !== units.length) return '降级后译文节点数不对';
      return true;
    } finally {
      DT.restore();
      box.remove();
    }
  });

  check('normalizeLines / splitLines：保留分行，行内照常折叠；没有换行时与 normalizeText 相同', function () {
    var r = eq(DT.normalizeLines('  a \t b \n\n\n  c  \n'), 'a b\n\nc');
    if (r !== true) return r;
    r = eq(DT.normalizeLines('\n　\n x \n　\n'), 'x');
    if (r !== true) return '全角空格行应算空行：' + r;
    var plain = '  Some   text here  ';
    if (DT.normalizeLines(plain) !== DT.normalizeText(plain)) return '单行结果应与 normalizeText 一致';
    return eq(DT.splitLines('一\n\n 二 \n　'), ['一', '二']);
  });

  check('小说：每个自然段一个单元，<br> / pre-line 的换行进入送翻文本，源码折行不算', function () {
    return withNovel('dual', function (box, q) {
      var units = DT.collect(box);
      // nv-blank 的「段1<br><br>段2」是两段（0.9.1 起），其余各一段
      if (units.length !== 8) return '应为 8 个单元，实际 ' + units.length + '：' + JSON.stringify(units.map(function (u) { return u.text.slice(0, 12); }));
      var r = eq(unitOfEl(q('nv-lines')).text, 'The classroom was empty after school.\nOnly the four of us were left.');
      if (r !== true) return 'span + <br>：' + r;
      r = eq(unitOfEl(q('nv-dialogue')).text, '「今日は何の日でしょう？」\n「ポッキーの日だ。」\n「じゃあ、勝負しよう。」');
      if (r !== true) return '对白（末尾空 span 不算一行）：' + r;
      var blank = units.filter(function (u) { return u.el === q('nv-blank'); });
      if (blank.length !== 2) return '连续 <br> 应拆成两个段落单元，实际 ' + blank.length;
      r = eq(blank.map(function (u) { return u.text; }), ['First paragraph of the letter.', 'Second paragraph after a blank line.']);
      if (r !== true) return '连续 <br> 两段文本：' + r;
      if (!blank[0].anchor || blank[0].anchor.before.tagName !== 'BR') return '第一段缺少分隔 <br> 锚点';
      if (blank[1].anchor) return '最后一段不该有外部锚点（应追加到元素内部末尾）';
      r = eq(unitOfEl(q('nv-multi')).text, 'She said very quietly that it was over.\nNobody answered.');
      if (r !== true) return '行内强调：' + r;
      r = eq(unitOfEl(q('nv-preline')).text, 'Line one of the poem.\nLine two of the poem.\n\nA new stanza begins here.');
      if (r !== true) return 'pre-line：' + r;
      return eq(unitOfEl(q('nv-source-newline')).text, 'Hello world, this newline is only source formatting.');
    });
  });

  check('小说·仅译文：多行段落逐行写回，不并成一段，<br> 与 span 数量不变', function () {
    return withNovel('translation', function (box, q) {
      var p = q('nv-dialogue');
      var u = unitOfEl(p);
      var before = { spans: p.querySelectorAll('span').length, brs: p.querySelectorAll('br').length };
      if (!DT.inject(u.el, fakeLines(u.text), 'zh-CN')) return 'inject 返回 false';
      if (p.querySelector('[data-dt-target]')) return '仅译文不该追加节点';
      var spans = p.querySelectorAll('span');
      if (spans.length !== before.spans || p.querySelectorAll('br').length !== before.brs) return '段落结构变了';
      var r = eq([spans[0].textContent, spans[1].textContent, spans[2].textContent], ['译：「今日は何の日でしょう？」', '译：「ポッキーの日だ。」', '译：「じゃあ、勝負しよう。」']);
      if (r !== true) return '没有逐行写回：' + r;
      var lines = shownLines(p);
      if (lines.length !== 3) return '页面上应排成 3 行，实际 ' + JSON.stringify(lines);
      return DT.replacedOf(p) && DT.replacedOf(p).aligned === true ? true : '行数一致时应记为逐行对齐';
    });
  });

  check('小说·仅译文：行首全角缩进、连续空行、pre-line 文本节点里的分行都保留', function () {
    return withNovel('translation', function (box, q) {
      var lines = q('nv-lines');
      var u = unitOfEl(lines);
      DT.inject(u.el, fakeLines(u.text), 'zh-CN');
      var first = lines.querySelector('span').textContent;
      if (first !== '　译：The classroom was empty after school.') return '行首缩进丢了：' + JSON.stringify(first);
      var blank = q('nv-blank');
      // 0.9.1 起连续 <br> 是两个段落单元：分别写回，空行结构由 <br><br> 保留
      var blankUnits = DT.collect(blank);
      if (blankUnits.length !== 2) return '连续 <br> 应为两段，实际 ' + blankUnits.length;
      blankUnits.forEach(function (unit) {
        DT.inject(unit, fakeLines(unit.text), 'zh-CN');
      });
      var r = eq(shownLines(blank), ['译：First paragraph of the letter.', '', '译：Second paragraph after a blank line.']);
      if (r !== true) return '连续空行：' + r;
      var pre = q('nv-preline');
      u = unitOfEl(pre);
      DT.inject(u.el, fakeLines(u.text), 'zh-CN');
      if (pre.childNodes.length !== 1) return 'pre-line 块的文本节点数变了';
      return eq(pre.firstChild.nodeValue, '译：Line one of the poem.\n译：Line two of the poem.\n\n译：A new stanza begins here.');
    });
  });

  check('小说·仅译文：行内强调所在行单独写回，<em>/<b> 元素仍在，下一行不受影响', function () {
    return withNovel('translation', function (box, q) {
      var p = q('nv-multi');
      var u = unitOfEl(p);
      DT.inject(u.el, '她非常小声地说，一切都结束了。\n没有人回答。', 'zh-CN');
      if (!p.querySelector('em') || !p.querySelector('b')) return '行内元素被删了';
      return eq(shownLines(p), ['她非常小声地说，一切都结束了。', '没有人回答。']);
    });
  });

  check('小说·双语：原文结构一字不动，译文节点保留分行', function () {
    return withNovel('dual', function (box, q) {
      var p = q('nv-dialogue');
      var html = p.innerHTML;
      var u = unitOfEl(p);
      if (!DT.inject(u.el, fakeLines(u.text), 'zh-CN')) return 'inject 返回 false';
      var node = p.querySelector(':scope > [data-dt-target]');
      if (!node) return '双语应追加译文';
      if (p.innerHTML.slice(0, html.length) !== html) return '原文被改动了';
      if (!node.classList.contains('dt-lines')) return '多行译文缺少 dt-lines';
      if (getComputedStyle(node).whiteSpace !== 'pre-line') return '译文分行没生效：' + getComputedStyle(node).whiteSpace;
      var single = q('nv-plain');
      u = unitOfEl(single);
      DT.inject(u.el, '雨停了。', 'zh-CN');
      var one = single.querySelector('[data-dt-target]');
      return one && !one.classList.contains('dt-lines') && getComputedStyle(one).whiteSpace === 'normal'
        ? true
        : '单行译文不该改 white-space';
    });
  });

  check('小说·仅译文：模型把几行并成一行 → 依次填写、多余换行收起不留空行，记为未对齐', function () {
    return withNovel('translation', function (box, q) {
      var p = q('nv-dialogue');
      var html = p.innerHTML;
      var u = unitOfEl(p);
      DT.inject(u.el, '「今天是什么日子？」「百奇日。」「那就来比一场。」', 'zh-CN');
      var lines = shownLines(p);
      if (lines.length !== 1) return '段尾不该留空行：' + JSON.stringify(lines);
      if (p.querySelectorAll('br').length !== 3) return '<br> 不该被删除';
      if (DT.replacedOf(p).aligned !== false) return '行数对不上时不能记为逐行对齐';
      DT.restore();
      if (p.innerHTML !== html) return '还原后结构不一致：' + p.innerHTML;
      return document.querySelector('[data-dt-collapsed]') ? '还原后还有收起的换行' : true;
    });
  });

  check('小说·仅译文：模型多拆了行 → 多出来的并进最后一行，不丢字', function () {
    return withNovel('translation', function (box, q) {
      var p = q('nv-lines');
      var u = unitOfEl(p);
      DT.inject(u.el, '放学后的教室空荡荡的。\n只剩我们四个人。\n谁也没说话。', 'zh-CN');
      var r = eq(shownLines(p), ['　放学后的教室空荡荡的。', '　只剩我们四个人。', '谁也没说话。']);
      if (r !== true) return r;
      return DT.replacedOf(p).aligned === false ? true : '行数对不上时不能记为逐行对齐';
    });
  });

  check('小说·还原：两种模式下段落、空白、原始文本逐字恢复', function () {
    var bad = [];
    ['dual', 'translation'].forEach(function (mode) {
      withNovel(mode, function (box) {
        var html = box.innerHTML;
        DT.collect(box).forEach(function (u) {
          DT.inject(u, fakeLines(u.text), 'zh-CN');
        });
        if (box.innerHTML === html) bad.push(mode + '：没有注入');
        DT.restore();
        if (box.innerHTML !== html) bad.push(mode + '：还原后不一致');
      });
    });
    return bad.length ? bad.join('；') : true;
  });

  check('小说：切换模式、重复翻译不残留旧译文，段落 / 换行数量不增长', function () {
    return withNovel('dual', function (box) {
      function count() {
        return [box.querySelectorAll('p').length, box.querySelectorAll('br').length, box.querySelectorAll('span:not([data-dt-target])').length].join('/');
      }
      var start = count();
      var html = box.innerHTML;
      var rounds = ['dual', 'translation', 'dual', 'translation'];
      for (var i = 0; i < rounds.length; i += 1) {
        DT.state.mode = rounds[i];
        DT.collect(box).forEach(function (u) {
          DT.inject(u, fakeLines(u.text), 'zh-CN');
        });
        // 同一轮再收集一次：已翻过的不再出现，也不会二次注入
        if (DT.collect(box).length) return rounds[i] + '：已翻译的段落又被收集';
        var targets = box.querySelectorAll('[data-dt-target]').length;
        if (rounds[i] === 'dual' && targets !== 8) return '双语应有 8 个译文节点，实际 ' + targets;
        if (rounds[i] === 'translation' && targets) return '仅译文残留了双语节点 ' + targets;
        if (count() !== start) return rounds[i] + '：数量变了 ' + count() + ' vs ' + start;
        DT.restore(); // 切换模式 = 还原后重建（main.js 的 startOver）
        if (box.innerHTML !== html) return rounds[i] + '：切换后没有回到原文';
      }
      return true;
    });
  });

  check('小说：翻译途中网站改了原文 → 旧译文不写入；改了已替换的行 → 还原不覆盖新内容', function () {
    return withNovel('translation', function (box, q) {
      var p = q('nv-dialogue');
      var u = unitOfEl(p);
      if (DT.sourceChanged(u)) return '原文没变时不该判成已改';
      p.querySelectorAll('span')[1].firstChild.nodeValue = '「ちがうよ。」';
      if (!DT.sourceChanged(u)) return '原文变了没认出来（旧译文会写进新内容）';
      u = unitOfEl(p);
      DT.inject(u.el, fakeLines(u.text), 'zh-CN');
      var spans = p.querySelectorAll('span');
      spans[2].firstChild.nodeValue = '「サイトの新しい文」'; // 站点重渲染改了第 3 行
      DT.restore();
      return eq([spans[0].textContent, spans[1].textContent, spans[2].textContent], ['「今日は何の日でしょう？」', '「ちがうよ。」', '「サイトの新しい文」']);
    });
  });

  check('长篇多段落：splitLong 在换行处切开，joinSlots 拼回仍是换行；单行长文本照旧', function () {
    var lines = [];
    for (var i = 0; i < 30; i += 1) lines.push('Paragraph ' + i + ' tells a short part of the story and then it ends here.');
    var text = lines.slice(0, 15).join('\n') + '\n\n' + lines.slice(15).join('\n');
    var parts = DT.splitLong(text, 300);
    if (parts.length < 5) return '应拆成多段，实际 ' + parts.length;
    if (parts.some(function (p) { return p.length > 300; })) return '有超过上限的段';
    if (parts.some(function (p) { return /^\n|\n$/.test(p); })) return '段首 / 段尾不该是换行';
    if (DT.joinSlots(parts, parts.seps) !== text) return '按 seps 拼回与原文不一致（换行丢了）';
    var long = 'This is a sentence number one. '.repeat(60).trim() + '\nShort tail line.';
    var p2 = DT.splitLong(long, 300);
    if (DT.joinSlots(p2, p2.seps).replace(/\s+/g, ' ') !== long.replace(/\s+/g, ' ')) return '超长行内按句切后内容丢失';
    if (DT.joinSlots(p2, p2.seps).indexOf('\nShort tail line.') < 0) return '超长行之后的换行丢了';
    var flat = DT.splitLong('One sentence here. '.repeat(100), 300);
    return flat.seps.every(function (sep) { return sep === ' '; }) ? true : '没有换行的长文本应按空格拼回';
  });

  check('joinSlots：丢掉空段时保留换行分隔', function () {
    return eq(DT.joinSlots(['一', '', '二', '三'], ['\n', ' ', '\n\n']), '一\n二\n\n三');
  });

  // ---------------- 0.8.7 Pixiv 中译英换行 / 长段落切分 ----------------
  function withPixivZh(mode, fn) {
    var box = document.createElement('div');
    box.appendChild(document.getElementById('tpl-pixiv-zh').content.cloneNode(true));
    document.getElementById('fixture').appendChild(box);
    var prev = DT.state.mode;
    DT.state.mode = mode;
    try {
      return fn(box, function (cls) { return box.querySelector('.' + cls); });
    } finally {
      DT.state.mode = prev;
      DT.restore();
      box.remove();
    }
  }
  var PX_EN = '"What are you doing?" she asked.\n"I\'m waiting for someone."';
  var BSL = String.fromCharCode(92);

  check('Pixiv 中译英：后台修好的真换行，仅译文逐行写回、双语分行显示，还原逐字一致', function () {
    var bad = [];
    ['translation', 'dual'].forEach(function (mode) {
      withPixivZh(mode, function (box, q) {
        var p = q('px-zh');
        var html = p.innerHTML;
        var u = unitOfEl(p);
        if (u.text !== '「你在做什么？」她问。\n「我在等人。」') bad.push(mode + ' 送翻文本不对：' + JSON.stringify(u.text));
        if (!DT.inject(u.el, PX_EN, 'en')) bad.push(mode + ' inject 失败');
        var shown = mode === 'translation' ? shownLines(p) : shownLines(p.querySelector('[data-dt-target]'));
        if (JSON.stringify(shown) !== JSON.stringify(['"What are you doing?" she asked.', '"I\'m waiting for someone."'])) {
          bad.push(mode + ' 显示：' + JSON.stringify(shown));
        }
        if (p.textContent.indexOf(BSL + 'n') >= 0) bad.push(mode + ' 页面上出现了字面 \\n');
        DT.restore();
        if (p.innerHTML !== html) bad.push(mode + ' 还原后不一致');
      });
    });
    return bad.length ? bad.join('；') : true;
  });

  check('正文里合法的字面 \\n（讲转义字符）：原样写进页面，不被拆成两行', function () {
    var bad = [];
    var en = 'A newline is written as ' + BSL + 'n inside strings.';
    ['translation', 'dual'].forEach(function (mode) {
      withPixivZh(mode, function (box, q) {
        var p = q('px-code');
        var u = unitOfEl(p);
        if (u.text.indexOf(BSL + 'n') < 0) bad.push('原文里的 \\n 丢了：' + u.text);
        DT.inject(u.el, en, 'en');
        var host = mode === 'translation' ? p : p.querySelector('[data-dt-target]');
        if (shownLines(host).length !== 1) bad.push(mode + ' 被拆成了多行：' + JSON.stringify(shownLines(host)));
        if (host.textContent.indexOf(BSL + 'n') < 0) bad.push(mode + ' 字面 \\n 被改掉了');
      });
    });
    return bad.length ? bad.join('；') : true;
  });

  check('长段落切分：每一段都是原文原样子串，拼回与原文逐字相同（3.5 / example.com / 10:30 / 中文引号不被插空格）', function () {
    var en = new Array(31).join('Version 3.5 is out at example.com today. Meet me at 10:30, e.g. after lunch. ').trim();
    var zh = new Array(121).join('「你好。今天是什么日子？」她问。');
    var bad = [];
    [['en', en], ['zh', zh]].forEach(function (c) {
      var parts = DT.splitLong(c[1], 1200);
      if (parts.length < 2) bad.push(c[0] + ' 应拆成多段');
      if (parts.some(function (part) { return part.length > 1200 * 1.6; })) bad.push(c[0] + ' 有超长段');
      if (parts.some(function (part) { return c[1].indexOf(part) < 0; })) bad.push(c[0] + ' 某段不是原文子串（被插了字）');
      if (DT.joinSlots(parts, parts.seps) !== c[1]) bad.push(c[0] + ' 拼回与原文不一致');
    });
    if (DT.splitLong(zh, 1200).seps.some(function (sep) { return sep !== ''; })) bad.push('中文切点处原本没有空白');
    return bad.length ? bad.join('；') : true;
  });

  check('译文拼接分隔按目标语言：中 / 日句子之间不加空格，其它语言加空格，换行照旧', function () {
    var r = eq(DT.translationSeps([' ', '', '\n', '\n\n'], 'zh-CN'), ['', '', '\n', '\n\n']);
    if (r !== true) return 'zh：' + r;
    r = eq(DT.translationSeps([' ', '', '\n'], 'ja'), ['', '', '\n']);
    if (r !== true) return 'ja：' + r;
    r = eq(DT.translationSeps(['', ' ', '\n'], 'en'), [' ', ' ', '\n']);
    if (r !== true) return 'en：' + r;
    return eq(DT.joinSlots(['第一句。', '第二句。'], DT.translationSeps([' '], 'zh-CN')), '第一句。第二句。');
  });

  // ---------------- 0.8.4 悬停对照：句子 / 行 / 段落三级对应（纯函数） ----------------
  function sents(text) {
    return DT.hover.sentencesOf(text).map(function (r) { return text.slice(r[0], r[1]); });
  }

  check('句子切分：中文 / 日文 / 英文标点、引号、换行', function () {
    var cases = [
      ['他来了。她走了！真的吗？', ['他来了。', '她走了！', '真的吗？']],
      ['「じゃーん。今日は何の日？」「ポッキーの日。」と岩崎が言った。', ['「じゃーん。今日は何の日？」', '「ポッキーの日。」と岩崎が言った。']],
      ['“好的。”他说。“走吧！”', ['“好的。”他说。', '“走吧！”']],
      ['“Hello.” She left. Version 3.5 is out!', ['“Hello.”', 'She left.', 'Version 3.5 is out!']],
      ['He said "Stop." Then he left…', ['He said "Stop."', 'Then he left…']],
      ['第一行没有句号\n第二行。', ['第一行没有句号', '第二行。']],
      ['「没闭合的引号。\n下一行照常。断句。', ['「没闭合的引号。', '下一行照常。', '断句。']],
      // 0.9.3：不再见句点就断
      ['Mr. Smith met Dr. Jones at 5 p.m. on Monday. They left.', ['Mr. Smith met Dr. Jones at 5 p.m. on Monday.', 'They left.']],
      ['We discussed the economy, e.g. inflation. Smith et al. (2020) agree. See Fig. 3 here.', ['We discussed the economy, e.g. inflation.', 'Smith et al. (2020) agree.', 'See Fig. 3 here.']],
      ['J. K. Rowling wrote it. “Really?” she asked. I said no. Then I left.', ['J. K. Rowling wrote it.', '“Really?” she asked.', 'I said no.', 'Then I left.']],
      ['"Wait!" he shouted. Wait... then he came.', ['"Wait!" he shouted.', 'Wait... then he came.']],
      ['1. Introduction', ['1. Introduction']],
      ['It was 3.5 in 2019. 2020 was worse. Node.js is great.', ['It was 3.5 in 2019.', '2020 was worse.', 'Node.js is great.']],
      // 脚注号紧跟句号：归前一句
      ['they were at home.11 Since then, it grew.', ['they were at home.11', 'Since then, it grew.']],
      ['Growth was strong.[12] Poverty fell.¹³ It ended.', ['Growth was strong.[12]', 'Poverty fell.¹³', 'It ended.']],
      ['2023年增长放缓。[4] 然而通胀仍高。', ['2023年增长放缓。[4]', '然而通胀仍高。']],
      // 中西混排：半角问号后直接是汉字
      ['真的吗?我不知道。', ['真的吗?', '我不知道。']]
    ];
    var bad = cases.filter(function (c) { return JSON.stringify(sents(c[0])) !== JSON.stringify(c[1]); });
    return bad.length ? bad.map(function (c) { return JSON.stringify(sents(c[0])); }).join(' | ') : true;
  });

  check('句子对齐：一对多 / 多对一 / 不可确认', function () {
    var src = 'It rained. We waited for hours at the station. Then the train came.';
    var same = '下雨了。我们在车站等了好几个小时。然后火车来了。';
    var n = DT.units.sentencesIn(src, 0, src.length).length;
    var one = DT.units.alignmentOf([{ n: 1, t: '下雨了。' }, { n: 1, t: '我们在车站等了好几个小时。' }, { n: 1, t: '然后火车来了。' }], same, n);
    if (!one || one.parts.length !== 3) return '一对一没有建立';
    // 多源一译：前两句合成一个片段
    var many = DT.units.alignmentOf([{ n: 2, t: '下雨了，我们在车站等了好几个小时。' }, { n: 1, t: '然后火车来了。' }], '下雨了，我们在车站等了好几个小时。然后火车来了。', n);
    if (!many || many.parts[0].srcTo !== 2) return '多源一译没有记录源范围';
    // 一源多译：一句拆成两个片段（n=1 + n=1 覆盖同一句不可能；这里用 n=1 的片段各自对应一句）
    var split = DT.units.alignmentOf([{ n: 1, t: '下雨了。' }, { n: 1, t: '我们在车站等。' }, { n: 1, t: '等了好几个小时。' }, { n: 1, t: '然后火车来了。' }], '下雨了。我们在车站等。等了好几个小时。然后火车来了。', n);
    if (split) return 'n 总和超过源句数时不能算对齐';
    // 模型没遵守 / 片段不在最终译文里：一律 null（调用方降级为段落级）
    if (DT.units.alignmentOf([{ n: 1, t: '不存在的句子' }], same, 1)) return '片段不在译文里也算对齐';
    return DT.units.alignmentOf([], same, n) === null ? true : '空 parts 应返回 null';
  });

  function fakeUnit(text, align) {
    return {
      map: { text: text, chars: [] },
      sentences: DT.units.sentencesIn(text, 0, text.length),
      align: align || null
    };
  }

  check('悬停匹配（纯函数）：模型对齐优先；没有就本地对齐按句；整段合成一句时标段落级', function () {
    var H = DT.hover;
    var from = 'One. Two.\nThree.';
    var to = '一。二。\n三。';
    // 没有模型对齐：本地对齐（逐行、行内按句）
    var m = H.pairDual(fakeUnit(from, null), to, false, from.indexOf('Two'));
    var r = eq([m.scope, m.sourceText, m.targetText], ['sentence', 'Two.', '二。']);
    if (r !== true) return '无模型对齐时本地按句：' + r;
    m = H.pairDual(fakeUnit(from, null), to, true, to.indexOf('三'));
    r = eq([m.scope, m.sourceText], ['sentence', 'Three.']);
    if (r !== true) return '译文上反查：' + r;
    // 模型对齐优先：模型说前两句合成一组，就按组高亮
    var align = DT.units.alignmentOf([{ n: 2, t: '一。二。' }, { n: 1, t: '三。' }], to, 3);
    if (!align) return '对齐夹具无效';
    m = H.pairDual(fakeUnit(from, align), to, false, from.indexOf('Two'));
    r = eq([m.sourceText, m.targetText, m.scope], ['One. Two.', '一。二。', 'line']);
    if (r !== true) return '模型对齐应优先：' + r;
    // 三句被译成一句：只能整段对应
    m = H.pairDual(fakeUnit(from, null), '一，二，三。', false, from.indexOf('Two'));
    r = eq([m.scope, m.sourceText], ['paragraph', from]);
    if (r !== true) return r;
    // 单行单句的段落不再标「行级对应」
    m = H.pairDual(fakeUnit('Just one line, one sentence', null), '只有一行一句', false, 3);
    return eq(m.scope, 'sentence');
  });

  check('本地句子对齐：一对多 / 多对一 / 数字锚点 / 调换语序整段合并', function () {
    var U = DT.units;
    function shape(src, tgt) {
      var a = U.alignLocal(src, null, tgt);
      return a ? a.parts.map(function (p) { return [p.srcTo - p.srcFrom, p.tgtCount]; }) : null;
    }
    var cases = [
      ['It rained. We waited for hours at the station. Then the train came.', '下雨了，我们在车站等了好几个小时。然后火车来了。', [[2, 1], [1, 1]]],
      ['It rained heavily all morning and the roads were flooded. We waited. Then the train came.', '整个上午都在下大雨，道路被淹了。我们等着，然后火车来了。', [[1, 1], [2, 1]]],
      ['The committee, after months of deliberation and many heated arguments about the budget, finally approved the plan that would reshape the city. It was a historic day.', '委员会经过几个月的审议，并就预算进行了多次激烈争论。最终批准了这项将重塑城市的计划。这是历史性的一天。', [[1, 2], [1, 1]]],
      ['The museum opened in 1998. It houses more than 5,000 artworks. Most of them were donated by local families. Every year, about 300,000 people visit it.', '这座博物馆于1998年开馆。馆内收藏了5000多件艺术品，其中大部分由当地家庭捐赠。每年约有30万人前来参观。', [[1, 1], [2, 1], [1, 1]]],
      ['这项研究调查了2000名参与者，发现每天锻炼30分钟可以显著降低患心脏病的风险，而且这种效果在老年人中尤为明显。研究人员建议将锻炼纳入日常生活。', 'The study surveyed 2,000 participants. It found that exercising 30 minutes a day can significantly lower the risk of heart disease, and the effect is especially pronounced among older adults. The researchers recommend making exercise part of daily life.', [[1, 2], [1, 1]]],
      ['What is economic growth? Why does it matter? In this article, we explain the basics.', '什么是经济增长？它为什么重要？在本文中，我们将解释基本概念。', [[1, 1], [1, 1], [1, 1]]],
      // 模型调换了两句的顺序：没有单调对应，宁可整段，也不配错
      ['The first rule is simple. The second rule, however, is much harder to explain to beginners.', '第二条规则对初学者来说要难解释得多。第一条规则很简单。', [[2, 2]]]
    ];
    var bad = cases.filter(function (c) { return JSON.stringify(shape(c[0], c[1])) !== JSON.stringify(c[2]); });
    if (bad.length) return bad.map(function (c) { return JSON.stringify(shape(c[0], c[1])) + ' ≠ ' + JSON.stringify(c[2]); }).join(' | ');
    // 译文偏移与文本逐字对得上
    var src = 'One. Two.\nThree.';
    var tgt = '一。二。\n三。';
    var a = U.alignLocal(src, null, tgt);
    var r = eq(a.parts.map(function (p) { return tgt.slice(p.tgtFrom, p.tgtTo) === p.text ? p.text : '错位'; }), ['一。', '二。', '三。']);
    if (r !== true) return r;
    // 两边行数相同：行界一定是组界（即使长度更像跨行合并）
    a = U.alignLocal('A short line.\nAnother line that is quite a bit longer than the first one.', null, '短行。\n另一行。');
    return eq(a.parts.map(function (p) { return [p.srcFrom, p.srcTo]; }), [[0, 1], [1, 2]]);
  });

  check('悬停匹配（纯函数）：仅译文给鼠标下这句的原文；模型对齐偏移对不上时按页面实际译文本地对齐', function () {
    var H = DT.hover;
    var from = 'One. Two.\nThree.';
    var page = '一。二。\n三。';
    var m = H.pairReplaced(fakeUnit(from, null), page, page.indexOf('二'));
    var r = eq([m.scope, m.sourceText, page.slice(m.span[0], m.span[1])], ['sentence', 'Two.', '二。']);
    if (r !== true) return '无模型对齐时本地按句：' + r;
    var align = DT.units.alignmentOf([{ n: 1, t: '一。' }, { n: 1, t: '二。' }, { n: 1, t: '三。' }], '一。二。\n三。', 3);
    m = H.pairReplaced(fakeUnit(from, align), page, page.indexOf('二'));
    r = eq([m.scope, m.sourceText, page.slice(m.span[0], m.span[1])], ['sentence', 'Two.', '二。']);
    if (r !== true) return '有对齐时按句：' + r;
    // 两行被并成一行、三句被译成两句：本地对齐给出「两句原文 ↔ 一句译文」这一组
    var merged = '一，二。三。';
    m = H.pairReplaced(fakeUnit(from, null), merged, merged.indexOf('二'));
    r = eq([m.sourceText, merged.slice(m.span[0], m.span[1])], ['One. Two.', '一，二。']);
    if (r !== true) return '合并句：' + r;
    // 模型对齐的偏移是按另一段文本算的（页面实际文本前面多了字）→ 丢掉模型映射，按页面实际文本本地对齐
    var wrong = DT.units.alignmentOf([{ n: 1, t: '一。' }, { n: 1, t: '二。' }], '一。二。', 2);
    m = H.pairReplaced(fakeUnit('One. Two.', wrong), '前言一。二。', 3);
    return eq([m.sourceText, '前言一。二。'.slice(m.span[0], m.span[1])], ['One.', '前言一。']);
  });

  check('悬停对照·仅译文小说段落：鼠标在第 2 行 → 只高亮这一行的句子，气泡是第 2 行原文', function () {
    if (!window.Highlight || !CSS.highlights) return true;
    return withHoverFixture('<p id="hv-nv" style="white-space:pre-wrap"><span>「今日は何の日？」</span><br><span>「ポッキーの日だ。」</span></p><p id="hv-nv2">Elsewhere</p>', function (box) {
      var p = box.querySelector('#hv-nv');
      var prev = DT.state.mode;
      DT.state.mode = 'translation';
      try {
        var target = '「今天是什么日子？」\n「是百奇日。」';
        var align = DT.units.alignmentOf([{ n: 1, t: '「今天是什么日子？」' }, { n: 1, t: '「是百奇日。」' }], target, 2);
        if (!DT.inject(p, target, 'zh-CN', align)) return 'inject 返回 false';
      } finally {
        DT.state.mode = prev;
      }
      var line2 = p.querySelectorAll('span')[1].firstChild;
      var pt = pointOf(line2, '百奇');
      DT.hover.updateAt(pt.x, pt.y, line2.parentElement);
      var tip = document.querySelector('.dt-hover-tip');
      if (!tip || tip.hidden) return '没有弹出原文气泡';
      var tipBody = tip.querySelector('.dt-hover-body');
      if (!tipBody || tipBody.textContent !== '「ポッキーの日だ。」') return '气泡不是第 2 行原文：' + (tipBody ? tipBody.textContent : tip.textContent);
      return highlighted('dt-hover-target') === '「是百奇日。」' ? true : '高亮的不是鼠标下这一句：' + highlighted('dt-hover-target');
    });
  });

  check('悬停对照·仅译文：模型把三行并成两句 → 气泡给对应的两行原文、高亮那一句译文', function () {
    if (!window.Highlight || !CSS.highlights) return true;
    return withHoverFixture('<p id="hv-mg" style="white-space:pre-wrap"><span>「今日は何の日？」</span><br><span>「ポッキーの日だ。」</span><br><span>「勝負しよう。」</span></p>', function (box) {
      var p = box.querySelector('#hv-mg');
      var prev = DT.state.mode;
      DT.state.mode = 'translation';
      try {
        DT.inject(p, '「今天是什么日子？」「是百奇日，来比一场。」', 'zh-CN');
      } finally {
        DT.state.mode = prev;
      }
      var node = p.querySelector('span').firstChild;
      var pt = pointOf(node, '百奇');
      DT.hover.updateAt(pt.x, pt.y, node.parentElement);
      var tip = document.querySelector('.dt-hover-tip');
      if (!tip || tip.hidden) return '没有弹出原文气泡';
      var r = eq(tip.querySelector('.dt-hover-body').textContent, '「ポッキーの日だ。」\n「勝負しよう。」');
      if (r !== true) return '应给第 2、3 行原文：' + r;
      return highlighted('dt-hover-target') === '「是百奇日，来比一场。」' ? true : '应只高亮鼠标下这句：' + highlighted('dt-hover-target');
    });
  });

  check('悬停对照·双语小说段落：鼠标在原文第 2 行 → 译文高亮第 2 行', function () {
    if (!window.Highlight || !CSS.highlights) return true;
    return withHoverFixture('<p id="hv-dl" style="white-space:pre-wrap"><span>“Is it today?”</span><br><span>“Yes. It is Pocky Day.”</span></p>', function (box) {
      var p = box.querySelector('#hv-dl');
      var target = '“是今天吗？”\n“对。是百奇日。”';
      var align = DT.units.alignmentOf([{ n: 1, t: '“是今天吗？”' }, { n: 1, t: '“对。是百奇日。”' }], target, 2);
      if (!DT.inject(p, target, 'zh-CN', align)) return 'inject 返回 false';
      var node = p.querySelectorAll('span')[1].firstChild;
      var pt = pointOf(node, 'Pocky');
      DT.hover.updateAt(pt.x, pt.y, node.parentElement);
      // 引号里的一句对白整体算一句，不在引号里面断开
      var r = eq([highlighted('dt-hover-src'), highlighted('dt-hover-target')], ['“Yes. It is Pocky Day.”', '“对。是百奇日。”']);
      if (r !== true) return r;
      var t = p.querySelector('[data-dt-target]').firstChild;
      pt = pointOf(t, '是今天');
      DT.hover.updateAt(pt.x, pt.y, t.parentElement);
      return eq([highlighted('dt-hover-src'), highlighted('dt-hover-target')], ['“Is it today?”', '“是今天吗？”']);
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
    return eq(acts, ['toggle', 'mode', 'hover', 'selection', 'pin', 'provider', 'ball']);
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
    return provider === 'Switch provider (current: Gemini · flash)' ? true : '服务商说明不对：' + provider;
  });

  check('悬浮入口：悬停对照按钮的选中状态与中英文文案同步', function () {
    emitConfig({ dockEnabled: true, hoverCompare: true, uiLang: 'zh', page: {} });
    var root = DT.dock.root();
    var b = root.querySelector('[data-act="hover"]');
    if (!b) return '没有悬停对照按钮';
    if (b.getAttribute('aria-pressed') !== 'true') return '开启状态没有 aria-pressed';
    if (b.getAttribute('aria-label') !== '关闭悬停对照') return '中文开启文案不对：' + b.getAttribute('aria-label');

    emitConfig({ dockEnabled: true, hoverCompare: false, uiLang: 'en', page: {} });
    if (b.getAttribute('aria-pressed') !== 'false') return '关闭状态没有 aria-pressed=false';
    if (b.getAttribute('aria-label') !== 'Enable hover compare') return '英文关闭文案不对：' + b.getAttribute('aria-label');

    emitConfig({ dockEnabled: false, page: {} });
    DT.state.config = null;
    return true;
  });

  check('悬浮入口：服务商菜单只列有 Key 的，再点一次收起', function () {
    emitConfig({
      dockEnabled: true,
      providers: [
        { id: 'deepseek', name: 'DeepSeek', model: 'deepseek-chat', hasKey: true, current: true },
        { id: 'custom:2', name: '硅基流动', model: 'qwen', hasKey: true, current: false },
        { id: 'sftest', name: '没有 Key 的', model: 'x', hasKey: false, current: false }
      ],
      page: {}
    });
    var menu = DT.dock.menu();
    if (!menu) return '没有创建菜单节点';
    if (!menu.hidden) return '默认应该是收起的';
    DT.dock.run('provider');
    if (menu.hidden) return '点服务商按钮后菜单没打开';
    var items = menu.querySelectorAll('.menu-item');
    if (items.length !== 2) return '应只列出有 Key 的 2 家，实际 ' + items.length;
    if (items[0].getAttribute('aria-current') !== 'true') return '当前服务商没标记';
    if (items[1].textContent.indexOf('硅基流动') < 0) return '自定义服务商名字不对：' + items[1].textContent;
    DT.dock.run('provider');
    if (!menu.hidden) return '再点一次应收起';
    DT.state.config = null;
    return true;
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

  // ---- 0.9.3 拖拽与吸附：用配置驱动 place()，不依赖合成 pointer 事件（CI 的 Chrome
  //      对合成 PointerEvent 的派发/捕获行为与本地 Edge 不一致，会误报两条用例）----
  check('悬浮入口：贴左配置 → 吸附到左边，data-side 翻成 left', function () {
    emitConfig({ dockEnabled: true, dockAutoHide: false, dockSide: 'left', dockPos: null, page: {} });
    var host = DT.dock.host();
    var dockEl = DT.dock.root().querySelector('.dock');
    if (host.style.left !== '0px') return '没吸到左边：' + host.style.left;
    if (host.getAttribute('data-side') !== 'left') return 'data-side 没翻：' + host.getAttribute('data-side');
    if (!dockEl.hasAttribute('data-snapped')) return '吸边时该带 data-snapped';
    return true;
  });

  check('悬浮入口：dockPos 在页面中间 → 自由悬浮不吸附', function () {
    var vw = document.documentElement.clientWidth || window.innerWidth || 800;
    var mid = Math.round(vw / 2);
    emitConfig({ dockEnabled: true, dockAutoHide: false, dockSide: 'right', dockPos: { x: mid, y: 160 }, page: {} });
    var host = DT.dock.host();
    var dockEl = DT.dock.root().querySelector('.dock');
    var left = parseInt(host.style.left, 10);
    if (!(left > 0 && left + 56 <= vw)) return '位置不对：' + host.style.left + ' (vw=' + vw + ')';
    if (dockEl.hasAttribute('data-snapped')) return '中间不该吸附';
    return true;
  });

  check('悬浮入口：原地点按（不移动）不算拖拽，位置不变', function () {
    emitConfig({ dockEnabled: true, dockAutoHide: false, dockSide: 'right', dockPos: null, page: {} });
    var host = DT.dock.host();
    var before = host.style.left;
    var ball = DT.dock.root().querySelector('.ball');
    var r = ball.getBoundingClientRect();
    var pe = function (type) {
      return new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 9, isPrimary: true, button: 0, pointerType: 'mouse', clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
    };
    ball.dispatchEvent(pe('pointerdown'));
    ball.dispatchEvent(pe('pointerup'));
    if (host.style.left !== before) return '点按后位置变了：' + before + ' → ' + host.style.left;
    return true;
  });

  check('悬浮入口：配置里的 dockPos 优先于 dockSide，清空后回贴边', function () {
    emitConfig({ dockEnabled: true, dockAutoHide: false, dockSide: 'left', dockPos: { x: 400, y: 120 }, page: {} });
    var host = DT.dock.host();
    if (host.style.left !== '400px' || host.style.top !== '120px') return 'dockPos 没生效：' + host.style.left + ',' + host.style.top;
    emitConfig({ dockEnabled: true, dockAutoHide: false, dockSide: 'left', dockPos: null, page: {} });
    if (host.style.left !== '0px') return '清空后没回贴边：' + host.style.left;
    emitConfig({ dockEnabled: false, page: {} });
    return true;
  });

  // ---- 0.9.6 半隐藏几何：贴边收起时小球必须露出直径的一半 ----
  // 用真实 getBoundingClientRect 量，不猜百分比；量之前把 host 的 left 过渡和 .dock 的 transform 过渡都关掉：
  // 这里断言的是最终几何，动画本身由真实 Chrome E2E 用鼠标移入 / 移出验证，
  // 关掉过渡也不会让 CI 的虚拟时间卡在动画中间。
  function measureDock(cfg) {
    if (!DT.dock.root()) emitConfig({ dockEnabled: true, page: {} });
    DT.dock.setOpen(false);
    var hostEl = DT.dock.host();
    var dockEl = DT.dock.root().querySelector('.dock');
    // host 的 left 有 0.16s 过渡、.dock 的 transform 有 0.32s 过渡：同步测量会读到过渡起点
    // （style.left 已是目标值、getBoundingClientRect 还是旧位置）。这里量的是最终几何，
    // 先把两处过渡都关掉；动画本身由真实 Chrome E2E 用鼠标移入 / 移出验证。
    var prevHost = hostEl.style.transition;
    var prevDock = dockEl.style.transition;
    hostEl.style.transition = 'none';
    dockEl.style.transition = 'none';
    emitConfig(cfg);
    var ball = DT.dock.root().querySelector('.ball').getBoundingClientRect();
    var vw = document.documentElement.clientWidth || window.innerWidth || 0;
    var out = {
      vw: vw,
      left: Math.round(ball.left),
      right: Math.round(ball.right),
      width: Math.round(ball.width),
      top: Math.round(ball.top),
      visible: Math.round(Math.max(0, Math.min(ball.right, vw) - Math.max(ball.left, 0))),
      transform: getComputedStyle(dockEl).transform
    };
    hostEl.style.transition = prevHost;
    dockEl.style.transition = prevDock;
    return out;
  }

  check('悬浮入口·自动隐藏：右侧贴边露出半个小球（真实矩形）', function () {
    var m = measureDock({ dockEnabled: true, dockAutoHide: true, dockSide: 'right', dockPos: null, page: {} });
    var half = m.width / 2;
    if (!(m.right > m.vw)) {
      var dh = DT.dock.host();
      return '小球没有缩进视口外：' + JSON.stringify(m) +
        ' host=' + dh.style.left + ' side=' + dh.getAttribute('data-side') +
        ' hostRect=' + JSON.stringify(dh.getBoundingClientRect()) +
        ' view=' + JSON.stringify(DT.dock.view());
    }
    if (m.visible < half - 1.5) return '露得太少：' + JSON.stringify(m) + '，半宽 ' + half;
    return true;
  });

  check('悬浮入口·自动隐藏：左侧贴边露出半个小球（真实矩形）', function () {
    var m = measureDock({ dockEnabled: true, dockAutoHide: true, dockSide: 'left', dockPos: null, page: {} });
    var half = m.width / 2;
    if (!(m.left < 0)) return '小球没有缩进视口外：' + JSON.stringify(m);
    if (m.visible < half - 1.5) return '露得太少：' + JSON.stringify(m) + '，半宽 ' + half;
    return true;
  });

  check('悬浮入口·自动隐藏：展开后完整显示，收起再回到半个', function () {
    var hostEl = DT.dock.host();
    var dockEl = DT.dock.root().querySelector('.dock');
    var prevHost = hostEl.style.transition;
    var prev = dockEl.style.transition;
    hostEl.style.transition = 'none';
    dockEl.style.transition = 'none';
    emitConfig({ dockEnabled: true, dockAutoHide: true, dockSide: 'right', dockPos: null, page: {} });
    var vw = document.documentElement.clientWidth || window.innerWidth || 0;
    DT.dock.setOpen(true);
    var openRect = DT.dock.root().querySelector('.ball').getBoundingClientRect();
    var openOk = openRect.right <= vw - 1 && openRect.left >= 0;
    DT.dock.setOpen(false);
    var closedRect = DT.dock.root().querySelector('.ball').getBoundingClientRect();
    var visible = Math.max(0, Math.min(closedRect.right, vw) - Math.max(closedRect.left, 0));
    var half = closedRect.width / 2;
    hostEl.style.transition = prevHost;
    dockEl.style.transition = prev;
    if (!openOk) return '展开后小球没有完全回到视口内：' + JSON.stringify({ left: Math.round(openRect.left), right: Math.round(openRect.right), vw: vw });
    if (visible < half - 1.5) return '收起后没有回到半个：visible=' + Math.round(visible) + '，半宽=' + half;
    return true;
  });

  check('悬浮入口·自动隐藏：关掉自动隐藏时完整显示', function () {
    var m = measureDock({ dockEnabled: true, dockAutoHide: false, dockSide: 'right', dockPos: null, page: {} });
    if (m.right > m.vw) return '关掉自动隐藏后仍缩进视口外：' + JSON.stringify(m);
    return true;
  });

  check('悬浮入口·自动隐藏：页面中间自由悬浮不缩进', function () {
    var vw = document.documentElement.clientWidth || window.innerWidth || 800;
    var m = measureDock({ dockEnabled: true, dockAutoHide: true, dockSide: 'right', dockPos: { x: Math.round(vw / 2), y: 160 }, page: {} });
    if (m.transform !== 'none') return '自由悬浮不该有半隐藏位移：' + m.transform;
    if (m.left < 0 || m.right > m.vw) return '自由悬浮不该缩进：' + JSON.stringify(m);
    return true;
  });

  check('悬浮入口·自动隐藏：测完收起，不影响后面的用例', function () {
    emitConfig({ dockEnabled: false, page: {} });
    DT.state.config = null;
    return document.getElementById('dt-dock') ? '关掉后还在' : true;
  });


  // own 单元（子元素被跳过 / 已翻过，只翻直接文本）原地替换时，只改送去翻译的那些文本节点
  check('仅译文：own 单元不清空 notranslate / translate="no" / 已翻过的子元素', function () {
    var box = document.createElement('div');
    box.innerHTML =
      '<p id="own-nt">Hello <span class="notranslate">Rimefox</span> world</p>' +
      '<p id="own-lines">Line one <span translate="no">Brand</span><br>Line two</p>' +
      '<p id="own-done">Intro text <a href="#x">Read more</a> tail</p>';
    document.body.appendChild(box);
    var mode = DT.state.mode;
    DT.state.mode = 'translation';
    try {
      var nt = DT.collect(box.querySelector('#own-nt'));
      if (nt.length !== 1 || !nt[0].own || nt[0].text !== 'Hello world') return 'own 单元收集不对：' + JSON.stringify(nt.map(function (u) { return [u.text, !!u.own]; }));
      if (!DT.inject(nt[0].el, '你好 世界', 'zh-CN', true)) return 'inject 返回 false';
      var p1 = box.querySelector('#own-nt');
      if (p1.querySelector('.notranslate').textContent !== 'Rimefox') return 'notranslate 被清空：' + p1.textContent;

      var lines = DT.collect(box.querySelector('#own-lines'));
      if (lines.length !== 1 || lines[0].text !== 'Line one\nLine two') return '分行 own 单元收集不对：' + JSON.stringify(lines.map(function (u) { return u.text; }));
      if (!DT.inject(lines[0].el, '第一行\n第二行', 'zh-CN', true)) return '分行 inject 返回 false';
      var p2 = box.querySelector('#own-lines');
      if (p2.querySelector('[translate="no"]').textContent !== 'Brand') return 'translate="no" 被清空：' + p2.textContent;
      if (p2.textContent.indexOf('第一行') < 0 || p2.textContent.indexOf('第二行') < 0) return '分行译文没写进去：' + p2.textContent;

      var p3 = box.querySelector('#own-done');
      if (!DT.inject(p3.querySelector('a'), '阅读更多', 'zh-CN')) return '链接 inject 返回 false';
      var rest = DT.collect(p3);
      if (rest.length !== 1 || !rest[0].own) return '父级应是 own 单元：' + rest.length;
      if (!DT.inject(rest[0].el, '开头 结尾', 'zh-CN', true)) return '父级 inject 返回 false';
      if (p3.querySelector('a').textContent !== '阅读更多') return '已翻过的链接被覆盖：' + p3.textContent;

      DT.restore();
      return eq(
        [p1.textContent, p2.textContent, p3.textContent],
        ['Hello Rimefox world', 'Line one BrandLine two', 'Intro text Read more tail']
      );
    } finally {
      DT.state.mode = mode;
      box.remove();
    }
  });

  // 后台补注入（ensureInjected）和 manifest 声明的脚本可能在同一页各跑一次：
  // core.js / dom.js 再跑不能清空状态、订阅和原地替换的记录
  checkAsync('重复注入：再跑一遍 core.js / dom.js 不清空 DT.state、onConfig 订阅和 DT.replaced', function () {
    function load(src) {
      return new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = function () {
          reject(new Error('加载失败：' + src));
        };
        document.body.appendChild(s);
      });
    }
    var state = DT.state;
    var replaced = DT.replaced;
    var emit = DT.emitConfig;
    var fired = 0;
    DT.onConfig(function () {
      fired += 1;
    });
    var before = fired; // 当时已有配置的话 onConfig 会立刻回调一次
    return load('../content/core.js')
      .then(function () {
        return load('../content/dom.js');
      })
      .then(function () {
        DT.emitConfig({ page: {} });
        return eq(
          [DT.state === state, DT.replaced === replaced, DT.emitConfig === emit, fired - before],
          [true, true, true, 1]
        );
      });
  });

  // ---------------- 渲染（等排队的异步用例逐个跑完） ----------------
  asyncChecks
    .reduce(function (chain, next) {
      return chain.then(next);
    }, Promise.resolve())
    .then(render);

  function render() {
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
  var failed = results.filter(function (r) {
    return !r.ok;
  }).map(function (r) {
    return r.name;
  });
  summary.className = allPass ? 'pass' : 'fail';
  summary.textContent = passed + ' / ' + results.length + (allPass ? '  全部通过' : '  存在失败项：' + failed.slice(0, 3).join('；'));
  }
})();
