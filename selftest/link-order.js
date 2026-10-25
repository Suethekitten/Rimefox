// Deterministic renderer checks. Static fixture HTML is trusted; model output is never HTML.
(function () {
  'use strict';
  window.runLinkOrderChecks = function () {
    var DT = window.__DT, checks = [], evidence = [];
    var oldMode = DT.state.mode, oldTarget = DT.state.target, oldConfig = DT.state.config;
    var box = document.createElement('div');
    (document.getElementById('fixture') || document.body).appendChild(box);
    function check(name, ok, detail) { checks.push({ name: name, ok: !!ok, detail: detail || '' }); }
    function nodes(p) {
      var all = [], walk = document.createTreeWalker(p, NodeFilter.SHOW_ALL);
      for (var n = walk.nextNode(); n; n = walk.nextNode()) all.push(n);
      return all;
    }
    function sameNodes(before, p) { var after = nodes(p); return before.length === after.length && before.every(function (n, i) { return after[i] === n; }); }
    function compact(text) { return String(text).replace(/\s+/g, ''); }
    function atom(unit, index, label) {
      var id = index + 1, re = new RegExp('<k' + id + '>[\\s\\S]*?<\\/k' + id + '>');
      var match = re.exec(unit.wire || unit.text);
      if (!match) throw new Error('Missing source atom k' + id);
      return label == null ? match[0] : match[0].replace(/(<f\d+>)[\s\S]*?(<\/f\d+>)/g, function (_, a, b) { return a + label + b; });
    }
    function record(name, html, valueOf, options) {
      options = options || {};
      var p = document.createElement('p');
      p.innerHTML = html;
      if (options.dir) p.dir = options.dir;
      if (options.fixed) p.style.position = 'fixed';
      box.appendChild(p);
      var before = p.outerHTML, originalNodes = nodes(p), links = Array.prototype.slice.call(p.querySelectorAll('a'));
      var attrs = links.map(function (a) { return a.outerHTML.replace(/>[\s\S]*<\/a>$/, '>'); });
      var hits = 0;
      links.forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); hits += 1; }); });
      if (options.reorder && links[0]) {
        links[0].focus();
        var sel = window.getSelection();
        if (sel) {
          var range = document.createRange();
          range.selectNodeContents(links[0]);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
      DT.state.mode = options.mode || 'translation'; DT.state.target = options.target || 'zh-CN';
      var unit = DT.collect(p)[0];
      check(name + ':single-paragraph-unit', !!unit && DT.collect(p).length === 1, unit && unit.wire);
      if (!unit) { p.remove(); return; }
      // Explicitly exercise compatibility units whose source did not opt into v1.
      // This is local metadata on this fixture, not a change to global renderer rules.
      if (options.legacy) {
        delete unit.inlineProtocol;
        delete unit.formats;
        unit.wire = DT.units.keepWrap(unit.text, unit.keep);
      }
      var value = valueOf(unit), expected = DT.keepText(unit, value);
      var observer = new MutationObserver(function () {});
      observer.observe(p, { childList: true, characterData: true, attributes: true, subtree: true });
      var ok = DT.inject(unit, value, DT.state.target), mutations = observer.takeRecords(); observer.disconnect();
      var view = p.querySelector('[data-dt-target]') || p;
      var result = unit.injectResult || {}, warning = unit.renderWarning || null;
      evidence.push({ name: name, wire: unit.wire, response: value, ok: ok, result: result, warning: warning, expected: expected, actual: view.textContent, html: p.outerHTML, writes: mutations.length });
      if (options.fail) {
        check(name + ':explicit-unsupported-order', !ok && result.code === 'unsupported-inline-order', JSON.stringify(result));
        check(name + ':original-whole-paragraph', p.outerHTML === before && sameNodes(originalNodes, p), p.outerHTML);
        check(name + ':preflight-zero-write', mutations.length === 0, String(mutations.length));
      } else if (options.safeOrFail && !ok) {
        check(name + ':safe-structural-failure', result.code === 'unsupported-inline-order' && p.outerHTML === before && sameNodes(originalNodes, p), JSON.stringify(result));
      } else {
        check(name + ':successful-render', ok && result.code === (options.citationFallback ? 'safe-degraded' : 'success'), JSON.stringify(result));
        if (!options.citationFallback) check(name + ':exact-visible-token-order', compact(view.textContent) === compact(expected), JSON.stringify({ expected: expected, actual: view.textContent }));
        if (options.reorder) {
          check(name + ':reordered-status', ok && result.code === 'success' && !!unit.inlineReordered, JSON.stringify({ result: result, links: unit.inlineReordered }));
          var wantedHrefs = [], token = /<k(\d+)>/g, hit;
          while ((hit = token.exec(value))) wantedHrefs.push(links[Number(hit[1]) - 1] && links[Number(hit[1]) - 1].getAttribute('href'));
          var actualHrefs = Array.prototype.map.call(view.querySelectorAll('a'), function (a) { return a.getAttribute('href'); });
          check(name + ':reordered-href-correspondence', JSON.stringify(actualHrefs) === JSON.stringify(wantedHrefs), JSON.stringify({ actual: actualHrefs, wanted: wantedHrefs }));
          check(name + ':reordered-focus-preserved', document.activeElement === links[0], document.activeElement && (document.activeElement.outerHTML || document.activeElement.tagName));
          var activeSel = window.getSelection();
          check(name + ':reordered-selection-preserved', !!activeSel && !!activeSel.anchorNode && links[0].contains(activeSel.anchorNode), activeSel && activeSel.anchorNode && activeSel.anchorNode.nodeValue);
          check(name + ':reordered-visible-hit-areas', links.every(function (a) { return a.getClientRects().length > 0; }), links.map(function (a) { return a.getClientRects().length; }).join(','));
          var ids = Array.prototype.map.call(view.querySelectorAll('[id]'), function (n) { return n.id; });
          check(name + ':reordered-no-duplicate-ids', ids.length === new Set(ids).size, ids.join('|'));
        }
        if (options.hrefOrder) check(name + ':href-order-at-equal-offset', Array.prototype.map.call(view.querySelectorAll('a'), function (a) { return a.getAttribute('href'); }).join('|') === options.hrefOrder.join('|'), view.outerHTML);
        if (options.warning) check(name + ':explicit-placement-warning', !!warning && warning.code === options.warning, JSON.stringify(warning));
        if (options.noWarning) check(name + ':normal-adjacency-no-warning', !warning, JSON.stringify(warning));
      }
      check(name + ':original-link-identity', links.every(function (a) { return a.isConnected && p.contains(a); }));
      check(name + ':original-link-attributes', links.every(function (a, i) { return a.outerHTML.replace(/>[\s\S]*<\/a>$/, '>') === attrs[i]; }));
      if (links.length) links[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      check(name + ':original-link-events', !links.length || hits === 1, String(hits));
      DT.restore();
      check(name + ':exact-node-restore', p.outerHTML === before && sameNodes(originalNodes, p), p.outerHTML);
      p.remove();
    }
    try {
      DT.state.config = { page: { site: {} } };
      DT.setSiteRule(null);
      var ordinary = 'The article compares <a href="/alpha" title="Alpha">alpha</a> with <a href="/beta" title="Beta">beta</a> before drawing a conclusion.';
      record('links:control', ordinary, function (u) { return '文章比较' + atom(u, 0, '甲') + '与' + atom(u, 1, '乙') + '之后得出结论。'; }, { noWarning: true });
      record('links:swap-two', ordinary, function (u) { return '文章比较' + atom(u, 1, '乙') + '与' + atom(u, 0, '甲') + '之后得出结论。'; }, { reorder: true });
      record('legacy:forced-dual-positioned-swap', ordinary, function (u) { return '文章比较' + atom(u, 1) + '与' + atom(u, 0) + '之后得出结论。'; }, { fail: true, mode: 'dual', fixed: true, legacy: true });
      var triple = 'The article compares <a href="/alpha">alpha</a>, <a href="/beta">beta</a> and <a href="/gamma">gamma</a> before drawing a conclusion.';
      record('links:move-one', triple, function (u) { return '文章比较' + atom(u, 1, '乙') + '、' + atom(u, 2, '丙') + '与' + atom(u, 0, '甲') + '之后得出结论。'; }, { reorder: true });
      record('links:model-tail', triple, function (u) { return '文章在比较之后得出结论。' + atom(u, 0, '甲') + atom(u, 1, '乙') + atom(u, 2, '丙'); }, { warning: 'suspicious-inline-placement' });
      var adjacent = 'The comparison uses <a href="/alpha">alpha</a><a href="/beta">beta</a> together before drawing the final conclusion.';
      record('links:source-adjacent', adjacent, function (u) { return '比较使用' + atom(u, 0, '甲') + atom(u, 1, '乙') + '一起得出最终结论。'; }, { noWarning: true });
      record('links:three-source-adjacent', 'The comparison uses <a href="/alpha">alpha</a><a href="/beta">beta</a><a href="/gamma">gamma</a> together before drawing the final conclusion.', function (u) { return '比较使用' + atom(u, 0, '甲') + atom(u, 1, '乙') + atom(u, 2, '丙') + '一起得出最终结论。'; }, { noWarning: true });
      record('links:adjacent-swap', adjacent, function (u) { return '比较使用' + atom(u, 1, '乙') + atom(u, 0, '甲') + '一起得出最终结论。'; }, { reorder: true });
      record('dual:adjacent-swap', adjacent, function (u) { return '比较使用' + atom(u, 1, '乙') + atom(u, 0, '甲') + '一起得出最终结论。'; }, { mode: 'dual', hrefOrder: ['/beta', '/alpha'] });
      var equal = 'The comparison uses <a href="/first">item</a><a href="/second">item</a> together before drawing the final conclusion.';
      record('dual:equal-labels-swap', equal, function (u) { return '比较使用' + atom(u, 1, '项目') + atom(u, 0, '项目') + '一起得出最终结论。'; }, { mode: 'dual', hrefOrder: ['/second', '/first'] });
      var citations = 'The experimental findings<sup class="reference"><a href="#cite_note-1">[1]</a></sup><sup class="reference"><a href="#cite_note-2">[2]</a></sup> reveal a meaningful association in this study.';
      record('cite:normal-colocation', citations, function (u) { return '实验发现' + atom(u, 0) + atom(u, 1) + '揭示研究中的重要关联。'; }, { noWarning: true });
      record('cite:reordered-colocation', citations, function (u) { return '实验发现' + atom(u, 1) + atom(u, 0) + '揭示研究中的重要关联。'; }, { citationFallback: true, warning: 'citation-placement-fallback' });
      record('cite:cross-sentence-reorder', citations, function (u) { return '第一项实验发现' + atom(u, 1) + '存在关联。第二项研究' + atom(u, 0) + '证实结果。'; }, { fail: true });
      var citationLines = 'The first experimental observation<sup class="reference"><a href="#cite_note-1">[1]</a></sup> supports this explanation.<br>The second experimental observation<sup class="reference"><a href="#cite_note-2">[2]</a></sup> also supports this explanation.';
      record('cite:hard-line-control', citationLines, function (u) { return '第一项实验观察' + atom(u, 0) + '支持此解释。\n第二项实验观察' + atom(u, 1) + '同样支持此解释。'; }, { noWarning: true });
      record('cite:hard-line-swap', citationLines, function (u) { return '第一项实验观察' + atom(u, 1) + '支持此解释。\n第二项实验观察' + atom(u, 0) + '同样支持此解释。'; }, { fail: true });
      var mixed = 'The article describes <a href="/alpha">alpha</a> in the experimental findings<sup class="reference"><a href="#cite_note-1">[1]</a></sup> before reaching its conclusion.';
      record('mixed:link-cite-swap', mixed, function (u) { return '文献' + atom(u, 1) + '在结论前描述' + atom(u, 0, '甲') + '的实验发现。'; }, { fail: true });
      var categories = [
        ['protect', '<span class="notranslate">LocalSecret</span>'],
        ['mention', '<a href="/profile/alice" class="mention">@alice</a>'],
        ['xref', '<a href="#fig-1">Fig. 1</a>']
      ];
      categories.forEach(function (entry) {
        record('mixed:' + entry[0] + '-link-swap', 'The article discusses ' + entry[1] + ' together with <a href="/alpha">alpha</a> before reaching its conclusion.', function (u) { return '文章在结论前讨论' + atom(u, 1, '甲') + '以及' + atom(u, 0) + '。'; }, { fail: true });
      });
      var multi = 'First read <a href="/first">the introduction</a> before continuing. Then review <a href="/second">the conclusion</a> with care.';
      record('links:multiple-sentences', multi, function (u) { return '继续前，先读' + atom(u, 0, '引言') + '。然后仔细复核' + atom(u, 1, '结论') + '。'; }, { noWarning: true });
      record('nested:strong-gap', 'Read the <strong><a href="/alpha">alpha</a> and <a href="/beta">beta</a></strong> article today.', function (u) {
        return u.wire.replace('Read the ', '阅读').replace('alpha', '甲').replace(' and ', '和').replace('beta', '乙').replace(' article today.', '文章。');
      }, { safeOrFail: true });
      record('nested:span-gap', 'Read the <span style="font-style:italic"><a href="/alpha">alpha</a> and <a href="/beta">beta</a></span> article today.', function (u) {
        return u.wire.replace('Read the ', '阅读').replace('alpha', '甲').replace(' and ', '和').replace('beta', '乙').replace(' article today.', '文章。');
      }, { safeOrFail: true });
      var rtl = 'توضح هذه الدراسة <span><a href="/first">النتيجة الأولى</a> و<a href="/second">النتيجة الثانية</a></span> مع معلومات إضافية كافية.';
      record('rtl:nested-control', rtl, function (u) { return '这项研究说明' + atom(u, 0, '第一结果') + '与' + atom(u, 1, '第二结果') + '并给出充分补充信息。'; }, { dir: 'rtl', noWarning: true });
      record('rtl:nested-swap', rtl, function (u) { return '这项研究说明' + atom(u, 1, '第二结果') + '与' + atom(u, 0, '第一结果') + '并给出充分补充信息。'; }, { dir: 'rtl', fail: true });
      var chinese = '这篇文章比较<a href="/first">第一个结果</a>以及<a href="/second">第二个结果</a>，然后对这两种方法进行详细解释。';
      record('zh-en:control', chinese, function (u) { return 'The article compares ' + atom(u, 0, 'the first result') + ' and ' + atom(u, 1, 'the second result') + ' before explaining both methods in detail.'; }, { target: 'en', noWarning: true });
      record('zh-en:swap', chinese, function (u) { return 'The article compares ' + atom(u, 1, 'the second result') + ' and ' + atom(u, 0, 'the first result') + ' before explaining both methods in detail.'; }, { target: 'en', reorder: true });
      record('zh-en:dual-swap', chinese, function (u) { return 'The article compares ' + atom(u, 1, 'the second result') + ' and ' + atom(u, 0, 'the first result') + ' before explaining both methods in detail.'; }, { target: 'en', mode: 'dual', hrefOrder: ['/second', '/first'] });
      record('zh-ja:swap', chinese, function (u) { return 'この記事は' + atom(u, 1, '第二の結果') + 'と' + atom(u, 0, '第一の結果') + 'を比較し、両方の方法を詳しく説明します。'; }, { target: 'ja', reorder: true });
      var crossSentence = 'First read <a href="/alpha">alpha</a> before continuing. Then review <a href="/beta">beta</a> with care.';
      record('links:cross-sentence-swap', crossSentence, function (u) { return '先仔细复核' + atom(u, 1, '乙') + '。然后在继续前阅读' + atom(u, 0, '甲') + '。'; }, { reorder: true });
      var rtlDirect = 'الدراسة تشرح <a href="/first">النتيجة الأولى</a> و<a href="/second">النتيجة الثانية</a> مع معلومات كافية.';
      record('rtl:direct-swap', rtlDirect, function (u) { return '这项研究说明' + atom(u, 1, '第二结果') + '与' + atom(u, 0, '第一结果') + '并给出充分信息。'; }, { dir: 'rtl', reorder: true });
      record('rtl-ltr:mixed-direction', 'The LTR explanation contains <span dir="rtl"><a href="/arabic">الدليل</a></span> and <a href="/english">English evidence</a> before its final conclusion.', function (u) { return '从左到右的说明包含' + atom(u, 0, '阿文指南') + '与' + atom(u, 1, '英文证据') + '然后得出最终结论。'; }, { noWarning: true });
      // A site can fill an existing empty element while the model request is pending.
      // Checking only snapshots of old Text nodes misses the newly added fact.
      var changed = document.createElement('p');
      changed.innerHTML = 'Read the <a href="/alpha">alpha</a><span></span> article carefully before making the final decision.';
      box.appendChild(changed); DT.state.mode = 'translation'; DT.state.target = 'zh-CN';
      var staleUnit = DT.collect(changed)[0];
      changed.querySelector('span').appendChild(document.createTextNode(' BREAKING NEW FACT '));
      var changedHTML = changed.outerHTML, changedNodes = nodes(changed);
      check('dynamic:new-text-node-invalidates-source', DT.sourceChanged(staleUnit));
      var siteObserver = new MutationObserver(function () {});
      siteObserver.observe(changed, { childList: true, characterData: true, attributes: true, subtree: true });
      var staleOk = DT.inject(staleUnit, '做出最终决定之前，请仔细阅读' + atom(staleUnit, 0, '甲') + '文章。', 'zh-CN');
      var staleWrites = siteObserver.takeRecords(); siteObserver.disconnect();
      check('dynamic:stale-response-cannot-mix-old-and-new-facts', !staleOk && staleUnit.injectResult.code === 'stale-source' && staleWrites.length === 0 && changed.outerHTML === changedHTML && sameNodes(changedNodes, changed), JSON.stringify(staleUnit.injectResult));
      DT.restore();
      check('dynamic:stale-restore-keeps-new-site-text', changed.outerHTML === changedHTML && sameNodes(changedNodes, changed));
      var fresh = DT.collect(changed)[0];
      check('dynamic:recollect-includes-new-fact', !!fresh && fresh.text.indexOf('BREAKING NEW FACT') >= 0, fresh && fresh.text);
      check('dynamic:updated-source-can-render', DT.inject(fresh, '作出最终决定前，请仔细阅读' + atom(fresh, 0, '甲') + '文章以及最新重要事实。', 'zh-CN'), JSON.stringify(fresh && fresh.injectResult));
      DT.restore();
      check('dynamic:updated-source-exact-restore', changed.outerHTML === changedHTML && sameNodes(changedNodes, changed));
      changed.remove();

      function partialFixture() {
        var p = document.createElement('p');
        p.innerHTML = '<span data-empty-head></span>Read the <a href="/alpha">alpha</a> article carefully today.<span data-empty-tail></span><br><br>Read the <a href="/beta">beta</a> second article carefully today.';
        box.appendChild(p);
        return { p: p, units: DT.collect(p) };
      }
      ['head', 'tail'].forEach(function (edge) {
        var fixture = partialFixture(), p = fixture.p, units = fixture.units, unit = units[0];
        check('partial:' + edge + ':bounded-unit-fixture', units.length === 2 && !unit.whole, units.length + ' units');
        p.querySelector('[data-empty-' + edge + ']').appendChild(document.createTextNode(' BREAKING NEW FACT '));
        var siteHTML = p.outerHTML, siteNodes = nodes(p);
        check('partial:' + edge + ':new-boundary-text-is-stale', DT.sourceChanged(unit) && !DT.sourceChanged(units[1]));
        var observer = new MutationObserver(function () {});
        observer.observe(p, { subtree: true, childList: true, characterData: true, attributes: true });
        var accepted = DT.inject(unit, '今天请仔细阅读' + atom(unit, 0, '甲') + '文章。', 'zh-CN');
        var writes = observer.takeRecords(); observer.disconnect();
        check('partial:' + edge + ':stale-zero-write', !accepted && unit.injectResult.code === 'stale-source' && writes.length === 0 && p.outerHTML === siteHTML && sameNodes(siteNodes, p), JSON.stringify(unit.injectResult));
        DT.restore();
        check('partial:' + edge + ':restore-retains-site-fact', p.outerHTML === siteHTML && sameNodes(siteNodes, p));
        p.remove();
      });
      var siblingFixture = partialFixture(), siblingP = siblingFixture.p, siblingUnits = siblingFixture.units;
      siblingP.lastChild.nodeValue = ' a second article changed by the website.';
      var siblingHTML = siblingP.outerHTML, siblingNodes = nodes(siblingP);
      check('partial:sibling-change-keeps-first-request-current', !DT.sourceChanged(siblingUnits[0]) && DT.sourceChanged(siblingUnits[1]));
      var firstValue = '今天请仔细阅读' + atom(siblingUnits[0], 0, '甲') + '文章。';
      check('partial:sibling-change-still-renders-first', DT.inject(siblingUnits[0], firstValue, 'zh-CN'), JSON.stringify(siblingUnits[0].injectResult));
      check('partial:sibling-change-preserves-second-text', siblingP.textContent.indexOf('今天请仔细阅读甲文章。') >= 0 && siblingP.textContent.indexOf('a second article changed by the website.') >= 0, siblingP.textContent);
      DT.restore();
      check('partial:sibling-change-exact-restore', siblingP.outerHTML === siblingHTML && sameNodes(siblingNodes, siblingP));
      siblingP.remove();

      // A failed dual insertion must restore request metadata as well as the DOM.
      var faultP = document.createElement('p');
      faultP.innerHTML = 'Read the <a href="/alpha">alpha</a><span></span> article carefully before deciding.';
      box.appendChild(faultP); DT.state.mode = 'dual';
      var faultUnit = DT.collect(faultP)[0], faultHTML = faultP.outerHTML, faultNodes = nodes(faultP);
      var faultValue = '做决定前，请仔细阅读' + atom(faultUnit, 0, '甲') + '文章。';
      var originalAppend = faultP.appendChild, originalInsert = faultP.insertBefore, insertionFault = false;
      function rejectDualTarget(node, before) {
        if (!insertionFault && node.nodeType === 1 && node.hasAttribute('data-dt-target')) { insertionFault = true; throw new Error('Deterministic link-order dual insertion fault'); }
        return arguments.length > 1 ? originalInsert.call(this, node, before) : originalAppend.call(this, node);
      }
      faultP.appendChild = rejectDualTarget; faultP.insertBefore = rejectDualTarget;
      var faultAccepted;
      try { faultAccepted = DT.inject(faultUnit, faultValue, 'zh-CN'); }
      finally { delete faultP.appendChild; delete faultP.insertBefore; }
      check('transaction:dual-fault-restores-source-and-render-mode', insertionFault && !faultAccepted && !faultUnit.renderMode && faultP.outerHTML === faultHTML && sameNodes(faultNodes, faultP), JSON.stringify(faultUnit.injectResult));
      faultP.querySelector('span').appendChild(document.createTextNode(' BREAKING NEW FACT '));
      var faultSiteHTML = faultP.outerHTML, faultSiteNodes = nodes(faultP);
      check('transaction:failed-unit-new-text-is-stale', DT.sourceChanged(faultUnit));
      var faultObserver = new MutationObserver(function () {});
      faultObserver.observe(faultP, { childList: true, characterData: true, attributes: true, subtree: true });
      var faultRetry = DT.inject(faultUnit, faultValue, 'zh-CN');
      var retryWrites = faultObserver.takeRecords(); faultObserver.disconnect();
      check('transaction:failed-unit-stale-retry-zero-write', !faultRetry && faultUnit.injectResult.code === 'stale-source' && retryWrites.length === 0 && faultP.outerHTML === faultSiteHTML && sameNodes(faultSiteNodes, faultP), JSON.stringify(faultUnit.injectResult));
      DT.restore();
      check('transaction:failed-unit-restore-keeps-site-fact', faultP.outerHTML === faultSiteHTML && sameNodes(faultSiteNodes, faultP));
      faultP.remove();

      // Hidden accessibility text can precede the visible label. textContent alone
      // would accept a translation written into the hidden node after clearing alpha.
      var hiddenP = document.createElement('p');
      hiddenP.innerHTML = 'Read the <a href="/alpha" title="Alpha"><span style="display:none">Invisible accessible label</span><span>alpha</span></a> article carefully before deciding.';
      box.appendChild(hiddenP); DT.state.mode = 'translation';
      var hiddenBefore = hiddenP.outerHTML, hiddenNodes = nodes(hiddenP), originalLink = hiddenP.querySelector('a'), hiddenHits = 0;
      originalLink.addEventListener('click', function (event) { event.preventDefault(); hiddenHits += 1; });
      var hiddenUnit = DT.collect(hiddenP)[0], hiddenValue = '决定之前，请仔细阅读' + atom(hiddenUnit, 0, '甲') + '文章。';
      var hiddenOk = DT.inject(hiddenUnit, hiddenValue, 'zh-CN');
      var hiddenVisible = hiddenP.innerText, hiddenLabel = originalLink.innerText;
      check('labels:hidden-prefix-cannot-silently-empty-visible-link', hiddenOk
        ? compact(hiddenVisible) === compact(DT.keepText(hiddenUnit, hiddenValue)) && compact(hiddenLabel) === '甲' && originalLink.getClientRects().length > 0
        : (hiddenUnit.injectResult.code === 'unsupported-inline-order' || (hiddenUnit.injectResult.code === 'unsafe-structure' && hiddenUnit.injectResult.reason === 'inline-link-label-unwritable')) && hiddenP.outerHTML === hiddenBefore && sameNodes(hiddenNodes, hiddenP) && compact(hiddenLabel) === 'alpha',
        JSON.stringify({ outcome: hiddenUnit.injectResult, visible: hiddenVisible, label: hiddenLabel }));
      check('labels:hidden-prefix-original-link-and-href', hiddenP.querySelector('a') === originalLink && originalLink.getAttribute('href') === '/alpha' && originalLink.getAttribute('title') === 'Alpha');
      originalLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      check('labels:hidden-prefix-original-event', hiddenHits === 1);
      DT.restore();
      check('labels:hidden-prefix-exact-restore', hiddenP.outerHTML === hiddenBefore && sameNodes(hiddenNodes, hiddenP));
      hiddenP.remove();
    } catch (err) {
      check('link-order:unexpected-exception', false, err && (err.stack || err.message) || String(err));
    } finally {
      DT.restore(); DT.state.mode = oldMode; DT.state.target = oldTarget; DT.state.config = oldConfig;
      DT.setSiteRule(oldConfig && oldConfig.page && oldConfig.page.site || null);
      box.remove();
    }
    return { checks: checks, evidence: evidence };
  };
})();
