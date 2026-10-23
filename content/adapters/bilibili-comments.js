// Bilibili 评论区适配器（0.10.2）
// 只负责：确认站点、找到评论正文、告诉通用 Shadow DOM 层收集哪些根、监听哪个边界。
// 不实现翻译、缓存或注入；那些仍走 DT.collect / DT.inject / DT.restore。
(function () {
  'use strict';

  var DT = window.__DT;
  if (!DT || !DT.shadow) return;
  // 评论区在顶层页面；内容脚本虽然注入 iframe，但不在子框架启用 shadow 扫描。
  if (window.top !== window) return;

  var html = document.documentElement;
  if (!html) return;
  if (html.hasAttribute('data-dt-shadow-auto')) return; // 通用夹具由 shadow.js 自己启用

  var hostname = '';
  try {
    hostname = String(location.hostname || '').toLowerCase();
  } catch (err) {
    hostname = '';
  }
  var isBili = /(^|\.)bilibili\.com$/.test(hostname) || /(^|\.)bilibili\.tv$/.test(hostname);
  var isTest = html.hasAttribute('data-dt-shadow-test');
  if (!isBili && !isTest) return;

  var TAGS = {
    'bili-comments': 1,
    'bili-comment-thread-renderer': 1,
    'bili-comment-renderer': 1,
    'bili-comment-reply-renderer': 1,
    'bili-rich-text': 1
  };
  var MAX_ROOTS = 200;
  var MAX_TARGETS = 600;

  function local(el) {
    return String((el && (el.localName || el.tagName)) || '').toLowerCase();
  }

  function isElement(node) {
    return !!node && node.nodeType === 1;
  }

  function inComments(el) {
    var cur = el;
    while (cur) {
      if (local(cur) === 'bili-comments') return true;
      var root = cur.getRootNode ? cur.getRootNode() : null;
      if (root && root.host) cur = root.host;
      else cur = cur.parentNode || null;
    }
    return false;
  }

  function isBiliHost(el) {
    return !!el && !!TAGS[local(el)];
  }

  // 普通 walk 不进入这些宿主；评论正文由 collectTargets 精确收集，
  // 避免把昵称、时间、点赞、操作按钮当成正文。
  function skipHost(el) {
    if (!isElement(el) || !el.shadowRoot) return false;
    return isBiliHost(el) && inComments(el);
  }

  function addTarget(list, seen, el) {
    if (!isElement(el) || seen.has(el)) return;
    seen.add(el);
    list.push(el);
  }

  function collectTargets() {
    var commentsHosts = [];
    try {
      commentsHosts = Array.prototype.slice.call(document.querySelectorAll('bili-comments'));
    } catch (err) {
      commentsHosts = [];
    }
    // 如果 bili-comments 本身被另一层开放 shadow root 包住，从那里也能找到
    if (!commentsHosts.length && DT.shadow.all) {
      commentsHosts = DT.shadow.all('bili-comments');
    }

    var targets = [];
    var targetSeen = new Set();
    var rootSeen = new Set();
    var rootCount = 0;

    commentsHosts.forEach(function (comments) {
      var commentsRoot = comments && comments.shadowRoot;
      // 新版是 bili-comments.shadowRoot；旧版/混合形态也可能把 thread 放在
      // bili-comments 的 light DOM 里。两种入口都从同一个 BFS 走，targetSeen 去重。
      var queue = [];
      if (commentsRoot) {
        // 只监听评论区 feed 这一个边界。新一级评论 / 排序重建从 feed 进入；
        // 楼中楼展开、回复加载由现有的 click / scroll 增量补扫接管，
        // 不为每条评论或每个 thread 建 Observer。
        DT.shadow.observe(commentsRoot, comments);
        queue.push(commentsRoot);
      }
      if (!commentsRoot || comments.children.length) queue.push(comments);
      if (!queue.length) return;
      while (queue.length && rootCount < MAX_ROOTS && targets.length < MAX_TARGETS) {
        var root = queue.shift();
        if (!root || rootSeen.has(root)) continue;
        rootSeen.add(root);
        rootCount += 1;

        // 评论正文：bili-rich-text 的 open shadow root 里的 #contents。
        var rich = [];
        try {
          rich = root.querySelectorAll('bili-rich-text');
        } catch (err) {
          rich = [];
        }
        for (var i = 0; i < rich.length && targets.length < MAX_TARGETS; i += 1) {
          var richRoot = rich[i].shadowRoot;
          if (!richRoot) continue;
          var contents = null;
          try {
            contents = richRoot.querySelector('#contents');
          } catch (err) {
            contents = null;
          }
          if (!contents) continue;
          var bodyText = String(contents.textContent || '').trim();
          // 未登录时 B 站会把「登录后查看 N 条评论」也放进 rich-text，不能当评论正文翻。
          if (/^(登录后查看|登录后参与|登录后查看评论)/.test(bodyText)) continue;
          if (!bodyText) continue;
          // 折叠/未展示的回复不翻译。checkVisibility 会看祖先的 display / visibility；
          // content-visibility:auto 不参与（评论滚到附近时仍要能懒翻译）。
          try {
            if (contents.checkVisibility) {
              if (!contents.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true, contentVisibilityAuto: false })) continue;
            } else {
              var cs = getComputedStyle(contents);
              if (cs.display === 'none') continue;
              if (!contents.getClientRects().length && cs.display !== 'contents') continue;
            }
          } catch (err) {
            /* 老浏览器：继续交给 collect 的 isSkipped */
          }
          addTarget(targets, targetSeen, contents);
        }

        // 继续下钻评论组件。只入队 bili-* 的 open root：B 站给回复 / 表情 / 操作区换标签时
        // 不需要改白名单，也不会跑进播放器或推荐位（起点已经是 bili-comments）。
        var nested = [];
        try {
          nested = root.querySelectorAll('*');
        } catch (err) {
          nested = [];
        }
        for (var j = 0; j < nested.length; j += 1) {
          var el = nested[j];
          if (!el.shadowRoot) continue;
          if (String(el.localName || '').indexOf('bili-') !== 0) continue;
          var next = el.shadowRoot;
          if (!rootSeen.has(next) && rootCount + queue.length < MAX_ROOTS) queue.push(next);
        }
      }
    });

    return targets;
  }

  DT.shadow.enable({
    mode: 'targets',
    name: 'bilibili-comments',
    maxRoots: MAX_ROOTS,
    isHost: isBiliHost,
    skipHost: skipHost,
    collectTargets: collectTargets
  });
})();
