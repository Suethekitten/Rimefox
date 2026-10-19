// 内容脚本：翻译单元的结构层（纯函数，不碰 DOM）
//
// 0.9.1 把翻译拆成五个互不混用的概念：
//   DOM 结构      —— dom.js 按元素树收集 token
//   视觉段落      —— ParagraphUnit：本文件 textMap() 在规范化前按排版语义（空行 / 单 <br>+全角缩进 / 块级）切分
//   语义句子      —— SentenceUnit：本文件 sentencesIn() 在段落内切句
//   API 请求分片  —— core.js splitLong()：只负责请求长度，不决定页面段落
//   渲染单元      —— dom.js 的一个 ParagraphUnit = 一个翻译单元 = 一个渲染锚点
//
// 本文件只做文本层面的确定性计算：文本映射、段落、句子、对齐校验、签名。
// 自检页直接测这些函数（selftest/test.js 的「单元模型」一节）。
(function () {
  'use strict';

  var DT = window.__DT;
  if (!DT) return;
  if (DT.units) return;

  var U = (DT.units = {});

  // ---------------- 1. 文本映射 ----------------
  // tokens 由 dom.js 的 tokensOf() 按阅读顺序给出：
  //   { node, keep }  文本节点；keep = 所在元素保留换行（white-space: pre-*）
  //   { br }          <br>：一个语义换行
  // 输出：
  //   text  —— 与 DT.normalizeLines(unitText) 同一套规则：行内折叠空白、行首尾去空白、
  //            <br> / pre-* 的换行保留，连续空行最多一个（即最多两个 \n）
  //   chars —— 与 text 等长：真实字符是 { node, off }；换行是 { br } 或 { nl, at }；
  //            合成空格是 null。段落 / 句子的字符范围靠它映射回 DOM Range。
  //
  // 注意：rt / rp（振假名）在 dom.js 的 tokensOf 阶段已被排除，本文件不需要知道 Ruby。
  function isSpaceChar(c) {
    return c === ' ' || c === '\t' || c === '\f' || c === '\v' || c === '\u00a0';
  }

  U.textMap = function (tokens) {
    // 先把 token 流摊成「硬换行 / 空格 / 真实字符」三类。硬换行来自 <br> 或 pre-* 里的 \n。
    var raw = [];
    (tokens || []).forEach(function (tok) {
      if (!tok) return;
      if (tok.br) {
        raw.push({ brk: { br: tok.br } });
        return;
      }
      var node = tok.node;
      if (!node) return;
      var value = String(node.nodeValue == null ? '' : node.nodeValue);
      var keep = !!tok.keep;
      for (var i = 0; i < value.length; i += 1) {
        var c = value.charAt(i);
        if (c === '\r') {
          if (value.charAt(i + 1) === '\n') continue; // CRLF 只算一个换行
          c = '\n';
        }
        if (c === '\n' && keep) {
          raw.push({ brk: { nl: node, at: i } });
        } else if (c === '\n') {
          // 源码里的折行：在普通元素里只是空白，但它和紧跟的全角缩进一起构成
          // 青空文库「单 <br> + 　」的段落签名；保留 nl 标记，规范化后仍在行首可见。
          raw.push({ space: true, nl: true });
        } else if (c === ' ' || c === '\t' || c === '\f' || c === '\v' || c === '\u00a0') {
          raw.push({ space: true });
        } else {
          raw.push({ ch: c, meta: { node: node, off: i } });
        }
      }
    });

    // 按硬换行切行；行内连续空白（含源码折行）折叠成一个空格
    var lines = [];
    var line = { chars: [], startBreak: null };
    // 一个硬换行 = 当前行结束、下一行开始；下一行的 startBreak 必须是这一个换行本身
    function flush(nextBreak) {
      lines.push({ chars: line.chars, startBreak: line.startBreak });
      line = { chars: [], startBreak: nextBreak || null };
    }
    raw.forEach(function (part) {
      if (part.brk) {
        flush(part.brk);
        return;
      }
      if (part.space) {
        var cs = line.chars;
        var last = cs.length ? cs[cs.length - 1] : null;
        if (!last || !last.space) {
          cs.push({ space: true, nl: !!part.nl, meta: null });
        } else if (part.nl) {
          last.nl = true; // 同一段空白里只要有一个源码换行就记住
        }
        return;
      }
      line.chars.push({ ch: part.ch, meta: part.meta });
    });
    lines.push({ chars: line.chars, startBreak: line.startBreak });

    // 行首尾去空白，同时记录两个**排版语义**信号（在规范化把它们丢掉之前）：
    //   one.indent  —— 行首有全角缩进 U+3000（青空文库 / 日文小说的段落标记）
    //   one.quote   —— 行首是引号（对白段落）
    // 只有「硬换行后的新行」才用这两个信号判断段落；第一行 / 块级元素由调用方处理。
    lines.forEach(function (one) {
      var cs = one.chars;
      var a = 0;
      var b = cs.length;
      function blank(c) {
        return c.space || (c.ch && /\s/.test(c.ch));
      }
      var sawIndent = false;
      var sawSourceNewline = false;
      while (a < b && blank(cs[a])) {
        if (cs[a].ch === '\u3000') sawIndent = true;
        if (cs[a].nl) sawSourceNewline = true;
        a += 1;
      }
      while (b > a && blank(cs[b - 1])) b -= 1;
      one.indent = sawIndent;
      one.sourceNewline = sawSourceNewline;
      one.chars = cs.slice(a, b);
      one.first = one.chars.length ? one.chars[0].ch : '';
    });
    // 去掉首尾空行；中间的空行只留一个（normalizeLines 的规则）
    var firstNonEmpty = 0;
    while (firstNonEmpty < lines.length && !lines[firstNonEmpty].chars.length) firstNonEmpty += 1;
    var lastNonEmpty = lines.length - 1;
    while (lastNonEmpty >= firstNonEmpty && !lines[lastNonEmpty].chars.length) lastNonEmpty -= 1;

    var text = '';
    var chars = [];
    var gap = 0;
    var gapBreak = null;
    var trailingBreak = null;
    for (var li = firstNonEmpty; li <= lastNonEmpty; li += 1) {
      var row = lines[li];
      if (!row.chars.length) {
        gap += 1;
        if (!gapBreak) gapBreak = row.startBreak;
        continue;
      }
      if (text) {
        // 段落边界（换两个 \n）：
        //   1) 中间有空行（连续 <br> / 空行）；
        //   2) 新行以全角缩进开头，并且缩进前有源码换行（青空文库的 <br>\n　）。
        //      只认全角缩进会把 Pixiv 里「每行都带　」的连续对白误拆成多段；
        //      「源码换行 + 全角缩进」是 Aozora 段落的结构签名，Pixiv 的 span 行没有。
        // 其它硬换行只是同一段里的行（诗行、信件、地址、源码折行）。
        // 行首引号**不单独**算段落：青空文库里对白常常紧接上一行的「まるで」。
        var newPara = gap > 0 || (!!row.startBreak && row.indent && row.sourceNewline);
        text += '\n';
        chars.push(gapBreak || row.startBreak);
        if (newPara) {
          text += '\n';
          chars.push(row.startBreak || gapBreak);
        }
      }
      gap = 0;
      gapBreak = null;
      row.chars.forEach(function (c) {
        text += c.ch ? c.ch : ' ';
        chars.push(c.meta);
      });
    }
    // 最后一段后面的空行（通常是一串 <br>）：最后一篇译文应该插在它们**之前**，
    // 不能 append 到整个容器末尾，否则最后一段译文会和原文隔着一串空行。
    if (lastNonEmpty + 1 < lines.length) trailingBreak = lines[lastNonEmpty + 1].startBreak;
    return { text: text, chars: chars, paragraphs: U.paragraphsOf(text), trailingBreak: trailingBreak };
  };

  // ---------------- 2. 段落 ----------------
  // textMap() 已经把排版语义（空行 / 单 <br>+源码换行+全角缩进）编码成 \n\n；
  // 这里只按 \n\n 切分。单个 \n 是同一段里的行（诗行 / 对白续行 / 源码折行）。
  // 返回 [{ start, end, sepStart, sepEnd }]：
  //   start / end  段落文本在 text 里的范围（不含分隔空行）
  //   sepStart     分隔空行第一个 \n 的下标（= end）
  //   sepEnd       分隔空行之后、下一段开始的下标（= 下一段 start）
  U.paragraphsOf = function (text) {
    var s = String(text == null ? '' : text);
    var out = [];
    var start = 0;
    var i = 0;
    while (i < s.length) {
      if (s.charAt(i) === '\n' && s.charAt(i + 1) === '\n') {
        if (i > start) out.push({ start: start, end: i, sepStart: i, sepEnd: i + 2 });
        start = i + 2;
        i += 2;
        continue;
      }
      i += 1;
    }
    if (s.length > start) out.push({ start: start, end: s.length, sepStart: s.length, sepEnd: s.length });
    return out;
  };

  // 段落里的非空行：[[start, end], ...]（去掉行首尾空白；本文件的文本已规范化，通常只在行内）
  U.linesOf = function (text, start, end) {
    var s = String(text == null ? '' : text);
    var a = start == null ? 0 : start;
    var b = end == null ? s.length : end;
    var out = [];
    var lineStart = a;
    for (var i = a; i <= b; i += 1) {
      if (i < b && s.charAt(i) !== '\n') continue;
      var x = lineStart;
      var y = i;
      while (x < y && /\s/.test(s.charAt(x))) x += 1;
      while (y > x && /\s/.test(s.charAt(y - 1))) y -= 1;
      if (y > x) out.push([x, y]);
      lineStart = i + 1;
    }
    return out;
  };

  // ---------------- 3. 句子 ----------------
  // 句末：西文的 .!?… 后面要跟空白或结尾（避开 3.5、e.g）；中日文的 。！？； 直接断；换行一定断。
  // 引号 / 括号里的句号不断句：「じゃーん。今日は？」“好的。”他说。都是一句。
  // 只跟踪分得清左右的括号；直引号 " ' 分不清开合，交给西文规则（标点后要有空白）。
  // 这套规则从 0.8.4 的 hover.sentencesOf 原样搬来（自检用例一起搬），现在只在这里维护一份。
  var OPEN = '「『“（《〈【';
  var CLOSE = '」』”）》〉】';
  var CJK_END = '。！？；';
  var WEST_END = '.!?…';
  var TRAIL = '"\'”’)]」』）';

  function isSpace(c) {
    return !!c && /\s/.test(c);
  }

  U.sentencesOf = function (text) {
    var s = String(text || '');
    var out = [];
    var start = 0;
    var depth = 0;
    function cut(end) {
      var a = start;
      var b = end;
      while (a < b && isSpace(s.charAt(a))) a += 1;
      while (b > a && isSpace(s.charAt(b - 1))) b -= 1;
      if (b > a) out.push([a, b]);
      start = end;
    }
    var i = 0;
    while (i < s.length) {
      var c = s.charAt(i);
      if (c === '\n') {
        cut(i);
        depth = 0; // 引号跨行没闭合：下一行重新算
        i += 1;
        continue;
      }
      if (OPEN.indexOf(c) >= 0) {
        depth += 1;
        i += 1;
        continue;
      }
      if (CLOSE.indexOf(c) >= 0 && depth > 0) {
        depth -= 1;
        i += 1;
        // 「……。」收尾：后面是空白 / 行尾 / 下一段引号才断，「……。」と言った 这种接着往下
        if (!depth && (CJK_END + WEST_END).indexOf(s.charAt(i - 2)) >= 0 && (i >= s.length || isSpace(s.charAt(i)) || OPEN.indexOf(s.charAt(i)) >= 0)) cut(i);
        continue;
      }
      if (!depth && CJK_END.indexOf(c) >= 0) {
        var j = i + 1;
        while (j < s.length && (CJK_END.indexOf(s.charAt(j)) >= 0 || TRAIL.indexOf(s.charAt(j)) >= 0)) j += 1;
        cut(j);
        i = j;
        continue;
      }
      if (!depth && WEST_END.indexOf(c) >= 0) {
        var k = i + 1;
        while (k < s.length && (WEST_END.indexOf(s.charAt(k)) >= 0 || TRAIL.indexOf(s.charAt(k)) >= 0)) k += 1;
        if (k >= s.length || isSpace(s.charAt(k))) cut(k);
        i = k;
        continue;
      }
      i += 1;
    }
    cut(s.length);
    return out;
  };

  // 段落范围内的句子：返回 [{ index, start, end, text }]，偏移相对整段文本
  U.sentencesIn = function (text, start, end) {
    var s = String(text == null ? '' : text);
    var a = start == null ? 0 : start;
    var b = end == null ? s.length : end;
    return U.sentencesOf(s.slice(a, b)).map(function (r, index) {
      return { index: index, start: r[0] + a, end: r[1] + a, text: s.slice(r[0] + a, r[1] + a) };
    });
  };

  // offset 落在第几句（落在句子之间时算前一句；空集合返回 -1）
  U.sentenceIndexAt = function (sentences, offset) {
    var list = sentences || [];
    for (var i = 0; i < list.length; i += 1) {
      if (offset < list[i].end) return i;
    }
    return list.length ? list.length - 1 : -1;
  };

  // ---------------- 4. 句子对齐 ----------------
  // 模型返回的结构：[{ n: 覆盖的源句数, t: 这一组译文 }]，按原文句子顺序。
  // 这是「可验证的结构化结果」：不是靠两边句数相同去猜，而是模型明确给出覆盖关系。
  // 校验规则（任何一条不满足都返回 null，调用方降级为段落级）：
  //   1) n 是 1..99 的整数，t 是非空字符串
  //   2) 所有 n 之和 === 段落的源句数
  //   3) 每个 t 按顺序出现在最终译文里（防止模型改写 / 合并导致高亮范围错位）
  var NO_SPACE = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;

  // 与后台 lib/parse.js 的 joinPieces 逐字一致：中文 / 日文之间不加空格，其它加一个空格
  U.joinPieces = function (pieces) {
    return (pieces || []).reduce(function (out, piece) {
      var p = String(piece == null ? '' : piece);
      if (!out) return p;
      var glue = NO_SPACE.test(out.slice(-1)) || NO_SPACE.test(p.charAt(0)) ? '' : ' ';
      return out + glue + p;
    }, '');
  };

  U.alignmentOf = function (parts, resultText, sentenceCount) {
    if (!parts || !parts.length) return null;
    var count = Number(sentenceCount);
    if (!(count >= 1)) return null;
    var result = String(resultText == null ? '' : resultText);
    var rows = [];
    var src = 0;
    var cursor = 0;
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i] || {};
      var n = Number(part.n);
      var t = String(part.t == null ? '' : part.t).trim();
      if (!isFinite(n) || Math.floor(n) !== n || n < 1 || n > 99 || !t) return null;
      if (src + n > count) return null; // 覆盖数超过源句数：不可信
      var at = result.indexOf(t, cursor);
      if (at < 0) return null; // 模型的片段在最终译文里找不到：高亮会错位，直接降级
      rows.push({
        n: n,
        srcFrom: src,
        srcTo: src + n,
        tgtFrom: at,
        tgtTo: at + t.length,
        text: t
      });
      src += n;
      cursor = at + t.length;
    }
    if (src !== count) return null; // 少覆盖 / 多覆盖都不算可靠
    return { reliable: true, parts: rows, text: result };
  };

  // 源句 index 对应的对齐片段（没有可靠对齐时返回 null）
  U.partAt = function (alignment, sentenceIndex) {
    if (!alignment || !alignment.reliable) return null;
    var parts = alignment.parts || [];
    for (var i = 0; i < parts.length; i += 1) {
      if (sentenceIndex >= parts[i].srcFrom && sentenceIndex < parts[i].srcTo) return parts[i];
    }
    return null;
  };

  // 译文里 offset 落在哪个对齐片段（用于鼠标停在译文上找回原文）
  U.partAtTargetOffset = function (alignment, offset) {
    if (!alignment || !alignment.reliable) return null;
    var parts = alignment.parts || [];
    for (var i = 0; i < parts.length; i += 1) {
      if (offset >= parts[i].tgtFrom && offset < parts[i].tgtTo) return parts[i];
      if (offset < parts[i].tgtFrom) return parts[i - 1] || parts[i];
    }
    return parts.length ? parts[parts.length - 1] : null;
  };

  // ---------------- 5. 签名 / 工具 ----------------
  // 源文本签名：SPA 路由切换、动态更新后判断「这个段落是不是原来那段」。
  // FNV-1a + 长度：比只取前 24 字可靠（同开头不同结尾的长段落不会被当成没变）
  U.signature = function (text) {
    var s = String(text == null ? '' : text);
    var hash = 0x811c9dc5;
    for (var i = 0; i < s.length; i += 1) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return s.length + ':' + hash.toString(36);
  };
})();