// YouTube 字幕：纯函数部分（解析 json3、拼句、二分查找…）。
// 自检页和 YouTube 运行时都会加载它；不碰 DOM，也不发请求。
(function () {
  'use strict';

  var DT = window.__DT;
  if (!DT) return;
  if (DT.subs) return; // 允许重复注入

  var subs = (DT.subs = {});
  // ---------------- 纯函数 ----------------

  var SENTENCE_END = /[.!?…。！？]["'”’)\]]*$/;
  var SOUND_TAG = /^[[(（【][^\])）】]*[\])）】]$/; // [Music]、(Applause)、[音乐]

  function clean(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // 字幕地址里的参数
  subs.paramsOf = function (url) {
    var out = { v: '', lang: '', tlang: '', kind: '' };
    try {
      var q = new URL(url, 'https://www.youtube.com').searchParams;
      out.v = q.get('v') || '';
      out.lang = q.get('lang') || '';
      out.tlang = q.get('tlang') || '';
      out.kind = q.get('kind') || '';
    } catch (err) {
      /* 坏地址就当没有参数 */
    }
    return out;
  };

  // 去掉 tlang：YouTube 机翻轨道 → 原文轨道
  subs.withoutTlang = function (url) {
    var u = new URL(url, 'https://www.youtube.com');
    u.searchParams.delete('tlang');
    return u.toString();
  };

  // 语言是否相同：zh-Hans ≈ zh-CN，zh-Hant ≈ zh-TW，其它比主语言
  function langKey(code) {
    var c = String(code || '').toLowerCase();
    if (/^zh(-hans|-cn|-sg)?$/.test(c)) return 'zh-cn';
    if (/^zh-(hant|tw|hk|mo)$/.test(c)) return 'zh-tw';
    return c.split('-')[0];
  }
  subs.sameLanguage = function (a, b) {
    return !!a && !!b && langKey(a) === langKey(b);
  };

  // 自动生成字幕：地址带 kind=asr，或片段带逐词偏移
  subs.isAsr = function (json, url) {
    if (subs.paramsOf(url || '').kind === 'asr') return true;
    var events = (json && json.events) || [];
    for (var i = 0; i < events.length && i < 50; i += 1) {
      var segs = events[i].segs || [];
      for (var k = 0; k < segs.length; k += 1) if (segs[k].tOffsetMs !== undefined) return true;
    }
    return false;
  };

  // 人工字幕：一个事件一条 [{ start, end, text }]
  subs.cuesOf = function (json) {
    var out = [];
    ((json && json.events) || []).forEach(function (e) {
      if (!e.segs) return;
      var text = clean(
        e.segs
          .map(function (s) {
            return s.utf8 || '';
          })
          .join('')
      );
      if (!text) return;
      var start = Number(e.tStartMs) || 0;
      out.push({ start: start, end: start + (Number(e.dDurationMs) || 0), text: text });
    });
    out.sort(function (a, b) {
      return a.start - b.start;
    });
    return out;
  };

  // 人工字幕 → 句子：一句被拆在相邻几条里时合并（整句翻译才通顺）。
  // 遇到句末标点、合并后超过 maxChars、或和下一条隔得太久就断开；[Music] 这类单独成句
  subs.sentencesOf = function (cues, opts) {
    var o = opts || {};
    var maxChars = o.maxChars || 120;
    var gapMs = o.gapMs || 1500;
    var out = [];
    var cur = null;
    function flush() {
      if (cur) out.push(cur);
      cur = null;
    }
    cues.forEach(function (cue) {
      var tag = SOUND_TAG.test(cue.text);
      if (cur && (tag || cue.start - cur.end > gapMs || cur.text.length + cue.text.length + 1 > maxChars)) flush();
      if (tag) {
        out.push({ start: cue.start, end: cue.end, text: cue.text, tag: true });
        return;
      }
      if (!cur) cur = { start: cue.start, end: cue.end, text: cue.text };
      else {
        cur.text += ' ' + cue.text;
        cur.end = Math.max(cur.end, cue.end);
      }
      if (SENTENCE_END.test(cue.text)) flush();
    });
    flush();
    return out;
  };

  // 自动生成字幕 → 逐词 [{ t, text, end }]（end = 所在事件的结束时间，最后一个词用）
  subs.wordsOf = function (json) {
    var out = [];
    ((json && json.events) || []).forEach(function (e) {
      if (!e.segs || e.aAppend) return; // aAppend 事件只是换行
      var start = Number(e.tStartMs) || 0;
      var end = start + (Number(e.dDurationMs) || 0);
      e.segs.forEach(function (s) {
        var text = clean(s.utf8);
        if (!text) return;
        out.push({ t: start + (Number(s.tOffsetMs) || 0), text: text, end: end });
      });
    });
    out.sort(function (a, b) {
      return a.t - b.t;
    });
    return out;
  };

  // 自动生成字幕 → 句子：没有标点，只能按停顿拼。
  // 停顿 ≥ pauseMs 断开；但这句还很短（< minChars）时要停顿 ≥ longPauseMs 才断，
  // 不然说话带停顿的人会被切成一两个词一段（真实演讲视频里 477 段有 108 段是这样），翻出来没法看；
  // 已经够长时，稍短的停顿也断；再长就硬断
  subs.chunksOf = function (words, opts) {
    var o = opts || {};
    var pauseMs = o.pauseMs || 600;
    var minChars = o.minChars || 20;
    var longPauseMs = o.longPauseMs || 1500;
    var softChars = o.softChars || 60;
    var softPauseMs = o.softPauseMs || 250;
    var maxChars = o.maxChars || 100;
    var tailMs = o.tailMs || 1500; // 一句说完后最多再停留多久
    var out = [];
    var cur = null;
    function flush(next) {
      if (!cur) return;
      var last = cur.lastT;
      cur.end = next ? Math.min(next.t, Math.max(cur.lastEnd, last + 800), last + tailMs) : last + tailMs;
      out.push({ start: cur.start, end: cur.end, text: cur.text, tag: cur.tag });
      cur = null;
    }
    words.forEach(function (w, i) {
      var tag = SOUND_TAG.test(w.text);
      if (cur) {
        var gap = w.t - cur.lastT;
        var len = cur.text.length;
        var pause = len < minChars ? longPauseMs : pauseMs;
        if (tag || cur.tag || gap >= pause || (len >= softChars && gap >= softPauseMs) || len + w.text.length + 1 > maxChars) {
          flush(w);
        }
      }
      if (!cur) cur = { start: w.t, text: w.text, lastT: w.t, lastEnd: w.end, tag: tag };
      else {
        cur.text += ' ' + w.text;
        cur.lastT = w.t;
        cur.lastEnd = w.end;
      }
      if (i === words.length - 1) flush(null);
    });
    return out;
  };

  // json3 + 地址 → 显示单位（句子）
  subs.unitsOf = function (json, url) {
    if (subs.isAsr(json, url)) return subs.chunksOf(subs.wordsOf(json));
    return subs.sentencesOf(subs.cuesOf(json));
  };

  // 二分查找 ms 时刻正在显示的单位
  subs.unitAt = function (units, ms) {
    var lo = 0;
    var hi = units.length - 1;
    var hit = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (units[mid].start <= ms) {
        hit = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return hit >= 0 && ms < units[hit].end ? hit : -1;
  };

  // 句间空档：上一句刚结束不久（默认 1.5s）时继续显示它，避免字幕闪一下就没。
  // 往前的空档（拖动到上一句之前）不保留；没有上一句也不保留。
  subs.shouldLinger = function (prev, ms, gapMs) {
    if (!prev) return false;
    var now = Number(ms) || 0;
    var gap = now - prev.end;
    return gap >= 0 && gap < (Number(gapMs) || 1500) && now >= prev.start;
  };

  // 运行时也要用到的文本清理（去空白、去声音标签）
  subs.clean = clean;
})();
