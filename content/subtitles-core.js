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

  // 语言是否相同：zh-Hans ≈ zh-CN，zh-Hant ≈ zh-TW，ai-zh ≈ zh-CN，其它比主语言。
  // Bilibili 的 AI 轨道用 ai-zh / ai-en 这种前缀，不能把它当成独立语言。
  function langKey(code) {
    var c = String(code || '').toLowerCase().replace(/_/g, '-');
    if (/^ai-/.test(c)) c = c.slice(3);
    if (/^zh(-hans|-cn|-sg|-zh)?$/.test(c)) return 'zh-cn';
    if (/^zh-(hant|tw|hk|mo)$/.test(c)) return 'zh-tw';
    if (c === 'zh') return 'zh-cn';
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

  // ---------------- Bilibili 字幕 JSON ----------------
  // Bilibili 的 body 是 [{ from: 秒, to: 秒, content: 文本 }]。不执行 HTML、不读 innerHTML；
  // 只做纯文本规范化、时间边界与重复 / 空段过滤，避免坏数据进入翻译调度。
  var BILI_MAX_UNIT_CHARS = 2000;
  var BILI_MAX_SECONDS = 24 * 60 * 60;

  function finiteSeconds(value) {
    var n = Number(value);
    return isFinite(n) && n >= 0 && n <= BILI_MAX_SECONDS ? n : NaN;
  }

  // 严格 URL 白名单：只接受 B 站官方字幕 CDN 的 HTTPS 地址。
  // 与 lib/subtitle-source.js 的实现必须一致（差分测试见 test/bilibili-subtitles.test.mjs）。
  subs.isTrustedBilibiliSubtitleUrl = function (value) {
    var u;
    try {
      u = new URL(String(value || ''), 'https://www.bilibili.com');
    } catch (err) {
      return false;
    }
    if (u.protocol !== 'https:') return false;
    var host = String(u.hostname || '').toLowerCase();
    var path = String(u.pathname || '');
    if (host === 'aisubtitle.hdslb.com' && /^\/bfs\/(ai_)?subtitle\//.test(path)) return true;
    if (/^i[0-9]\.hdslb\.com$/.test(host) && /^\/bfs\/subtitle\//.test(path)) return true;
    return false;
  };

  subs.bilibiliCues = function (json) {
    var body = json && json.body;
    if (!Array.isArray(body) || !body.length) return [];
    var out = [];
    var seen = {};
    body.forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      var from = finiteSeconds(item.from);
      var to = finiteSeconds(item.to);
      if (!isFinite(from) || !isFinite(to) || to <= from) return;
      var text = clean(typeof item.content === 'string' ? item.content : '');
      if (!text) return;
      if (text.length > BILI_MAX_UNIT_CHARS) return; // 超长正文交给模型会挤爆批次，宁可不接管
      var start = Math.round(from * 1000);
      var end = Math.round(to * 1000);
      if (end <= start) return;
      var id = start + '|' + end + '|' + text;
      if (seen[id]) return;
      seen[id] = true;
      out.push({ start: start, end: end, text: text });
    });
    out.sort(function (a, b) {
      return a.start - b.start || a.end - b.end;
    });
    // 完全包含在前一条里的重复段（站点偶发重复推送）只保留先出现的那条。
    var merged = [];
    out.forEach(function (cue) {
      var prev = merged[merged.length - 1];
      if (prev && cue.start >= prev.start && cue.end <= prev.end && cue.text === prev.text) return;
      merged.push(cue);
    });
    return merged;
  };

  // Bilibili 的每一段本来就是播放器显示的单位，有自己的起止时间。中文字幕和 AI 字幕通常不带句末标点，
  // 按句末标点合并会把十几段拼成一段、显示三十秒，字幕和画面脱节，还会在中文之间插空格：不跨段合并。
  // 同一批请求里相邻几段会一起送翻，模型仍能看到上下文。
  subs.bilibiliUnits = function (json) {
    return subs.bilibiliCues(json).map(function (cue) {
      var unit = { start: cue.start, end: cue.end, text: cue.text };
      if (SOUND_TAG.test(cue.text)) unit.tag = true;
      return unit;
    });
  };

  // 把轨道元数据 + 已解析 body 变成统一时间轴。id 只用于区分轨道，不进入翻译文本。
  subs.bilibiliTrack = function (json, meta) {
    var m = meta || {};
    var track = m.track || {};
    var units = subs.bilibiliUnits(json);
    if (!units.length) return null;
    var rawLang = String(track.lan || '');
    var lk = langKey(rawLang);
    var displayLang = lk === 'zh-cn' ? 'zh-CN' : (lk === 'zh-tw' ? 'zh-TW' : (/^ai-/.test(rawLang) ? lk : rawLang));
    var key = [
      String(m.bvid || ''),
      String(m.cid || ''),
      String(track.id_str || track.id || rawLang || 'track'),
      rawLang
    ].join(':');
    return {
      platform: 'bilibili',
      videoKey: String(m.bvid || '') + ':' + String(m.cid || ''),
      bvid: String(m.bvid || ''),
      cid: String(m.cid || ''),
      page: Number(m.page) || 0,
      trackKey: key,
      lang: displayLang,
      rawLang: rawLang,
      kind: /^ai-/.test(rawLang) || /\/ai_subtitle\//.test(String(track.subtitle_url || '')) ? 'asr' : 'manual',
      label: String(track.lan_doc || ''),
      units: units
    };
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
