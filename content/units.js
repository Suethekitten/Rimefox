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
  // 句末：中日文的 。！？； 直接断；换行一定断。
  // 引号 / 括号里的句号不断句：「じゃーん。今日は？」“好的。”他说。都是一句。
  // 只跟踪分得清左右的括号；直引号 " ' 分不清开合，交给西文规则。
  // 西文的 .!?… 不是见到就断（1.0 只认「标点 + 空白」，悬停常常整段对不上），还要排除：
  //   缩写       Mr. / Dr. / e.g. / i.e. / vs. / et al.；No. 5 / p. 12 / Fig. 3 / Jan. 5（后面跟数字才算）
  //   首字母     J. K. Rowling（单个大写字母 + 后面大写开头）
  //   编号       「1. 」「a. 」「iv. 」整句只有编号时不断
  //   小写续接   "Really?" she asked. / approx. five / 5 p.m. on Monday：标点后接小写字母不是句末
  // 并多认两种句末：
  //   脚注       home.11 Since / home.¹¹ Since / home.[11] Since：脚注号跟在句号后面，归前一句
  //   中西混排   真的吗?我不知道：半角 ?!… 后面直接是汉字 / 假名 / 谚文也断
  var OPEN = '「『“（《〈【';
  var CLOSE = '」』”）》〉】';
  var CJK_END = '。！？；';
  var WEST_END = '.!?…';
  var TRAIL = '"\'”’)]」』）';
  var SUPER_DIGITS = '⁰¹²³⁴⁵⁶⁷⁸⁹';
  var DENSE_CHAR = /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-䶿一-鿿가-힯豈-﫿]/;
  // 后面的句点永远不是句末（称谓、vs、cf、e.g、i.e）
  var ABBR_ALWAYS = {};
  'mr mrs ms mx dr prof sr jr st mt ft rev hon gen gov sen rep pres lt col capt sgt cmdr adm messrs mme mlle vs cf viz approx ca eg ie'
    .split(' ')
    .forEach(function (w) {
      ABBR_ALWAYS[w] = 1;
    });
  // 后面跟数字时才是缩写：No. 5 / p. 12 / Fig. 3 / Jan. 5（「I said no. Then…」照常断）
  var ABBR_NUM = {};
  'no nos p pp vol vols fig figs eq eqs ch chap sec art ref refs op ed jan feb mar apr jun jul aug sep sept oct nov dec'
    .split(' ')
    .forEach(function (w) {
      ABBR_NUM[w] = 1;
    });

  function isSpace(c) {
    return !!c && /\s/.test(c);
  }

  function isLower(c) {
    return !!c && c.toLowerCase() === c && c.toUpperCase() !== c;
  }

  function isUpper(c) {
    return !!c && c.toUpperCase() === c && c.toLowerCase() !== c;
  }

  function isDigit(c) {
    return c >= '0' && c <= '9';
  }

  function isLetter(c) {
    return isLower(c) || isUpper(c);
  }

  // k 之后第一个非空白字符
  function nextVisible(s, k) {
    while (k < s.length && isSpace(s.charAt(k))) k += 1;
    return s.charAt(k);
  }

  // 句点前面的那个词（含词内的点：e.g / U.S / Ph.D）
  function wordBefore(s, i) {
    var a = i;
    while (a > 0 && (isLetter(s.charAt(a - 1)) || (s.charAt(a - 1) === '.' && isLetter(s.charAt(a - 2))))) a -= 1;
    return s.slice(a, i);
  }

  // 句末标点 run 结束于 k：紧跟着的上标脚注（¹¹）和方括号引注（[11] / [a] / [12][13]）归前一句
  function citationEnd(s, k) {
    var j = k;
    while (j < s.length && SUPER_DIGITS.indexOf(s.charAt(j)) >= 0) j += 1;
    var guard = 0;
    while (s.charAt(j) === '[' && guard < 4) {
      var close = s.indexOf(']', j);
      if (close < 0 || close - j > 24 || /[\n\[]/.test(s.slice(j + 1, close))) break;
      j = close + 1;
      guard += 1;
    }
    return j;
  }

  // 西文标点 run 结束于 k（已含后随引号 / 括号）：脚注号紧跟句号时把它并进前一句，返回新的 k
  function footnoteEnd(s, i, k) {
    var j = citationEnd(s, k);
    if (j > k) return j;
    // 普通数字：home.11 Since（句点前是字母，后面 1–3 位数字再接空白 / 结尾；3.14 和 v2.11 不算）
    if (s.charAt(i) === '.' && isLetter(s.charAt(i - 1))) {
      var d = k;
      while (d < s.length && isDigit(s.charAt(d)) && d - k < 4) d += 1;
      if (d > k && d - k <= 3 && (d >= s.length || isSpace(s.charAt(d)))) return d;
    }
    return k;
  }

  // 西文标点（下标 i，标点 + 后随引号到 k 为止）是不是句末；是就返回切分位置，不是返回 -1
  function westernEnd(s, i, k, start) {
    var c = s.charAt(i);
    var end = footnoteEnd(s, i, k);
    var after = s.charAt(end);
    if (end < s.length && !isSpace(after)) {
      // 标点后面没有空白：3.5 / Node.js / e.g. 内部的点都不断；
      // 中西混排的「?!…」后面直接是中日韩文字才断
      return c !== '.' && DENSE_CHAR.test(after) ? end : -1;
    }
    var next = nextVisible(s, end);
    if (end >= s.length || !next) return end;
    // 小写续接：标点后面是小写字母，不是句末
    if (isLower(next)) return -1;
    if (c === '.' && s.charAt(i + 1) !== '.') {
      var word = wordBefore(s, i);
      var key = word.replace(/\./g, '').toLowerCase();
      if (ABBR_ALWAYS[key]) return -1;
      if (key === 'al' && /\bet\s+$/i.test(s.slice(Math.max(start, i - 6), i - 2))) return -1; // et al.
      if (ABBR_NUM[key] && isDigit(next)) return -1;
      // 首字母：J. K. Rowling
      if (word.length === 1 && isUpper(word) && isUpper(next)) return -1;
      // 整句只有一个编号：「1. 」「(a). 」「iv. 」
      if (/^\(?(?:\d{1,3}|[A-Za-z]|[ivxlcdm]{1,5}|[IVXLCDM]{1,5})\)?$/.test(s.slice(start, i).trim())) return -1;
    }
    return end;
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
        // 「……。」收尾：后面是空白 / 行尾 / 下一段引号才断，「……。」と言った 这种接着往下；
        // “Really?” she asked. 引号后面是小写也接着往下
        if (
          !depth &&
          (CJK_END + WEST_END).indexOf(s.charAt(i - 2)) >= 0 &&
          (i >= s.length || isSpace(s.charAt(i)) || OPEN.indexOf(s.charAt(i)) >= 0) &&
          !isLower(nextVisible(s, i))
        ) {
          cut(i);
        }
        continue;
      }
      if (!depth && CJK_END.indexOf(c) >= 0) {
        var j = i + 1;
        while (j < s.length && (CJK_END.indexOf(s.charAt(j)) >= 0 || TRAIL.indexOf(s.charAt(j)) >= 0)) j += 1;
        j = citationEnd(s, j); // 。[4] 引注归前一句
        cut(j);
        i = j;
        continue;
      }
      if (!depth && WEST_END.indexOf(c) >= 0) {
        var k = i + 1;
        while (k < s.length && (WEST_END.indexOf(s.charAt(k)) >= 0 || TRAIL.indexOf(s.charAt(k)) >= 0)) k += 1;
        var end = westernEnd(s, i, k, start);
        if (end >= 0) {
          cut(end);
          i = end;
        } else {
          i = k;
        }
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

  // ---------------- 4b. 本地句子对齐（模型没给对齐时） ----------------
  // 0.9.1 只认模型返回的 parts：旧缓存、后台重启、非结构化输出、两边断句数不一致时一律整段，
  // 实际用起来几乎总是整段高亮。这里在页面上直接对齐两边已有的句子，不发请求：
  //   动态规划（Gale–Church 句长模型）：每一组可以是 1–1、1–2、2–1、2–2、1–3、3–1，
  //     句长按本段的整体译文 / 原文比例归一化，中日韩字按 2.5 个西文字符计；
  //   锚点：两边都出现的数字（1820、3.5）、缩写 / 专名（GDP、iPhone、COVID-19）必须落在同一组，
  //     问句 / 感叹句尽量对问句 / 感叹句；
  //   置信度：对最优路径上每个句界，和「往前 / 往后挪一句」的最优路径比代价；
  //     差距不到 MARGIN 就不信这个句界，把两边的组合并——宁可高亮两句，也不高亮错的一句。
  // 两边行数相同（真实 <br> / pre-* 换行）时逐行对齐，行界一定是组界。
  var ALIGN_BEADS = [
    [1, 1, 0],
    [1, 2, 2.0],
    [2, 1, 2.0],
    [2, 2, 4.0],
    [1, 3, 4.5],
    [3, 1, 4.5]
  ];
  var ALIGN_VAR = 8; // 句长差的方差（每个字符），Gale–Church 原文 6.8；中英互译句长波动更大
  // 句界置信度：比「挪一句」的最优路径至少便宜这么多（自然对数）。
  // 38 段人工对照语料（中英日法、合并 / 拆分 / 调换）上正确句界的最小差距是 0.61，
  // 调换语序的段落整段合并；0.5 只拦真正两可的句界
  var ALIGN_MARGIN = 0.5;
  var ALIGN_MAX_CELLS = 6400; // 一段最多 80×80 句；更长的段落退回行 / 段落级

  function weightOf(text) {
    var w = 0;
    var gap = false;
    for (var i = 0; i < text.length; i += 1) {
      var c = text.charAt(i);
      if (isSpace(c)) {
        if (!gap) w += 1;
        gap = true;
        continue;
      }
      gap = false;
      w += DENSE_CHAR.test(c) ? 2.5 : 1;
    }
    return Math.max(1, w);
  }

  // 锚点：数字（千分位逗号去掉）和缩写 / 混合大小写 / 带数字的西文词
  function anchorsOf(text) {
    var out = {};
    var m;
    var num = /\d+(?:[.,]\d+)*/g;
    while ((m = num.exec(text))) {
      var v = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(m[0]) ? m[0].replace(/,/g, '') : m[0];
      var nk = 'n:' + v;
      out[nk] = (out[nk] || 0) + 1;
    }
    var word = /[A-Za-z][A-Za-z0-9]*(?:[-'][A-Za-z0-9]+)*/g;
    while ((m = word.exec(text))) {
      var t = m[0];
      if (t.length < 2) continue;
      if (!(/[A-Z]/.test(t.slice(1)) || /\d/.test(t))) continue; // GDP / iPhone / COVID-19；普通词不算
      var tk = 't:' + t;
      out[tk] = (out[tk] || 0) + 1;
    }
    return out;
  }

  function anchorWeight(key) {
    if (key.charAt(0) === 't') return 1.5;
    // 一两位的数字常是脚注号 / 序号，弱锚点；三位以上（年份、金额）强锚点
    return key.replace(/\D/g, '').length >= 3 ? 2 : 0.6;
  }

  // 句末语气：问句 q / 感叹 e / 其它 p（去掉后随引号括号）
  function moodOf(text) {
    var s = String(text || '').replace(/[\s"'”’)\]」』）》〉】]+$/, '');
    var c = s.charAt(s.length - 1);
    if (c === '?' || c === '？') return 'q';
    if (c === '!' || c === '！') return 'e';
    return 'p';
  }

  // erfc 近似（Numerical Recipes erfcc，相对误差 < 1.2e-7）
  function erfc(x) {
    var z = Math.abs(x);
    var t = 1 / (1 + 0.5 * z);
    var r =
      t *
      Math.exp(
        -z * z -
          1.26551223 +
          t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))
      );
    return x >= 0 ? r : 2 - r;
  }

  function sideOf(list) {
    return list.map(function (one) {
      return { w: weightOf(one.text), anchors: anchorsOf(one.text), mood: moodOf(one.text) };
    });
  }

  // 两组句子（各自的 { w, anchors, mood } 列表）做对齐，返回组的列表 [{ s0, s1, t0, t1 }]；
  // 算不了（太长 / 没有可行路径）返回 null。纯函数，自检直接测。
  U.alignBeads = function (src, tgt) {
    var m = src.length;
    var n = tgt.length;
    if (!m || !n) return null;
    if (m === 1 || n === 1) return [{ s0: 0, s1: m, t0: 0, t1: n }];
    if ((m + 1) * (n + 1) > ALIGN_MAX_CELLS) return null;
    var LS = 0;
    var LT = 0;
    var i;
    var j;
    for (i = 0; i < m; i += 1) LS += src[i].w;
    for (j = 0; j < n; j += 1) LT += tgt[j].w;
    var ratio = LT / LS;
    // 两边都出现的锚点才有意义（只出现在一边的数字可能被模型改写成文字）
    var shared = {};
    var srcAll = {};
    src.forEach(function (one) {
      for (var key in one.anchors) srcAll[key] = 1;
    });
    tgt.forEach(function (one) {
      for (var key in one.anchors) if (srcAll[key]) shared[key] = anchorWeight(key);
    });

    function beadCost(s0, s1, t0, t1) {
      var ls = 0;
      var lt = 0;
      var k;
      for (k = s0; k < s1; k += 1) ls += src[k].w;
      for (k = t0; k < t1; k += 1) lt += tgt[k].w;
      lt /= ratio;
      var delta = (lt - ls) / Math.sqrt(Math.max(1, (ls + lt) / 2) * ALIGN_VAR);
      var cost = -Math.log(Math.max(1e-12, erfc(Math.abs(delta) / Math.SQRT2)));
      var diff = {};
      for (k = s0; k < s1; k += 1) for (var a in src[k].anchors) if (shared[a]) diff[a] = (diff[a] || 0) + src[k].anchors[a];
      for (k = t0; k < t1; k += 1) for (var b in tgt[k].anchors) if (shared[b]) diff[b] = (diff[b] || 0) - tgt[k].anchors[b];
      for (var d in diff) cost += shared[d] * Math.abs(diff[d]) * 0.5;
      var ms = src[s1 - 1].mood;
      var mt = tgt[t1 - 1].mood;
      if (ms !== mt && (ms !== 'p' || mt !== 'p')) cost += 0.8;
      return cost;
    }

    var W = n + 1;
    var INF = Infinity;
    var F = new Array((m + 1) * W);
    var back = new Array((m + 1) * W);
    var B = new Array((m + 1) * W);
    for (i = 0; i < F.length; i += 1) {
      F[i] = INF;
      B[i] = INF;
    }
    F[0] = 0;
    var memo = {};
    function cost(s0, s1, t0, t1) {
      var key = s0 + ',' + s1 + ',' + t0 + ',' + t1;
      if (!(key in memo)) memo[key] = beadCost(s0, s1, t0, t1);
      return memo[key];
    }
    var x;
    for (i = 0; i <= m; i += 1) {
      for (j = 0; j <= n; j += 1) {
        if (!i && !j) continue;
        for (x = 0; x < ALIGN_BEADS.length; x += 1) {
          var a1 = ALIGN_BEADS[x][0];
          var b1 = ALIGN_BEADS[x][1];
          if (i < a1 || j < b1) continue;
          var prev = F[(i - a1) * W + (j - b1)];
          if (prev === INF) continue;
          var c1 = prev + ALIGN_BEADS[x][2] + cost(i - a1, i, j - b1, j);
          if (c1 < F[i * W + j]) {
            F[i * W + j] = c1;
            back[i * W + j] = x;
          }
        }
      }
    }
    if (F[m * W + n] === INF) return null;
    B[m * W + n] = 0;
    for (i = m; i >= 0; i -= 1) {
      for (j = n; j >= 0; j -= 1) {
        if (i === m && j === n) continue;
        for (x = 0; x < ALIGN_BEADS.length; x += 1) {
          var a2 = ALIGN_BEADS[x][0];
          var b2 = ALIGN_BEADS[x][1];
          if (i + a2 > m || j + b2 > n) continue;
          var next = B[(i + a2) * W + (j + b2)];
          if (next === INF) continue;
          var c2 = next + ALIGN_BEADS[x][2] + cost(i, i + a2, j, j + b2);
          if (c2 < B[i * W + j]) B[i * W + j] = c2;
        }
      }
    }
    var best = F[m * W + n];
    var beads = [];
    i = m;
    j = n;
    while (i > 0 || j > 0) {
      var bx = ALIGN_BEADS[back[i * W + j]];
      beads.unshift({ s0: i - bx[0], s1: i, t0: j - bx[1], t1: j });
      i -= bx[0];
      j -= bx[1];
    }
    // 句界置信度：挪一句的最优路径（经过邻点、且不经过这个句界）有多贵
    function through(p, q) {
      if (p < 0 || q < 0 || p > m || q > n) return INF;
      return F[p * W + q] + B[p * W + q];
    }
    var out = [beads[0]];
    for (var k = 1; k < beads.length; k += 1) {
      var bi = beads[k].s0;
      var bj = beads[k].t0;
      var alt = Math.min(
        through(bi - 1, bj),
        through(bi + 1, bj),
        through(bi, bj - 1),
        through(bi, bj + 1),
        through(bi - 1, bj + 1),
        through(bi + 1, bj - 1)
      );
      if (alt - best < ALIGN_MARGIN) {
        var last = out[out.length - 1];
        last.s1 = beads[k].s1;
        last.t1 = beads[k].t1;
      } else {
        out.push(beads[k]);
      }
    }
    return out;
  };

  // 段落级本地对齐：src 句子是 unit.sentences（{start,end,text}，段落相对偏移），
  // 译文句子按同一套规则现切。返回与 alignmentOf 同形的结果（parts 的 srcFrom/srcTo 是句序号，
  // tgtFrom/tgtTo 是译文字符偏移），另带 local:true 和每组的译文句数 tgtCount。
  U.alignLocal = function (srcText, srcSentences, tgtText) {
    var source = String(srcText == null ? '' : srcText);
    var target = String(tgtText == null ? '' : tgtText);
    var ss = srcSentences && srcSentences.length ? srcSentences : U.sentencesIn(source, 0, source.length);
    var ts = U.sentencesIn(target, 0, target.length);
    if (!ss.length || !ts.length) return null;
    // 两边真实行数相同：逐行对齐，行界一定是组界
    var sl = U.linesOf(source);
    var tl = U.linesOf(target);
    var chunks = [];
    function within(list, span) {
      var a = -1;
      var b = -1;
      for (var q = 0; q < list.length; q += 1) {
        if (list[q].start >= span[0] && list[q].end <= span[1]) {
          if (a < 0) a = q;
          b = q + 1;
        }
      }
      return a < 0 ? null : [a, b];
    }
    if (sl.length > 1 && sl.length === tl.length) {
      for (var li = 0; li < sl.length; li += 1) {
        var sr = within(ss, sl[li]);
        var tr = within(ts, tl[li]);
        if (!sr || !tr) return null;
        chunks.push([sr, tr]);
      }
    } else {
      chunks.push([[0, ss.length], [0, ts.length]]);
    }
    var srcSide = sideOf(ss);
    var tgtSide = sideOf(ts);
    var parts = [];
    for (var ci = 0; ci < chunks.length; ci += 1) {
      var s = chunks[ci][0];
      var t = chunks[ci][1];
      var beads = U.alignBeads(srcSide.slice(s[0], s[1]), tgtSide.slice(t[0], t[1]));
      if (!beads) return null;
      beads.forEach(function (bead) {
        var from = ts[t[0] + bead.t0].start;
        var to = ts[t[0] + bead.t1 - 1].end;
        parts.push({
          n: bead.s1 - bead.s0,
          srcFrom: s[0] + bead.s0,
          srcTo: s[0] + bead.s1,
          tgtFrom: from,
          tgtTo: to,
          tgtCount: bead.t1 - bead.t0,
          text: target.slice(from, to)
        });
      });
    }
    return { reliable: true, local: true, parts: parts, text: target };
  };

  // ---------------- 4b. 保留区标记 ----------------
  // 段落里网页标明「不要翻译」的行内内容（notranslate / translate="no" / 站点规则排除）仍随整句送翻，
  // 给模型当上下文；送翻时用 <k1>…</k1> 包住，提示词要求标记连同内容原样照抄、按译文语序摆放。
  // keep：dom.js 给出的 [{ start, end, text }]（段落文本里的范围，按出现顺序、互不重叠），第 i 个编号 i+1。
  // 后台 lib/prompt.js 的 hasKeepMarks 认同一套写法。
  var KEEP_MARK = /[<＜]\s*(\/?)\s*k\s*(\d{1,3})\s*(\/?)\s*[>＞]/gi;
  var KEEP_WORD = /[0-9A-Za-zÀ-ɏ]/;

  U.keepWrap = function (text, keep) {
    var s = String(text == null ? '' : text);
    if (!keep || !keep.length) return s;
    var out = '';
    var at = 0;
    keep.forEach(function (k, i) {
      out += s.slice(at, k.start) + '<k' + (i + 1) + '>' + s.slice(k.start, k.end) + '</k' + (i + 1) + '>';
      at = k.end;
    });
    return out + s.slice(at);
  };

  // 有限行内协议：只在源文本范围插入受控标记，不序列化网页 HTML。
  // format 的同起点外层先开、内层先关；空 protect 不向 API 发送正文。
  U.inlineWrap = function (text, keep, formats) {
    var s = String(text || '');
    var opens = {};
    var closes = {};
    var hidden = {};
    function add(list, at, item) {
      if (!list[at]) list[at] = [];
      list[at].push(item);
    }
    (keep || []).forEach(function (k, index) {
      var id = index + 1;
      add(opens, k.start, { key: 'k' + id, end: k.end, rank: -1 });
      add(closes, k.end, { key: 'k' + id, start: k.start, rank: -1 });
      if (k.kind === 'protect') {
        for (var i = k.start; i < k.end; i += 1) hidden[i] = true;
      }
    });
    (formats || []).forEach(function (f, index) {
      add(opens, f.start, { key: 'f' + f.id, end: f.end, rank: index });
      add(closes, f.end, { key: 'f' + f.id, start: f.start, rank: index });
    });
    var out = '';
    for (var i = 0; i <= s.length; i += 1) {
      (closes[i] || []).sort(function (a, b) { return b.start - a.start || b.rank - a.rank; }).forEach(function (m) {
        out += '</' + m.key + '>';
      });
      (opens[i] || []).sort(function (a, b) { return b.end - a.end || a.rank - b.rank; }).forEach(function (m) {
        out += '<' + m.key + '>';
      });
      if (i < s.length && !hidden[i]) out += s.charAt(i);
    }
    return out;
  };

  // 模型没留标记（或换了顺序）时，按原文逐字找保留内容：每个都要按顺序、整词、只出现一次
  function keepLocate(text, keep) {
    var segs = [];
    var from = 0;
    for (var i = 0; i < keep.length; i += 1) {
      var needle = String(keep[i].text || '');
      if (!needle) return null;
      var at = text.indexOf(needle, from);
      if (at < 0 || text.indexOf(needle) !== at || text.indexOf(needle, at + 1) >= 0) return null;
      var end = at + needle.length;
      if (KEEP_WORD.test(needle.charAt(0)) && at > 0 && KEEP_WORD.test(text.charAt(at - 1))) return null;
      if (KEEP_WORD.test(needle.charAt(needle.length - 1)) && KEEP_WORD.test(text.charAt(end))) return null;
      segs.push(text.slice(from, at));
      from = end;
    }
    segs.push(text.slice(from));
    return segs;
  }

  // 模型回来的译文 → { text, segs }
  //   text：去掉标记，标记里的内容一律换回原文（模型改了也不算）；双语 / 悬停 / 去重都用它
  //   segs：保留区之间的 keep.length + 1 段译文，仅译文原地写回用。标记按原顺序各出现一次时取标记位置，
  //         否则按原文逐字找；都对不上（漏了、换了顺序、重复）是 null，调用方走兜底
  // source（可选）：这段原文。不是发出去的编号（模型编出来的 <k7>）只去掉标记本身、留下中间的字，
  //   不然会原样写进页面；原文里本来就有这串字的（讲 HTML 的文章）才当普通文字
  U.keepParse = function (text, keep, source) {
    var s = String(text == null ? '' : text);
    var count = keep ? keep.length : 0;
    if (!count) return { text: s, segs: null };
    var drops = keepDrops(s, count, source);
    var plain = '';
    var gap = '';
    var gaps = [];
    var order = [];
    var at = 0;
    drops.forEach(function (d) {
      if (d.start < at) return; // 落在另一对标记里面
      var between = s.slice(at, d.start);
      plain += between;
      gap += between;
      if (d.id) {
        plain += keep[d.id - 1].text;
        gaps.push(gap);
        gap = '';
        order.push(d.id);
      }
      at = d.end;
    });
    plain += s.slice(at);
    gaps.push(gap + s.slice(at));
    var inOrder = order.length === count;
    for (var i = 0; inOrder && i < order.length; i += 1) inOrder = order[i] === i + 1;
    return { text: plain, segs: inOrder ? gaps : keepLocate(plain, keep) };
  };

  // 文献引用（dom.js 的 isCitationEl）用：每个保留区在译文里落在哪。
  //   stripped：去掉所有标记、连同标记里的内容 —— 引用编号不进译文文字，由页面上的上标链接（或它的副本）占位
  //   at[i]：第 i 个保留区在 stripped 里的位置，模型没留这个标记是 -1。
  // 同一个编号出现多次只认第一次，后面的连同内容一起去掉（模型抄重了，页面上不能出现两次）。
  // 不做「按原文逐字找」：引用只是几个数字，译文里本来就可能有同样的数字，找到的未必是它
  U.keepMarks = function (text, keep, source) {
    var s = String(text == null ? '' : text);
    var count = keep ? keep.length : 0;
    var at = [];
    for (var i = 0; i < count; i += 1) at.push(-1);
    if (!count) return { stripped: s, at: at };
    var out = '';
    var pos = 0;
    keepDrops(s, count, source).forEach(function (d) {
      if (d.start < pos) return;
      out += s.slice(pos, d.start);
      if (d.id && at[d.id - 1] < 0) at[d.id - 1] = out.length;
      pos = d.end;
    });
    out += s.slice(pos);
    return { stripped: out, at: at };
  };

  // 译文里位置 at 所在那一句的句末（句末标点和收尾引号之前）：模型换了引用的先后顺序时，
  // 仅译文模式没法把页面上的上标挪来挪去，退一步只保证引用还在它所属的那一句里。
  // 「疾病。」→ 落在「。」之前；「(PRS).」→ 落在「.」之前（括号是正文）。句子之间的空白算前一句
  var SENT_TAIL = /[。．.！!？?；;…]+["'”’」』]*\s*$/;
  U.sentenceEndAt = function (text, at) {
    var s = String(text == null ? '' : text);
    var spans = U.sentencesOf(s);
    var pick = null;
    for (var i = 0; i < spans.length; i += 1) {
      if (spans[i][0] > at) break;
      pick = spans[i];
    }
    if (!pick) pick = spans[0];
    if (!pick) return Math.max(0, Math.min(at, s.length));
    var body = s.slice(pick[0], pick[1]);
    var m = SENT_TAIL.exec(body);
    return m ? pick[0] + m.index : pick[1];
  };

  // 仅译文原地写回时各个引用的落点（按页面顺序）。标记都在、先后和页面一致 → 原样用（词级位置）；
  // 先后被模型换了 → 每个挪到它所在那一句的句末，挪完先后一致就用（句级位置）；
  // 有标记丢了、或挪完仍然对不上 → null，调用方安全降级（不能把引用塞进别的句子）
  U.keepPlacement = function (stripped, at) {
    var list = at || [];
    if (!list.length) return null;
    var i;
    for (i = 0; i < list.length; i += 1) {
      if (!(list[i] >= 0)) return null;
    }
    var ordered = true;
    for (i = 1; ordered && i < list.length; i += 1) ordered = list[i] >= list[i - 1];
    if (ordered) return { at: list.slice(), snapped: false };
    var snapped = list.map(function (one) {
      return U.sentenceEndAt(stripped, one);
    });
    for (i = 1; i < snapped.length; i += 1) {
      if (snapped[i] < snapped[i - 1]) return null;
    }
    return { at: snapped, snapped: true };
  };

  // 译文里的 <kN> 标记 → 按位置排好的 [{ start, end, id }]：id 0 是要去掉的散标记（模型编的编号、没配对的半个）
  function keepDrops(s, count, source) {
    var pairs = [];
    var cuts = [];
    var open = null;
    var m;
    KEEP_MARK.lastIndex = 0;
    while ((m = KEEP_MARK.exec(s))) {
      var id = Number(m[2]);
      var tok = { id: id, start: m.index, end: m.index + m[0].length };
      if (!(id >= 1 && id <= count)) {
        if (!source || String(source).indexOf(m[0]) < 0) cuts.push(tok);
        continue;
      }
      if (m[3]) {
        if (open) cuts.push(tok);
        else pairs.push(tok); // <k1/>：空保留区，只标位置
      } else if (!m[1]) {
        if (open) cuts.push(open);
        open = tok;
      } else if (open && open.id === id) {
        pairs.push({ id: id, start: open.start, end: tok.end });
        open = null;
      } else {
        cuts.push(tok);
      }
    }
    if (open) cuts.push(open);
    return pairs
      .map(function (p) {
        return { start: p.start, end: p.end, id: p.id };
      })
      .concat(
        cuts.map(function (c) {
          return { start: c.start, end: c.end, id: 0 };
        })
      )
      .sort(function (a, b) {
        return a.start - b.start;
      });
  }

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