// Bilibili 字幕来源适配层（扩展环境，只在 www.bilibili.com/video/* 加载）。
//
// 数据从哪里来：
//   页面主环境 content/bilibili-hook.js 截获播放器自己请求的 /x/player/(wbi/)v2 回包；
//   回包里有当前视频的 bvid / cid 和官方字幕轨元数据（含带时限签名的 subtitle_url）。
//   本层只接受 bvid/cid 与当前页面能对上的回包，再把带白名单校验的 CDN URL 交给后台取文本。
//
// 不读取 Cookie、不保存 SESSDATA、不调用第三方字幕服务；字幕 HTML 一律按纯文本处理。
// 统一轨道格式：{ platform, videoKey, trackKey, lang, kind, units }。
(function () {
  'use strict';

  var DT = window.__DT;
  if (!DT || !DT.subs) return; // 依赖 subtitles-core.js

  function isBilibiliHost(host) {
    return /(^|\.)bilibili\.com$/i.test(String(host || ''));
  }

  function pageInfo(loc) {
    var path = String((loc && loc.pathname) || '');
    var search = String((loc && loc.search) || '');
    var bv = /\/video\/(BV[0-9A-Za-z]+)/i.exec(path);
    var av = /\/video\/av(\d+)/i.exec(path);
    var p = /[?&]p=(\d+)/.exec(search);
    return {
      bvid: bv ? bv[1] : '',
      aid: av ? av[1] : '',
      page: p ? Number(p[1]) : 1,
      hasP: !!p,
      videoPage: !!(bv || av)
    };
  }

  function activeLanIn(doc) {
    var el = null;
    try {
      el = doc.querySelector('#bilibili-player .bpx-player-ctrl-subtitle-language-item.bpx-state-active') ||
        doc.querySelector('.bpx-player-ctrl-subtitle-language-item.bpx-state-active');
    } catch (err) {
      el = null;
    }
    var lan = el && el.getAttribute ? el.getAttribute('data-lan') : '';
    return lan ? String(lan) : '';
  }

  // 播放器改版时 active class 可能改名 / 不在 DOM 里；原生字幕层仍在显示时可作为兜底。
  function nativeSubtitleVisible(doc) {
    var wrap = null;
    try {
      wrap = doc.querySelector('#bilibili-player .bpx-player-subtitle-wrap') || doc.querySelector('.bpx-player-subtitle-wrap');
    } catch (err) {
      wrap = null;
    }
    if (!wrap || !wrap.getClientRects) return false;
    try {
      if (!wrap.getClientRects().length) return false;
      var view = doc.defaultView || window;
      var cs = view && view.getComputedStyle ? view.getComputedStyle(wrap) : null;
      return !cs || (cs.display !== 'none' && cs.visibility !== 'hidden');
    } catch (err) {
      return false;
    }
  }

  function createSource(env) {
    var doc = env.doc;
    var loc = env.location || {};
    var send = env.send;
    var now = env.now || function () { return Date.now(); };

    var pending = null;      // 最后一条尚未消费的播放器回包
    var lastMeta = null;     // 最近一条可信回包（即使 active 语言变化也要保留）
    var lastSeq = -1;
    var lastEmitted = '';
    var lastError = '';

    function log() {
      if (env.log) env.log.apply(null, arguments);
    }

    function page() {
      return pageInfo(loc);
    }

    function pageMatches(meta) {
      var p = page();
      if (!meta) return false;
      if (p.bvid) return meta.bvid === p.bvid;
      if (p.aid) return String(meta.aid || '') === p.aid;
      return false; // 非 /video/ 页面不接管
    }

    function currentCid() {
      var p = page();
      if (!lastMeta || !pageMatches(lastMeta)) return '';
      if (p.bvid && lastMeta.bvid !== p.bvid) return '';
      return lastMeta.cid;
    }

    function videoKey() {
      var p = page();
      if (!p.bvid) return '';
      var cid = currentCid();
      return cid ? p.bvid + ':' + cid : p.bvid;
    }

    // 只接受 code=0、bvid/cid 合法、subtitle.subtitles 是数组的回包。
    // 旧接口 200 + code=0 + 空 subtitle 是「这条接口没有」，并不等于视频一定没有字幕；
    // 这里只记录空轨道，等播放器下一次回包 / 用户切字幕时再判断。
    function parseMessage(data) {
      if (!data || data.source !== 'rimefox-bili' || data.type !== 'player') return null;
      if (typeof data.seq !== 'number' || !isFinite(data.seq)) return null;
      if (typeof data.body !== 'string' || !data.body || data.body.length > 600000) return null;
      var json;
      try {
        json = JSON.parse(data.body);
      } catch (err) {
        return null;
      }
      if (!json || json.code !== 0 || !json.data || typeof json.data !== 'object') return null;
      var d = json.data;
      var bvid = String(d.bvid || '');
      var cid = String(d.cid || '');
      var aid = String(d.aid || '');
      if (!/^BV[0-9A-Za-z]+$/.test(bvid) || !/^\d+$/.test(cid)) return null;
      var sub = d.subtitle && typeof d.subtitle === 'object' ? d.subtitle : null;
      var rawTracks = sub && Array.isArray(sub.subtitles) ? sub.subtitles : [];
      var tracks = [];
      rawTracks.forEach(function (one) {
        if (!one || typeof one !== 'object') return;
        var lan = String(one.lan || '');
        if (!lan) return;
        var url = String(one.subtitle_url || '');
        // 只保留 HTTPS 官方字幕 CDN；不可信地址不进入选择列表，避免误请求。
        if (!DT.subs.isTrustedBilibiliSubtitleUrl(url)) return;
        tracks.push(one);
      });
      var pageNo = Number(d.page_no);
      return {
        bvid: bvid,
        cid: cid,
        aid: aid,
        page: isFinite(pageNo) && pageNo > 0 ? pageNo : page().page,
        tracks: tracks,
        selectedLan: String((sub && sub.lan) || ''),
        seq: data.seq,
        at: now()
      };
    }

    function trackFor(meta, lan) {
      if (!meta || !lan) return null;
      var hit = null;
      for (var i = 0; i < meta.tracks.length; i += 1) {
        if (String(meta.tracks[i].lan || '') === lan) { hit = meta.tracks[i]; break; }
      }
      if (!hit) {
        for (var j = 0; j < meta.tracks.length; j += 1) {
          if (DT.subs.sameLanguage(meta.tracks[j].lan, lan)) { hit = meta.tracks[j]; break; }
        }
      }
      return hit;
    }

    function eventFrom(meta, lan) {
      var track = trackFor(meta, lan);
      if (!track) return null;
      var key = [meta.bvid, meta.cid, String(track.id_str || track.id || track.lan), String(track.lan), lan].join('|');
      if (key === lastEmitted) return null;
      lastEmitted = key;
      return { type: 'bilibili', meta: meta, track: track, lan: lan, key: key };
    }

    function accept(data) {
      var meta = parseMessage(data);
      if (!meta) return false;
      if (meta.seq < lastSeq) return false; // 旧请求晚返回：只接受不早于已见代际的回包
      if (meta.seq === lastSeq && lastMeta && meta.bvid === lastMeta.bvid && meta.cid === lastMeta.cid && pending) return false;
      lastSeq = meta.seq;
      lastMeta = meta;
      pending = { meta: meta, replay: data.replay === true };
      return true;
    }

    function take() {
      var meta = pending ? pending.meta : lastMeta;
      var lan = activeLanIn(doc);
      if (!meta || !pageMatches(meta)) return null; // 地址栏还没切到新 BV 时先留着，旧视频不能先接管
      if (!lan && nativeSubtitleVisible(doc)) {
        // 只接受播放器元数据明确给过的当前语言，或唯一轨道；不猜多语言里的某一条。
        lan = meta.selectedLan || (meta.tracks.length === 1 ? String(meta.tracks[0].lan || '') : '');
      }
      if (!lan) return null;
      var event = eventFrom(meta, lan);
      if (pending && pending.meta === meta) pending = null;
      return event;
    }

    function resolve(event) {
      if (!event || !event.track || !event.meta) return null;
      if (!pageMatches(event.meta)) return null;
      var raw = String(event.track.subtitle_url || '');
      if (!DT.subs.isTrustedBilibiliSubtitleUrl(raw)) return null;
      var url;
      try {
        url = new URL(raw, 'https://www.bilibili.com').href;
      } catch (err) {
        return null;
      }
      if (!DT.subs.isTrustedBilibiliSubtitleUrl(url)) return null;
      return Promise.resolve()
        .then(function () {
          return send({ type: 'subtitle:fetch', url: url });
        })
        .then(function (res) {
          if (!res || res.ok !== true || typeof res.text !== 'string' || !res.text) return null;
          if (res.text.length > 2 * 1024 * 1024) return null;
          var json;
          try {
            json = JSON.parse(res.text);
          } catch (err) {
            return null;
          }
          var track = DT.subs.bilibiliTrack(json, {
            bvid: event.meta.bvid,
            cid: event.meta.cid,
            page: event.meta.page,
            track: event.track
          });
          return track;
        })
        .catch(function (err) {
          lastError = (err && err.message) || 'fetch_failed';
          log('bilibili subtitles: fetch failed', lastError);
          return null;
        });
    }

    function playerView() {
      var video = null;
      try {
        video = doc.querySelector('#bilibili-player video') ||
          doc.querySelector('.bpx-player-video-wrap video') ||
          doc.querySelector('video');
      } catch (err) {
        video = null;
      }
      if (!video) return null;
      var player = video.closest ? (video.closest('#bilibili-player') || video.closest('.bpx-player-container') || video.closest('.bpx-player-video-area')) : null;
      if (!player) return null;
      return { player: player, video: video, ms: (Number(video.currentTime) || 0) * 1000 };
    }

    function matches(track) {
      if (!track) return false;
      var p = page();
      if (p.bvid && track.bvid && track.bvid !== p.bvid) return false;
      if (p.aid && track.aid && String(track.aid) !== p.aid) return false;
      // 分 P：URL 明确带 ?p= 时，页面变化立即让旧 P 轨道失效；不等播放器 / 地址栏谁先更新。
      if (p.hasP && track.page && Number(track.page) !== p.page) return false;
      var cid = currentCid();
      if (track.cid && cid && String(track.cid) !== cid) return false;
      return !!(p.videoPage);
    }

    return {
      platform: 'bilibili',
      hideNativeCss: '.rimefox-subs-on .bpx-player-subtitle-wrap{display:none !important;}.rimefox-subs-on .bili-subtitle-x-subtitle-panel{display:none !important;}',
      take: take,
      accept: accept,
      resolve: resolve,
      replay: function () {
        try {
          window.postMessage({ source: 'rimefox-ext-bili', type: 'replay' }, location.origin);
        } catch (err) {
          /* 忽略 */
        }
      },
      player: playerView,
      captionsOn: function () {
        if (activeLanIn(doc)) return true;
        // 只有播放器元数据明确记录过当前语言时，才用原生字幕层兜底；避免 CC 关闭后旧轨道继续显示。
        return !!(lastMeta && lastMeta.selectedLan) && nativeSubtitleVisible(doc);
      },
      matches: matches,
      blocked: function () { return false; },
      videoKey: videoKey,
      currentCid: currentCid,
      activeLan: function () { return activeLanIn(doc); },
      status: function () {
        if (!lastMeta) return 'loading';
        if (!lastMeta.tracks.length) return 'none';
        if (!activeLanIn(doc)) return 'off';
        return 'ready';
      },
      inspect: function () {
        return { pending: pending, meta: lastMeta, lastSeq: lastSeq, lastEmitted: lastEmitted, lastError: lastError };
      }
    };
  }

  // 测试入口：Node 用假 doc / location / send 直接构造来源层。
  DT.bilibiliSubtitleSource = { create: createSource };

  if (!isBilibiliHost(location.hostname)) return;
  if (!/(?:^|\/)video\//.test(location.pathname)) return;

  var source = createSource({
    doc: document,
    location: location,
    send: function (msg) { return DT.send(msg, 20000); },
    now: function () { return Date.now(); },
    log: function () { DT.log.apply(DT, arguments); }
  });

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    source.accept(event.data);
  });

  DT.subtitleSource = source;
})();