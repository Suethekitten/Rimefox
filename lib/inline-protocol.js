// Shared classic-script protocol parser. Content scripts and the service worker use
// this exact implementation; markers describe local ranges, never executable HTML.
(function (root) {
  'use strict';
  var VERSION = 'v1';
  var MARK = /[<＜][^<＜>＞]*[>＞]|[<＜][^<＜>＞]*$/g;
  var EXACT = /^<(\/?)([kf])([1-9]\d{0,2})>$/;
  var LIKE = /^[<＜]\s*\/?\s*[kf]\s*\d/i;

  function failure(reason) {
    return { ok: false, reason: reason, clean: '', text: '', stripped: '', ranges: [], atoms: [], formatMissing: false };
  }

  function parse(value) {
    var input = String(value == null ? '' : value);
    if (/(?:&lt;|&#0*60;|&#x0*3c;)\s*\/?\s*[kf]\s*\d/i.test(input)) return { error: 'escaped-marker' };
    var stack = [];
    var nodes = [];
    var byKey = Object.create(null);
    var clean = '';
    var text = '';
    var stripped = '';
    var from = 0;
    var tokens = 0;
    var keepDepth = 0;
    var match;
    MARK.lastIndex = 0;
    while ((match = MARK.exec(input))) {
      if (!LIKE.test(match[0])) continue;
      var token = EXACT.exec(match[0]);
      if (!token) return { error: 'malformed-marker' };
      if (++tokens > 4096) return { error: 'marker-limit' };
      var gap = input.slice(from, match.index);
      clean += gap;
      text += gap;
      if (!keepDepth) stripped += gap;
      from = match.index + match[0].length;
      var kind = token[2];
      var id = Number(token[3]);
      var key = kind + id;
      if (kind === 'k') clean += match[0];
      if (!token[1]) {
        if (byKey[key]) return { error: 'duplicate-marker' };
        if (stack.length >= 32) return { error: 'marker-depth' };
        var node = {
          kind: kind, id: id, key: key,
          parent: stack.length ? stack[stack.length - 1].key : null,
          open: match.index, bodyStart: from, textStart: text.length, at: stripped.length,
          children: []
        };
        if (stack.length) stack[stack.length - 1].children.push(node);
        nodes.push(node);
        byKey[key] = node;
        stack.push(node);
        if (kind === 'k') keepDepth += 1;
      } else {
        var top = stack[stack.length - 1];
        if (!top || top.key !== key) return { error: 'marker-nesting' };
        stack.pop();
        top.bodyEnd = match.index;
        top.closeEnd = from;
        top.textEnd = text.length;
        top.end = stripped.length;
        if (kind === 'k') keepDepth -= 1;
        if (kind === 'f' && !text.slice(top.textStart, top.textEnd).trim()) return { error: 'empty-format' };
      }
    }
    if (stack.length) return { error: 'unclosed-marker' };
    var tail = input.slice(from);
    clean += tail;
    text += tail;
    if (!keepDepth) stripped += tail;
    return { input: input, nodes: nodes, byKey: byKey, clean: clean, text: text, stripped: stripped };
  }

  // Outside an f range an atom's bytes remain immutable. Replacing each outer
  // f subtree with its identity also detects changes to literal prefixes/suffixes.
  function atomSkeleton(parsed, node) {
    var out = '';
    var from = node.bodyStart;
    function walk(current) {
      current.children.forEach(function (child) {
        if (child.kind === 'f') {
          out += parsed.input.slice(from, child.open) + '<' + child.key + '>';
          from = child.closeEnd;
        } else walk(child);
      });
    }
    walk(node);
    return out + parsed.input.slice(from, node.bodyEnd);
  }

  function hasFormat(node) {
    return node.children.some(function (child) { return child.kind === 'f' || hasFormat(child); });
  }

  function parentWithoutFormat(parsed, node) {
    var parent = node.parent;
    while (parent && parsed.byKey[parent].kind === 'f') parent = parsed.byKey[parent].parent;
    return parent;
  }

  // When every f boundary is omitted, only the visible translation can survive.
  // A k with a single f covering its complete label is still identifiable; more
  // complicated mutable atoms cannot be safely reconstructed without boundaries.
  function wholeMutableLabel(parsed, node) {
    return node.children.length === 1 && node.children[0].kind === 'f' &&
      node.children[0].open === node.bodyStart && node.children[0].closeEnd === node.bodyEnd;
  }

  // These strings remain text, never HTML. Even so, invented tags are protocol
  // debris and must not be displayed. Exact literal tags already present in the
  // source (an article explaining HTML, for example) retain their normal meaning.
  function markupCounts(value) {
    var counts = Object.create(null);
    var re = /[<＜]\s*\/?\s*[A-Za-z][^<＜>＞]*(?:[>＞]|(?=[<＜])|$)|(?:&lt;|&#0*60;|&#x0*3c;)\s*\/?\s*[A-Za-z][\s\S]*?(?:&gt;|&#0*62;|&#x0*3e;|$)/gi;
    var match;
    while ((match = re.exec(value))) {
      if (EXACT.test(match[0])) continue;
      counts[match[0]] = (counts[match[0]] || 0) + 1;
    }
    return counts;
  }

  function inspect(source, target) {
    var src = parse(source);
    if (src.error) return failure('source-' + src.error);
    var dst = parse(target);
    if (dst.error) return failure(dst.error);
    var sourceMarkup = markupCounts(src.input);
    var targetMarkup = markupCounts(dst.input);
    var markup = Object.keys(targetMarkup);
    for (var mi = 0; mi < markup.length; mi += 1) {
      if (targetMarkup[markup[mi]] > (sourceMarkup[markup[mi]] || 0)) return failure('markup-leak');
    }
    var sourceFormats = src.nodes.filter(function (node) { return node.kind === 'f'; });
    var targetFormats = dst.nodes.filter(function (node) { return node.kind === 'f'; });
    var formatMissing = sourceFormats.length > 0 && targetFormats.length === 0;
    for (var i = 0; i < dst.nodes.length; i += 1) {
      var node = dst.nodes[i];
      var original = src.byKey[node.key];
      if (!original) return failure('unknown-marker');
      var expectedParent = formatMissing ? parentWithoutFormat(src, original) : original.parent;
      if (node.parent !== expectedParent) return failure('changed-parent');
    }
    for (var j = 0; j < src.nodes.length; j += 1) {
      var one = src.nodes[j];
      var result = dst.byKey[one.key];
      if (!result) {
        if (formatMissing && one.kind === 'f') continue;
        return failure('missing-marker');
      }
      if (one.kind !== 'k') continue;
      if (formatMissing && hasFormat(one)) {
        if (!wholeMutableLabel(src, one)) return failure('missing-atom-format');
      } else if (atomSkeleton(src, one) !== atomSkeleton(dst, result)) {
        return failure('changed-atom');
      }
    }
    return {
      ok: true, reason: formatMissing ? 'format-missing' : '', formatMissing: formatMissing,
      clean: dst.clean, text: dst.text, stripped: dst.stripped,
      ranges: dst.nodes.filter(function (node) { return node.kind === 'f'; }).map(function (node) {
        return { id: node.id, start: node.at, end: node.end, parent: node.parent };
      }),
      atoms: dst.nodes.filter(function (node) { return node.kind === 'k'; }).map(function (node) {
        return { id: node.id, text: dst.text.slice(node.textStart, node.textEnd), start: node.textStart, end: node.textEnd, at: node.at };
      })
    };
  }

  root.__RimefoxInline = { version: VERSION, inspect: inspect };
})(typeof globalThis !== 'undefined' ? globalThis : window);
