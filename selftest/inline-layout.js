// Shared by the offline selftest and the independent real Chrome layout runner.
// Fixtures model publisher structures locally; they are not captured JAMA article HTML.
(function () {
  'use strict';
  window.runInlineLayoutChecks = function (options) {
    options = options || {};
    var DT = window.__DT;
    var results = [];
    var evidence = [];
    var box = document.createElement('div');
    box.appendChild(document.getElementById('tpl-inline-layout').content.cloneNode(true));
    (document.getElementById('fixture') || document.body).appendChild(box);
    var previousMode = DT.state.mode;
    var previousTarget = DT.state.target;
    DT.state.mode = 'translation';
    DT.state.target = 'zh-CN';
    function check(name, yes, detail) { results.push({ name: name, ok: !!yes, detail: detail || '' }); }
    function nodesOf(el) {
      var nodes = [];
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_ALL);
      for (var node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
      return nodes;
    }
    function markedTranslation(unit, long) {
      return (unit.wire || unit.text).split('\n').map(function (line) {
        var marks = line.match(/<k\d+>[\s\S]*?<\/k\d+>/g) || [];
        return '译文前段' + marks.map(function (mark) { return mark + '译文后段'; }).join('') + '正文。' + (long ? new Array(45).join('研究中的风险及证据不确定性应忠实保留。') : '');
      }).join('\n');
    }
    function rectOf(node) {
      var range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, Math.min(1, node.nodeValue.length));
      return range.getBoundingClientRect();
    }
    var cases = Array.prototype.slice.call(box.querySelectorAll('[data-layout-case]'));
    try {
      cases.forEach(function (p) {
        var name = p.getAttribute('data-layout-case');
        if (options.long && name === 'nodes') p.firstChild.nodeValue += new Array(120).join('Long medical evidence and uncertainty. ');
        var original = p.outerHTML;
        var originalNodes = nodesOf(p);
        var links = Array.prototype.slice.call(p.querySelectorAll('a'));
        var attrs = links.map(function (a) { return a.outerHTML; });
        var shells = Array.prototype.slice.call(p.querySelectorAll('[data-citation-shell]'));
        var shellText = shells.map(function (el) { return el.textContent; });
        var shellStyle = shells.map(function (el) {
          var s = getComputedStyle(el);
          return [s.fontSize, s.verticalAlign, s.position, s.top, s.transform].join('|');
        });
        var clicked = 0;
        function onClick(e) { e.preventDefault(); clicked += 1; }
        links.forEach(function (a) { a.addEventListener('click', onClick); });
        var unit = DT.collect(p)[0];
        if (!unit) { check(name + ':collect', false, 'No paragraph'); return; }
        var translation = markedTranslation(unit, options.long && name === 'nodes');
        var injected = DT.inject(unit, translation, 'zh-CN');
        check(name + ':inject', injected && !p.querySelector('[data-dt-target]'), JSON.stringify(unit.injectResult));
        var visibleText = p.innerText.replace(/\r/g, '').trim();
        var expectedText = DT.keepText(unit, translation).trim();
        check(name + ':complete-text-and-line-order', visibleText === expectedText, JSON.stringify({ expected: expectedText.slice(0, 160), actual: visibleText.slice(0, 160) }));
        var inserted = unit.citedInserted || [];
        if (name !== 'small' && name !== 'ordinary') {
          check(name + ':outside-citation-context', inserted.length > 0 && inserted.every(function (node) {
            return !node.parentElement.closest('a,sup,sub,[data-citation-shell]');
          }), inserted.map(function (node) { return node.parentElement.outerHTML.slice(0, 180); }).join(' | '));
          var font = getComputedStyle(p).fontSize;
          check(name + ':body-font', inserted.every(function (node) { return getComputedStyle(node.parentElement).fontSize === font; }), font);
          var geometry = inserted.filter(function (node) { return /\S/.test(node.nodeValue); }).map(function (node) {
            var top = node;
            while (top.parentNode !== p) top = top.parentNode;
            // 零宽、正常正文上下文的同字探针参与本行基线，但不挤动正文换行。
            var probe = document.createElement('span');
            probe.style.cssText = 'display:inline-block;width:0;white-space:nowrap';
            probe.textContent = '译';
            p.insertBefore(probe, top);
            var expected = rectOf(probe.firstChild);
            var rect = rectOf(node);
            var sameBaseline = Math.abs(rect.top - expected.top) < 1.1;
            var sameHeight = Math.abs(rect.height - expected.height) < 1.1;
            var info = { top: rect.top, height: rect.height, expectedTop: expected.top, expectedHeight: expected.height, ok: sameHeight && sameBaseline };
            probe.remove();
            return info;
          });
          check(name + ':normal-baseline-geometry', geometry.every(function (r) { return r.ok; }), JSON.stringify(geometry));
          evidence.push({ name: name, keep: unit.keep.map(function (k) { return { tag: k.el.tagName, text: k.text, kind: k.kind }; }), font: font, inserted: inserted.map(function (node) { var r = rectOf(node); return { text: node.nodeValue.slice(0, 24), parent: node.parentElement.tagName, font: getComputedStyle(node.parentElement).fontSize, top: r.top, height: r.height }; }) });
        }
        if (name === 'group') check('group:one-atomic-reference-group', unit.keep.length === 1 && shellText[0] === shells[0].textContent, JSON.stringify(unit.keep.map(function (k) { return k.text; })));
        if (name === 'small') check('small:normal-format-retained', unit.keep.every(function (k) { return k.kind === 'link'; }) && inserted.some(function (node) { return node.parentElement.closest('[data-normal-small]'); }) && parseFloat(getComputedStyle(p.querySelector('small')).fontSize) < parseFloat(getComputedStyle(p).fontSize));
        check(name + ':reference-content-style-unchanged', shells.every(function (el, i) {
          var s = getComputedStyle(el);
          return el.textContent === shellText[i] && [s.fontSize, s.verticalAlign, s.position, s.top, s.transform].join('|') === shellStyle[i];
        }));
        check(name + ':original-links-and-aria', links.every(function (a, i) { return p.contains(a) && a.outerHTML === attrs[i]; }));
        links.forEach(function (a) { a.click(); });
        check(name + ':events-survive', clicked === links.length);
        DT.restore();
        var restoredNodes = nodesOf(p);
        check(name + ':exact-restore-and-node-identity', p.outerHTML === original && restoredNodes.length === originalNodes.length && restoredNodes.every(function (node, i) { return node === originalNodes[i]; }));
        ['dual', 'translation', 'translation'].forEach(function (mode) {
          DT.state.mode = mode;
          var next = DT.collect(p)[0];
          var ok = next && DT.inject(next, markedTranslation(next), 'zh-CN');
          check(name + ':repeat-' + mode, ok);
          DT.restore();
          check(name + ':repeat-restore-' + mode, p.outerHTML === original);
        });
        DT.state.mode = 'translation';
        if (name === 'sup') {
          var stale = DT.collect(p)[0];
          DT.inject(stale, markedTranslation(stale), 'zh-CN');
          p.firstChild.nodeValue = 'Updated medical evidence after SPA navigation. ';
          check('spa:release-external-change', DT.refreshStale() === 1 && p.textContent.indexOf('Updated medical evidence') === 0 && !/译文/.test(p.textContent));
          var updated = p.outerHTML;
          var nextUnit = DT.collect(p)[0];
          check('spa:retranslate', !!nextUnit && DT.inject(nextUnit, markedTranslation(nextUnit), 'zh-CN'));
          DT.restore();
          check('spa:restore-new-source', p.outerHTML === updated && links.every(function (a) { return p.contains(a); }));
        }
        links.forEach(function (a) { a.removeEventListener('click', onClick); });
      });
    } finally {
      DT.restore();
      DT.state.mode = previousMode;
      DT.state.target = previousTarget;
      box.remove();
    }
    return { checks: results, evidence: evidence };
  };
})();
