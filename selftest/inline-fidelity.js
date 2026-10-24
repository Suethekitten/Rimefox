// Shared deterministic DOM checks; no external page or model request.
(function () {
  'use strict';
  window.runInlineFidelityChecks = function (options) {
    options = options || {};
    var DT = window.__DT;
    var checks = [];
    var evidence = [];
    var template = document.getElementById('tpl-inline-fidelity');
    function check(name, ok, detail) { checks.push({ name: name, ok: !!ok, detail: detail || '' }); }
    if (!template) return { checks: [{ name: 'fidelity:fixture', ok: false, detail: 'Missing tpl-inline-fidelity' }], evidence: [] };
    var box = document.createElement('div');
    box.appendChild(template.content.cloneNode(true));
    (document.getElementById('fixture') || document.body).appendChild(box);
    var mode = DT.state.mode;
    var target = DT.state.target;
    var config = DT.state.config;
    var started = performance.now();
    var metrics = { cases: 0, units: 0, collectMs: 0, injectMs: 0, writes: { childList: 0, characterData: 0, attributes: 0 } };
    function allNodes(p) {
      var out = [], walker = document.createTreeWalker(p, NodeFilter.SHOW_ALL);
      for (var n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
      return out;
    }
    function attrs(el) {
      return JSON.stringify(Array.prototype.map.call(el.attributes, function (a) { return [a.name, a.value]; }));
    }
    function sameNodes(a, b) { return a.length === b.length && a.every(function (n, i) { return n === b[i]; }); }
    function collect(p) {
      var t = performance.now(), units = DT.collect(p);
      metrics.collectMs += performance.now() - t;
      metrics.units += units.length;
      return units;
    }
    function inject(unit, text, lang) {
      var observer = new MutationObserver(function () {});
      observer.observe(unit.el, { subtree: true, childList: true, characterData: true, attributes: true });
      var t = performance.now(), ok;
      try { ok = DT.inject(unit, text, lang || 'zh-CN'); }
      finally {
        metrics.injectMs += performance.now() - t;
        observer.takeRecords().forEach(function (r) { metrics.writes[r.type] += 1; });
        observer.disconnect();
      }
      return ok;
    }
    function phraseStyle(root, phrase) {
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), out = [];
      for (var n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.nodeValue.indexOf(phrase) < 0) continue;
        var cs = getComputedStyle(n.parentElement);
        out.push({ weight: parseInt(cs.fontWeight, 10) || (cs.fontWeight === 'bold' ? 700 : 400), italic: cs.fontStyle === 'italic', size: parseFloat(cs.fontSize), vertical: cs.verticalAlign, parent: n.parentElement.tagName });
      }
      return out;
    }
    function translated(unit, pairs) {
      var value = unit.wire || unit.text;
      var atoms = [];
      value = value.replace(/<k\d+>[\s\S]*?<\/k\d+>/g, function (atom) {
        if (/<f\d+>/.test(atom)) return atom;
        atoms.push(atom); return '\u0001' + (atoms.length - 1) + '\u0002';
      });
      pairs.slice().sort(function (a, b) { return b[0].length - a[0].length; }).forEach(function (pair) { value = value.split(pair[0]).join(pair[1]); });
      value = value.replace(/\u0001(\d+)\u0002/g, function (_, id) { return atoms[Number(id)]; });
      return value;
    }
    var cases = {
      plain: [['Hello beautiful world. Please read this sentence before continuing.', '你好，美丽的世界。继续之前请阅读这句话。']],
      strong: [['Hello ', '你好，'], ['beautiful', '美丽的'], [' world. Please continue carefully.', '世界。请谨慎继续。']],
      'leading-bold': [['Important:', '重要：'], [' the remaining sentence must retain normal body weight.', '其余句子应保留正常字重。']],
      em: [['The ', ''], ['uncertain', '不确定的'], [' result requires further evidence before publication.', '结果需要更多证据才能发表。']],
      italic: [['The article describes an ', '文章介绍了第二次实验中的'], ['unusual', '异常'], [' result in the second experiment.', '结果。']],
      nested: [['The ', ''], ['important ', '重要而'], ['uncertain', '不确定的'], [' result', '结果'], [' needs a careful interpretation.', '需要谨慎解读。']],
      'span-inherited': [['This result is ', '这个结果'], ['highly uncertain', '高度不确定'], [' and needs more evidence.', '，需要更多证据。']],
      family: [['The ', ''], ['primary result', '主要结果'], [' remains distinct from ordinary body text.', '仍与普通正文有别。']],
      code: [['Call ', '启动翻译请求之前，请调用'], [' before starting the translation request.', '。']],
      small: [['The study is complete, ', '研究已完成，'], ['although the findings remain preliminary', '但结果仍属初步'], [', and further work is planned.', '，后续研究已在计划中。']],
      'sup-sub': [['The value x', '数值x'], [' and the formula H', '与分子式H'], ['O occur in the same explanatory sentence.', 'O出现在同一句说明中。']],
      'relative-note': [['Normal body text precedes a ', '正常正文后有'], ['brief aside', '简短旁注'], [' and continues at normal size.', '，随后恢复正常字号。']],
      'article-link': [['Read the ', '继续之前，请阅读'], ['documentation', '文档'], [' before continuing with the remaining instructions.', '并遵循其余说明。']],
      'nested-link': [['Read the ', '开始下一任务之前，请阅读'], ['complete', '完整'], [' documentation', '文档'], [' before starting the next task.', '。']],
      'mention-link': [['The researcher ', '研究者'], [' shared a new explanation of the experiment.', '分享了对实验的新解释。']],
      protected: [['Translate this text around ', '翻译以下内容附近的正文：'], [' and ', '和'], [' while preserving their nodes.', '，同时保留它们的节点。']],
      excluded: [['The surrounding explanation contains ', '周围的说明包含'], [' and continues as ordinary translatable prose.', '，接着是普通可翻译正文。']],
      citation: [['The ', ''], ['observed', '观察到的'], [' association was reported previously', '关联此前已有报道'], [' and is shown in ', '，并见'], ['Fig. 1', '图 1']],
      ruby: [['At dusk the ', '黄昏时，'], [' gate stood beside a ', '门立在'], ['quiet', '安静的'], [' street with no visitors.', '街道旁，空无一人。']],
      icons: [['Open the ', '打开'], ['advanced', '高级'], [' menu and continue with the instructions.', '菜单并继续执行说明。']],
      rtl: [['هذه نتيجة ', '这是一项'], ['مهمة', '重要'], [' مع رابط ', '结果，并带有'], ['الدليل', '指南'], [' للمستخدم.', '链接。']],
      prewrap: [['First ', '第一行：'], ['important', '重要'], [' line.', '。'], ['Second line with ', '第二行有'], ['uncertain', '不确定的'], [' evidence.', '证据。'], ['Final line with ', '最后一行附有'], ['details', '详情']],
      whitespace: [['Text with ', '正文有'], ['mixed spaces', '混合空格'], [', inline ', '、行内'], ['line breaks', '换行'], [' and a final sentence.', '以及最后一句话。']],
      'cross-node': [['Before ', '在'], ['the ', ''], ['careful', '谨慎的'], [' scientist ', '科学家'], ['published', '发表'], [' the final result, the team checked it twice.', '最终结果之前，团队复核了两遍。']],
      'font-policy': [['Original site typography surrounds ', '原站排版包围着'], ['local emphasis', '局部强调'], [' and must survive both translation modes.', '，两种翻译模式都应保留原排版。']],
      dynamic: [['The original ', '原来的'], ['dynamic result', '动态结果'], [' is replaced by the website during an in-flight translation.', '在翻译请求期间被网站更新。']]
    };
    var semantic = {
      strong: ['美丽的', 'bold', '世界'], 'leading-bold': ['重要：', 'bold', '其余句子'], em: ['不确定的', 'italic', '结果'],
      italic: ['异常', 'italic', '结果'], nested: ['不确定的', 'both', '需要'], 'span-inherited': ['高度不确定', 'both', '需要'],
      small: ['但结果仍属初步', 'small', '后续'], 'relative-note': ['简短旁注', 'small', '恢复'], family: ['主要结果', 'bold', '普通正文'],
      'cross-node': ['谨慎的', 'bold', '团队'], 'font-policy': ['局部强调', 'bold', '两种'], icons: ['高级', 'bold', '菜单']
    };
    function verifySemantic(name, p, root) {
      var spec = semantic[name];
      if (!spec) return;
      var styled = phraseStyle(root, spec[0]);
      var normal = phraseStyle(root, spec[2]);
      var bodySize = parseFloat(getComputedStyle(p).fontSize);
      var right = styled.length > 0 && styled.every(function (s) {
        if (spec[1] === 'bold') return s.weight >= 600;
        if (spec[1] === 'italic') return s.italic;
        if (spec[1] === 'both') return s.weight >= 600 && s.italic;
        return s.size < bodySize;
      });
      check(name + ':correct-semantic-fragment', right, JSON.stringify(styled));
      check(name + ':unrelated-fragment-not-emphasized', normal.length > 0 && normal.every(function (s) { return s.weight < 600 && !s.italic && s.size >= bodySize - .1; }), JSON.stringify(normal));
    }
    try {
      DT.state.mode = 'translation';
      DT.state.target = 'zh-CN';
      Array.prototype.slice.call(box.querySelectorAll('[data-fidelity-case]')).forEach(function (p) {
        var name = p.getAttribute('data-fidelity-case');
        metrics.cases += 1;
        var original = p.outerHTML, originals = allNodes(p), links = Array.prototype.slice.call(p.querySelectorAll('a'));
        var linkAttrs = links.map(attrs), linkTextNodes = links.map(function (a) { return a.firstChild; });
        var protectedEls = Array.prototype.slice.call(p.querySelectorAll('.notranslate,[translate="no"],.fixture-site-excluded,ruby,svg'));
        var protectedHtml = protectedEls.map(function (el) { return el.outerHTML; });
        var annotationText = protectedEls.map(function (el) { return Array.prototype.map.call(el.querySelectorAll('rt,rp'), function (n) { return n.textContent; }).join('|'); });
        var clicked = 0;
        function click(e) { e.preventDefault(); clicked += 1; }
        links.forEach(function (a) { a.addEventListener('click', click); });
        if (name === 'excluded') DT.setSiteRule({ excludeSelectors: ['.fixture-site-excluded'] });
        var units = collect(p);
        check(name + ':collect', units.length > 0);
        units.forEach(function (unit) {
          var text = translated(unit, cases[name]);
          var ok = inject(unit, text);
          check(name + ':inject', ok, JSON.stringify(unit.injectResult));
          var rubyOnly = name === 'ruby' && unit.renderMode === 'ruby';
          check(name + ':translation-mode-stays-in-place', rubyOnly ? p.querySelectorAll('[data-dt-target]').length === 1 && p.textContent.indexOf('At dusk') < 0 : !p.querySelector('[data-dt-target]') && unit.renderMode !== 'dual', unit.renderMode);
          if (name === 'strong') check('strong:wire-preserves-semantic-range', /<f\d+>beautiful<\/f\d+>/.test(unit.wire || ''), unit.wire || '');
          if (name === 'protected') check('protected:not-sent-to-model', (unit.wire || '').indexOf('AcmeSecretBrand') < 0 && (unit.wire || '').indexOf('private-account-42') < 0 && /<k\d+><\/k\d+>/.test(unit.wire || ''), unit.wire || '');
          if (name === 'excluded') check('excluded:not-sent-to-model', (unit.wire || '').indexOf('SiteExcludedSecret') < 0 && /<k\d+><\/k\d+>/.test(unit.wire || ''), unit.wire || '');
          evidence.push({ name: name, wire: unit.wire || unit.text, formats: (unit.formats || []).map(function (f) { return { id: f.id, tag: f.tag, start: f.start, end: f.end }; }), result: unit.injectResult, rendered: p.outerHTML.slice(0, 1500) });
        });
        verifySemantic(name, p, p);
        if (name === 'nested') check('nested:outer-bold-only', phraseStyle(p, '重要而').some(function (s) { return s.weight >= 600 && !s.italic; }));
        if (name === 'article-link') check('article-link:label-translated', links[0].textContent === '文档' && links[0].firstChild === linkTextNodes[0], links[0].outerHTML);
        if (name === 'article-link') check('article-link:body-outside-link', !links[0].textContent.includes('继续') && p.textContent.indexOf('继续') >= 0);
        if (name === 'sup-sub') check('sup-sub:normal-body-outside-script', phraseStyle(p, '数值x').every(function (s) { return s.parent !== 'SUP' && s.parent !== 'SUB'; }) && p.querySelector('sup').textContent === '2' && p.querySelector('sub').textContent === '2');
        if (name === 'rtl') check('rtl:target-direction-isolated', getComputedStyle(p).direction === 'ltr' && p.textContent.indexOf('指南') >= 0);
        if (name === 'prewrap') check('prewrap:blank-line-and-order', /^第一行：重要。\n第二行有不确定的证据。\n\n最后一行附有详情\.$/.test(p.innerText.replace(/\r/g, '')), JSON.stringify(p.innerText));
        check(name + ':original-links-attributes', links.every(function (a, i) { return p.contains(a) && attrs(a) === linkAttrs[i]; }));
        links.forEach(function (a) { a.click(); });
        check(name + ':original-link-events', clicked === links.length);
        check(name + ':protected-node-content', protectedEls.every(function (el, i) {
          if (name === 'ruby' && el.tagName === 'RUBY') return p.contains(el) && Array.prototype.map.call(el.querySelectorAll('rt,rp'), function (n) { return n.textContent; }).join('|') === annotationText[i] && Array.prototype.every.call(el.querySelectorAll('rt,rp'), function (n) { return getComputedStyle(n).display === 'none'; });
          return p.contains(el) && el.outerHTML === protectedHtml[i];
        }));
        if (name === 'ruby') check('ruby:formatted-target-never-writes-annotations', phraseStyle(p, '安静的').some(function (s) { return s.italic; }) && Array.prototype.every.call(p.querySelectorAll('rt,rp'), function (n) { return n.textContent.indexOf('安静的') < 0; }));
        DT.restore();
        if (name === 'excluded') DT.setSiteRule(null);
        check(name + ':precise-transaction-restore', p.outerHTML === original && sameNodes(originals, allNodes(p)));
        links.forEach(function (a) { a.removeEventListener('click', click); });
      });

      var strong = box.querySelector('[data-fidelity-case="strong"]');
      var strongOriginal = strong.outerHTML, strongNodes = allNodes(strong);
      ['dual', 'translation', 'dual', 'translation'].forEach(function (oneMode, index) {
        DT.state.mode = oneMode;
        DT.state.target = index === 3 ? 'ja' : 'zh-CN';
        var unit = collect(strong)[0];
        var text = translated(unit, cases.strong);
        if (index === 3) text = text.replace('你好，', 'こんにちは、').replace('美丽的', '美しい').replace('世界。请谨慎继续。', '世界。慎重に続けてください。');
        check('lifecycle:' + index + ':inject', inject(unit, text, DT.state.target));
        var root = oneMode === 'dual' ? strong.querySelector('[data-dt-target]') : strong;
        check('lifecycle:' + index + ':no-duplicate-target', strong.querySelectorAll('[data-dt-target]').length === (oneMode === 'dual' ? 1 : 0));
        if (index !== 3 && root) verifySemantic('strong', strong, root);
        if (oneMode === 'dual' && root) check('lifecycle:dual-site-font', getComputedStyle(root).fontFamily === getComputedStyle(strong).fontFamily && !root.querySelector('[data-dt-font]'), getComputedStyle(root).fontFamily);
        if (oneMode === 'translation') check('lifecycle:target-font-preserves-size', phraseStyle(strong, index === 3 ? '美しい' : '美丽的').every(function (s) { return s.size === parseFloat(getComputedStyle(strong).fontSize); }));
        check('lifecycle:' + index + ':duplicate-inject-refused', !inject(unit, text, DT.state.target));
        DT.restore();
        check('lifecycle:' + index + ':exact-restore-no-shells', strong.outerHTML === strongOriginal && sameNodes(strongNodes, allNodes(strong)));
        check('lifecycle:' + index + ':old-request-refused', !inject(unit, text, DT.state.target) && strong.outerHTML === strongOriginal);
      });

      var fontP = box.querySelector('[data-fidelity-case="font-policy"]'), fontBefore = fontP.outerHTML, fontNodes = allNodes(fontP);
      ['dual', 'translation'].forEach(function (fontMode) {
        DT.state.mode = fontMode; DT.state.target = 'zh-CN';
        var unit = collect(fontP)[0];
        check('font-policy:' + fontMode + ':inject', inject(unit, translated(unit, cases['font-policy'])));
        if (fontMode === 'dual') {
          var targetNode = fontP.querySelector('[data-dt-target]');
          check('font-policy:dual-foreign-source-font-inherited', !!targetNode && getComputedStyle(targetNode).fontFamily === getComputedStyle(fontP).fontFamily && !targetNode.querySelector('[data-dt-font]') && !targetNode.hasAttribute('data-dt-font'));
        } else check('font-policy:translation-target-font-shell', fontP.querySelectorAll('[data-dt-font]').length > 0 && phraseStyle(fontP, '局部强调').some(function (s) { return s.weight >= 600 && s.size === 19; }));
        DT.restore();
        check('font-policy:' + fontMode + ':precise-restore', fontP.outerHTML === fontBefore && sameNodes(fontNodes, allNodes(fontP)));
      });

      DT.state.mode = 'translation'; DT.state.target = 'zh-CN';
      var cross = box.querySelector('[data-fidelity-case="cross-node"]'), crossBefore = cross.outerHTML, crossNodes = allNodes(cross);
      var reordered = collect(cross)[0], careful = null, published = null;
      (reordered.formats || []).forEach(function (f) {
        if (f.el.getAttribute('data-semantic') === 'careful') careful = f.id;
        if (f.el.getAttribute('data-semantic') === 'published') published = f.id;
      });
      check('reorder:independent-format-identities', careful != null && published != null);
      var reorderedText = '<f' + (published || 2) + '>发表</f' + (published || 2) + '>最终结果的是<f' + (careful || 1) + '>谨慎的</f' + (careful || 1) + '>科学家。';
      check('reorder:inject', inject(reordered, reorderedText), JSON.stringify(reordered.injectResult));
      check('reorder:semantic-ranges-follow-target-order', cross.textContent.indexOf('发表') < cross.textContent.indexOf('谨慎的') && phraseStyle(cross, '发表').some(function (s) { return s.italic && s.weight < 600; }) && phraseStyle(cross, '谨慎的').some(function (s) { return s.weight >= 600 && !s.italic; }));
      DT.restore();
      check('reorder:exact-node-restore', cross.outerHTML === crossBefore && sameNodes(crossNodes, allNodes(cross)));

      var bads = [
        ['unknown-format', function (s) { return s + '<f999>虚假</f999>'; }],
        ['missing-format-close', function (s) { return s.replace(/<\/f\d+>/, ''); }],
        ['duplicate-format', function (s) { var m = /<f\d+>[\s\S]*?<\/f\d+>/.exec(s); return s + (m ? m[0] : '<f1>美丽的</f1><f1>美丽的</f1>'); }],
        ['unknown-atom', function (s) { return s + '<k999></k999>'; }],
        ['foreign-html-is-text', function (s) { return s + '<img src=x onerror="window.__fidelityXss=1">'; }]
      ];
      bads.forEach(function (bad) {
        var unit = collect(strong)[0], value = bad[1](translated(unit, cases.strong));
        var before = strong.outerHTML, beforeNodes = allNodes(strong), observer = new MutationObserver(function () {});
        observer.observe(strong, { subtree: true, childList: true, characterData: true, attributes: true });
        var ok = inject(unit, value);
        var records = observer.takeRecords(); observer.disconnect();
        if (bad[0] === 'foreign-html-is-text') {
          check('invalid:html-never-parsed', !strong.querySelector('img') && !window.__fidelityXss);
        } else {
          check('invalid:' + bad[0] + ':refused', !ok && unit.injectResult && unit.injectResult.code === 'invalid-placement', JSON.stringify(unit.injectResult));
          check('invalid:' + bad[0] + ':zero-write', records.length === 0 && strong.outerHTML === before && sameNodes(beforeNodes, allNodes(strong)), String(records.length));
        }
        DT.restore();
      });
      var nested = box.querySelector('[data-fidelity-case="nested"]'), nestedUnit = collect(nested)[0], nestedBefore = nested.outerHTML;
      var nestedValue = translated(nestedUnit, cases.nested), closes = nestedValue.match(/<\/f\d+>/g) || [];
      if (closes.length >= 2) nestedValue = nestedValue.replace(closes[0], '\u0001').replace(closes[1], closes[0]).replace('\u0001', closes[1]);
      else nestedValue = '<f1>重要而<f2>不确定的</f1>结果</f2>需要谨慎解读。';
      check('invalid:crossed-format-nesting', !inject(nestedUnit, nestedValue) && nested.outerHTML === nestedBefore, JSON.stringify(nestedUnit.injectResult));
      DT.restore();
      var missing = collect(strong)[0], missingValue = translated(missing, cases.strong).replace(/<\/?f\d+>/g, '');
      check('fallback:all-formats-missing-still-translates', inject(missing, missingValue));
      check('fallback:never-force-wrong-bold', strong.textContent.indexOf('美丽的世界') >= 0 && phraseStyle(strong, '世界').every(function (s) { return s.weight < 600; }));
      DT.restore();

      var linkP = box.querySelector('[data-fidelity-case="article-link"]');
      ['missing', 'duplicate', 'leak'].forEach(function (kind) {
        var unit = collect(linkP)[0], value = translated(unit, cases['article-link']), match = /<k\d+>[\s\S]*?<\/k\d+>/.exec(value);
        if (kind === 'missing') value = value.replace(/<\/?k\d+>/g, '');
        if (kind === 'duplicate') value += match ? match[0] : '<k1></k1><k1></k1>';
        if (kind === 'leak') value = value.replace(/<k(\d+)>/, '<k$1>FORGED');
        var before = linkP.outerHTML, identity = allNodes(linkP), ok = inject(unit, value);
        // A mutable ordinary label is allowed to change only inside its complete f range.
        check('invalid:atom-' + kind + ':refused', !ok, JSON.stringify(unit.injectResult));
        check('invalid:atom-' + kind + ':original-survives', linkP.outerHTML === before && sameNodes(identity, allNodes(linkP)));
        DT.restore();
      });

      var protectedP = box.querySelector('[data-fidelity-case="protected"]');
      ['missing', 'duplicate', 'invented-text'].forEach(function (kind) {
        var unit = collect(protectedP)[0], value = translated(unit, cases.protected), before = protectedP.outerHTML, identity = allNodes(protectedP);
        if (kind === 'missing') value = value.replace(/<\/?k\d+>/g, '');
        if (kind === 'duplicate') value += '<k1></k1>';
        if (kind === 'invented-text') value = value.replace(/<k(\d+)>/, '<k$1>DO-NOT-EXPOSE');
        var observer = new MutationObserver(function () {});
        observer.observe(protectedP, { subtree: true, childList: true, characterData: true, attributes: true });
        var ok = inject(unit, value), records = observer.takeRecords(); observer.disconnect();
        check('protected:invalid-' + kind + ':rejected-before-write', !ok && records.length === 0 && protectedP.outerHTML === before && sameNodes(identity, allNodes(protectedP)), JSON.stringify(unit.injectResult));
        check('protected:invalid-' + kind + ':original-visible', Array.prototype.every.call(protectedP.querySelectorAll('.notranslate,[translate="no"]'), function (el) { return getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0; }));
        DT.restore();
      });

      var unit = collect(strong)[0], text = translated(unit, cases.strong), set = strong.setAttribute, thrown = false, escaped = null, ok;
      strong.setAttribute = function (name, value) {
        if (!thrown && name === 'data-dt-replaced') { thrown = true; throw new Error('Deterministic write fault'); }
        return set.call(this, name, value);
      };
      try { ok = inject(unit, text); } catch (err) { escaped = err.message; }
      delete strong.setAttribute;
      check('transaction:write-fault-contained', thrown && !ok && !escaped, escaped || JSON.stringify(unit.injectResult));
      check('transaction:immediate-exact-rollback', strong.outerHTML === strongOriginal && sameNodes(strongNodes, allNodes(strong)));
      DT.restore();
      unit = collect(strong)[0];
      check('transaction:retry-after-rollback', inject(unit, translated(unit, cases.strong)));
      DT.restore();

      DT.state.mode = 'dual';
      unit = collect(strong)[0]; text = translated(unit, cases.strong);
      var append = strong.appendChild, insert = strong.insertBefore, dualFault = false;
      function refuseTarget(node, before) {
        if (!dualFault && node.nodeType === 1 && node.hasAttribute('data-dt-target')) { dualFault = true; throw new Error('Deterministic dual insertion fault'); }
        return arguments.length > 1 ? insert.call(this, node, before) : append.call(this, node);
      }
      strong.appendChild = refuseTarget;
      strong.insertBefore = refuseTarget;
      escaped = null;
      try { ok = inject(unit, text); } catch (err) { escaped = err.message; }
      delete strong.appendChild; delete strong.insertBefore;
      check('transaction:dual-insertion-fault-contained', dualFault && !ok && !escaped && !unit.targetNode, escaped || JSON.stringify(unit.injectResult));
      check('transaction:dual-fault-exact-rollback', strong.outerHTML === strongOriginal && sameNodes(strongNodes, allNodes(strong)));
      check('transaction:dual-same-unit-retry', inject(unit, text), JSON.stringify(unit.injectResult));
      DT.restore(); DT.state.mode = 'translation';

      var literal = document.createElement('p');
      literal.appendChild(document.createTextNode('This article explains the literal <f99> marker in plain text.'));
      box.appendChild(literal);
      var literalBefore = literal.outerHTML, literalNodes = allNodes(literal), literalUnit = collect(literal)[0];
      check('reserved:plain-source-opt-out', !!literalUnit && literalUnit.inlineProtocol !== 'v1' && !literalUnit.inlineIssue);
      check('reserved:literal-marker-remains-text', inject(literalUnit, '本文解释纯文本中的<f99>标记。') && literal.textContent.indexOf('<f99>') >= 0 && !literal.querySelector('f99'));
      DT.restore();
      check('reserved:plain-source-exact-restore', literal.outerHTML === literalBefore && sameNodes(literalNodes, allNodes(literal)));
      var protect = document.createElement('span'); protect.className = 'notranslate'; protect.textContent = 'ProtectedLiteral'; literal.appendChild(protect);
      literalBefore = literal.outerHTML; literalNodes = allNodes(literal); literalUnit = collect(literal)[0];
      var literalObserver = new MutationObserver(function () {});
      literalObserver.observe(literal, { subtree: true, childList: true, characterData: true, attributes: true });
      ok = inject(literalUnit, '不可信响应');
      var literalWrites = literalObserver.takeRecords(); literalObserver.disconnect();
      check('reserved:protected-source-fails-closed', literalUnit.inlineIssue === 'reserved-marker-source' && !ok && literalWrites.length === 0 && literal.outerHTML === literalBefore && sameNodes(literalNodes, allNodes(literal)), JSON.stringify(literalUnit.injectResult));
      DT.restore(); literal.remove();

      // Each simple formatted paragraph produces nine transaction operations.
      // Keeping completed operations below 4000, then adding 255 more records,
      // puts a write fault across the historical 5000-operation compaction edge.
      var stress = document.createElement('div'), stressSource = [];
      for (var si = 0; si < 556; si += 1) {
        var row = document.createElement('p'), head = document.createTextNode('Hello '), emphasis = document.createElement('strong');
        emphasis.textContent = 'word'; row.appendChild(head); row.appendChild(emphasis); row.appendChild(document.createTextNode(' tail.'));
        stress.appendChild(row); stressSource.push(head);
      }
      box.appendChild(stress);
      var stressOriginalNodes = allNodes(stress), expectedStress = stress.cloneNode(true), stressUnits = collect(stress), stressOk = true;
      function stressValue(one) { return translated(one, [['Hello ', '你好'], ['word', '单词'], [' tail.', '正文。']]); }
      if (DT.beginRenderCache) DT.beginRenderCache();
      try {
        for (si = 0; si < 300; si += 1) if (!DT.inject(stressUnits[si], stressValue(stressUnits[si]), 'zh-CN')) stressOk = false;
        for (si = 0; si < 200; si += 1) {
          stressSource[si].nodeValue = 'Updated source ' + si + ' ';
          expectedStress.children[si].firstChild.nodeValue = stressSource[si].nodeValue;
        }
        check('transaction:compact-precondition-releases', DT.releaseReplaced() === 200);
        for (si = 300; si < 555; si += 1) if (!DT.inject(stressUnits[si], stressValue(stressUnits[si]), 'zh-CN')) stressOk = false;
        var stressBeforeFault = stress.outerHTML, stressBeforeNodes = allNodes(stress), faultRow = stress.children[555], faultSet = faultRow.setAttribute, compactFault = false;
        faultRow.setAttribute = function (name, value) {
          if (!compactFault && name === 'data-dt-replaced') { compactFault = true; throw new Error('Deterministic transaction compaction fault'); }
          return faultSet.call(this, name, value);
        };
        escaped = null;
        try { ok = DT.inject(stressUnits[555], stressValue(stressUnits[555]), 'zh-CN'); } catch (err) { escaped = err.message; }
        delete faultRow.setAttribute;
        check('transaction:compact-fault-contained', stressOk && compactFault && !ok && !escaped, escaped || '');
        check('transaction:compact-fault-restores-only-current-unit', stress.outerHTML === stressBeforeFault && sameNodes(stressBeforeNodes, allNodes(stress)));
      } finally {
        if (DT.endRenderCache) DT.endRenderCache();
      }
      DT.restore();
      check('transaction:compact-lifecycle-precise-restore', stress.outerHTML === expectedStress.outerHTML && sameNodes(stressOriginalNodes, allNodes(stress)));
      stress.remove();

      unit = collect(strong)[0]; inject(unit, translated(unit, cases.strong));
      var source = strongNodes[0];
      source.nodeValue = 'Updated source ';
      check('dynamic:external-update-releases-translation', DT.refreshStale() === 1 && strong.textContent.indexOf('Updated source ') === 0 && strong.textContent.indexOf('美丽的') < 0);
      var updated = strong.outerHTML;
      unit = collect(strong)[0];
      check('dynamic:recollect-new-source', !!unit && unit.text.indexOf('Updated source') === 0);
      if (unit) check('dynamic:retranslate', inject(unit, translated(unit, [['Updated source ', '更新后的原文'], ['beautiful', '美丽的'], [' world. Please continue carefully.', '世界。请谨慎继续。']])));
      DT.restore();
      check('dynamic:restore-preserves-site-update', strong.outerHTML === updated);
    } catch (err) {
      check('fidelity:unexpected-exception', false, err && (err.stack || err.message) || String(err));
    } finally {
      DT.restore(); DT.state.mode = mode; DT.state.target = target; DT.state.config = config;
      DT.setSiteRule(config && config.page && config.page.site || null);
      box.remove();
    }
    metrics.collectMs = Math.round(metrics.collectMs * 100) / 100;
    metrics.injectMs = Math.round(metrics.injectMs * 100) / 100;
    metrics.elapsedMs = Math.round((performance.now() - started) * 100) / 100;
    return { checks: checks, evidence: evidence, metrics: metrics };
  };
})();
