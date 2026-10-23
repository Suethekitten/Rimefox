// 内容脚本：开放 Shadow DOM 的受控翻译支持（0.10.2）
// 只处理可以合法访问的 open shadow root；closed root 直接跳过。
// 收集仍然复用 DT.collect / walk：这里只负责把 shadow root 里的元素交给 walk，
// 并给 shadow root 建立受控的 MutationObserver 和译文样式，不另建翻译引擎。
(function () {
  'use strict';

  var DT = window.__DT;
  if (!DT) return;
  if (DT.shadow) return;

  var S = (DT.shadow = {});
  var MODE = 'off'; // off | auto | targets
  var ADAPTER = null;
  var changeHandler = null;
  var records = []; // { host, root, observer, style, sheet }
  var rootRecords = new WeakMap();
  var hostRecords = new WeakMap();
  var pending = [];
  var pendingTimer = 0;
  var stylePromise = null;
  var cssText = '';
  var sharedSheet = null;
  var MAX_ROOTS = 160;
  var stats = {
    discovered: 0,
    targets: 0,
    roots: 0,
    observers: 0,
    pending: 0,
    capped: 0
  };

  function log() {
    if (DT.log) DT.log.apply(DT, arguments);
  }

  function textOfCss() {
    // html[...] 规则在 shadow root 里不会匹配；改成 :host-context(html[...])，
    // 这样深色 / 主题 / 排版规则在评论译文里也继续生效。
    var text = String(cssText || '');
    return text.replace(/html\[([^\]]+)\]/g, ':host-context(html[$1])');
  }

  // 同步兜底样式：CSS 资源还没 fetch 完时译文也不至于没有归一化。
  // 完整的 inject.css 加载后会换成共享的 Constructable Stylesheet。
  var BASE_CSS = [
    '.dt-target{display:block!important;margin:.38em 0 .2em;padding:0;font:inherit!important;color:inherit!important;line-height:inherit!important;letter-spacing:inherit!important;text-align:inherit!important;text-indent:0!important;text-transform:inherit!important;white-space:normal!important;word-break:inherit!important;overflow-wrap:anywhere!important;position:static!important;float:none!important;transform:none!important;filter:none!important;max-width:100%!important;box-sizing:border-box!important;opacity:1;border:0;background:none;box-shadow:none;animation:dt-fade-in .18s ease-out}',
    '.dt-target.dt-inline{display:inline!important;margin:0 0 0 .28em}',
    '.dt-target.dt-narrow{white-space:nowrap!important;overflow:visible!important}',
    '.dt-target.dt-lines{white-space:pre-line!important}',
    '.dt-target.dt-narrow.dt-lines{white-space:pre!important}',
    '.dt-target::first-letter{font-size:inherit!important;line-height:inherit!important;float:none!important;margin:0!important;padding:0!important;text-indent:0!important}',
    '.dt-target.dt-cjk-heading{font-size:.8em!important}',
    '.dt-target.dt-cjk-tight{line-height:1.25!important}',
    'br[data-dt-collapsed]{display:none!important}',
    '@keyframes dt-fade-in{from{opacity:0;transform:translateY(-1px)}to{opacity:1;transform:none}}'
  ].join('\n');

  function ensureCss() {
    if (stylePromise) return stylePromise;
    stylePromise = new Promise(function (resolve) {
      var url = '';
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
          url = chrome.runtime.getURL('content/styles/inject.css');
        }
      } catch (err) {
        url = '';
      }
      if (!url || typeof fetch !== 'function') {
        resolve();
        return;
      }
      fetch(url)
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.text();
        })
        .then(function (text) {
          cssText = String(text || '');
          addSharedSheet();
          applyFullCss();
          resolve();
        })
        .catch(function (err) {
          log('shadow css load failed', err && err.message ? err.message : err);
          resolve();
        });
    });
    return stylePromise;
  }

  function addSharedSheet() {
    if (!cssText || sharedSheet || typeof CSSStyleSheet !== 'function') return;
    try {
      sharedSheet = new CSSStyleSheet();
      sharedSheet.replaceSync(textOfCss());
    } catch (err) {
      sharedSheet = null;
    }
  }

  function applyFullCss() {
    if (!cssText) return;
    var text = textOfCss();
    records.forEach(function (rec) {
      if (sharedSheet) {
        ensureStyle(rec.root);
        return;
      }
      // Constructable Stylesheet 不可用 / replaceSync 失败：每个 root 一个 style，
      // 仍然只放同一份文本，不是每个译文节点一份。
      if (rec.root.__dtShadowStyle) rec.root.__dtShadowStyle.textContent = text;
    });
  }

  function ensureStyle(root) {
    if (!root) return;
    if (!root.__dtShadowStyle) {
      var base = document.createElement('style');
      base.setAttribute('data-dt-shadow-style', '1');
      base.textContent = BASE_CSS;
      root.appendChild(base);
      root.__dtShadowStyle = base;
    }
    ensureCss();
    if (!sharedSheet && cssText) addSharedSheet();
    if (!sharedSheet) {
      if (cssText && root.__dtShadowStyle) root.__dtShadowStyle.textContent = textOfCss();
      return;
    }
    try {
      var list = Array.prototype.slice.call(root.adoptedStyleSheets || []);
      if (list.indexOf(sharedSheet) < 0) {
        root.adoptedStyleSheets = list.concat([sharedSheet]);
      }
      if (root.__dtShadowStyle && root.__dtShadowStyle.parentNode) {
        // 共享样式表已经覆盖基础规则，去掉重复的兜底 style
        root.__dtShadowStyle.remove();
        root.__dtShadowStyle = null;
      }
    } catch (err) {
      // 老浏览器 / 页面禁止 adoptedStyleSheets：保留同步兜底 style
    }
  }

  function removeStyle(rec) {
    if (!rec) return;
    try {
      if (rec.root.__dtShadowStyle && rec.root.__dtShadowStyle.parentNode) {
        rec.root.__dtShadowStyle.remove();
      }
      rec.root.__dtShadowStyle = null;
      if (sharedSheet && rec.root.adoptedStyleSheets) {
        var list = Array.prototype.slice.call(rec.root.adoptedStyleSheets || []);
        var next = list.filter(function (one) {
          return one !== sharedSheet;
        });
        if (next.length !== list.length) rec.root.adoptedStyleSheets = next;
      }
    } catch (err) {
      /* 忽略 */
    }
  }

  function isElement(node) {
    return !!node && node.nodeType === 1;
  }

  function localName(el) {
    return String((el && (el.localName || el.tagName)) || '').toLowerCase();
  }

  function adopt(host, root) {
    if (!isElement(host)) return null;
    if (!root) root = host.shadowRoot;
    if (!root) return null;
    var old = hostRecords.get(host);
    if (old && old.root === root) return old;
    if (rootRecords.has(root)) return rootRecords.get(root);
    if (records.length >= MAX_ROOTS) {
      stats.capped += 1;
      return null;
    }
    var rec = { host: host, root: root, observer: null, style: null, sheet: null };
    records.push(rec);
    hostRecords.set(host, rec);
    rootRecords.set(root, rec);
    stats.discovered += 1;
    stats.roots = records.length;
    ensureStyle(root);
    return rec;
  }

  function findRecord(root) {
    return root ? rootRecords.get(root) || null : null;
  }

  function meaningful(records) {
    for (var i = 0; i < records.length; i += 1) {
      var record = records[i];
      var target = record.target;
      if (target && DT.isOwnNode && DT.isOwnNode(target)) continue;
      if (record.type === 'characterData') {
        if (DT.isOwnWrite && DT.isOwnWrite(target)) continue;
        return true;
      }
      if (record.type === 'childList') {
        var removed = record.removedNodes || [];
        var added = record.addedNodes || [];
        var foreign = false;
        var j;
        for (j = 0; j < added.length; j += 1) {
          if (!(DT.isOwnNode && DT.isOwnNode(added[j]))) {
            foreign = true;
            break;
          }
        }
        for (j = 0; j < removed.length; j += 1) {
          if (!(DT.isOwnNode && DT.isOwnNode(removed[j]))) {
            foreign = true;
            break;
          }
        }
        if (foreign) return true;
      }
    }
    return false;
  }

  function onMutation(list) {
    if (!S.active()) return;
    if (!meaningful(list)) return;
    S.prune();
    if (changeHandler) changeHandler();
  }

  S.observe = function (root, host) {
    if (!root) return null;
    var rec = findRecord(root) || adopt(host || root.host, root);
    if (!rec) return null;
    if (rec.observer) return rec;
    try {
      rec.observer = new MutationObserver(onMutation);
      rec.observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true
      });
      stats.observers += 1;
    } catch (err) {
      log('shadow observe failed', err && err.message ? err.message : err);
    }
    return rec;
  };

  function disconnect(rec) {
    if (!rec) return;
    try {
      if (rec.observer) {
        rec.observer.disconnect();
        stats.observers = Math.max(0, stats.observers - 1);
      }
    } catch (err) {
      /* 忽略 */
    }
    rec.observer = null;
  }

  S.prune = function () {
    var kept = [];
    records.forEach(function (rec) {
      var host = rec.host;
      var alive = false;
      try {
        alive = !!host && host.isConnected && host.shadowRoot === rec.root;
      } catch (err) {
        alive = false;
      }
      if (!alive) {
        disconnect(rec);
        removeStyle(rec);
        if (hostRecords.get(host) === rec) hostRecords.delete(host);
        if (rootRecords.get(rec.root) === rec) rootRecords.delete(rec.root);
        return;
      }
      kept.push(rec);
    });
    records = kept;
    stats.roots = records.length;
  };

  function clearPending() {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = 0;
    }
    pending = [];
    stats.pending = 0;
  }

  function schedulePending() {
    if (pendingTimer || !pending.length || !S.active()) return;
    pendingTimer = setTimeout(function () {
      pendingTimer = 0;
      if (!S.active()) return;
      var again = [];
      pending.forEach(function (one) {
        if (!one.host || !one.host.isConnected) return;
        if (one.host.shadowRoot) {
          S.adopt(one.host);
          if (ADAPTER && ADAPTER.afterAdopt) ADAPTER.afterAdopt(one.host);
          if (changeHandler) changeHandler();
          return;
        }
        one.tries += 1;
        if (one.tries < 3) again.push(one);
      });
      pending = again;
      stats.pending = pending.length;
      if (pending.length) schedulePending();
    }, 350);
  }

  S.adopt = function (host) {
    if (!S.active() || !isElement(host)) return null;
    if (!host.shadowRoot) return null;
    var rec = adopt(host, host.shadowRoot);
    if (rec && ADAPTER && ADAPTER.shouldObserve && ADAPTER.shouldObserve(host, host.shadowRoot)) {
      S.observe(host.shadowRoot, host);
    }
    return rec;
  };

  // auto 模式：普通收集走到 host 时进入它的 open shadow root；
  // targets 模式返回 null，由适配器只收集指定内容根。
  S.enter = function (host) {
    if (!S.active() || MODE !== 'auto') return null;
    if (!isElement(host) || !host.shadowRoot) return null;
    if (ADAPTER && ADAPTER.allowHost && !ADAPTER.allowHost(host)) return null;
    var rec = adopt(host, host.shadowRoot);
    if (!rec) return null;
    if (!ADAPTER || !ADAPTER.shouldObserve || ADAPTER.shouldObserve(host, host.shadowRoot)) {
      S.observe(host.shadowRoot, host);
    }
    return host.shadowRoot;
  };

  S.skip = function (el) {
    return !!(ADAPTER && ADAPTER.skipHost && ADAPTER.skipHost(el));
  };

  S.isSlot = function (el) {
    return localName(el) === 'slot';
  };

  S.assigned = function (slot) {
    try {
      if (slot.assignedNodes) {
        var list = slot.assignedNodes({ flatten: true });
        if (list && list.length) return list;
      }
    } catch (err) {
      /* 忽略 */
    }
    return slot.childNodes || [];
  };

  S.collectTargets = function () {
    if (!S.active() || MODE !== 'targets' || !ADAPTER || !ADAPTER.collectTargets) return [];
    var list = [];
    try {
      list = ADAPTER.collectTargets() || [];
    } catch (err) {
      log('shadow collectTargets failed', err && err.message ? err.message : err);
      return [];
    }
    var out = [];
    var seen = new Set();
    list.forEach(function (el) {
      if (!isElement(el) || seen.has(el)) return;
      seen.add(el);
      var root = el.getRootNode ? el.getRootNode() : null;
      if (root && root.host) adopt(root.host, root);
      // 即使达到 root 记录上限，也要给内容根装样式，不能让后面的评论变成裸节点。
      if (root) ensureStyle(root);
      out.push(el);
    });
    stats.targets = out.length;
    return out;
  };

  // 供还原兜底 / 诊断使用：包括 document 和所有当前 open shadow root 里的节点。
  S.all = function (selector) {
    var out = [];
    var seen = new Set();
    var roots = 0;
    function visit(root) {
      if (!root || roots >= 500) return;
      roots += 1;
      try {
        var list = root.querySelectorAll(selector);
        for (var i = 0; i < list.length; i += 1) {
          if (!seen.has(list[i])) {
            seen.add(list[i]);
            out.push(list[i]);
          }
        }
      } catch (err) {
        /* 选择器写错：不阻断还原 */
      }
      var all = [];
      try {
        all = root.querySelectorAll('*');
      } catch (err) {
        return;
      }
      for (var j = 0; j < all.length; j += 1) {
        if (all[j].shadowRoot) visit(all[j].shadowRoot);
      }
    }
    visit(document);
    return out;
  };

  S.noteAdded = function (nodes) {
    if (!S.active() || !nodes) return;
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      if (!isElement(el)) continue;
      var candidate = false;
      if (ADAPTER && ADAPTER.isHost) {
        try {
          candidate = !!ADAPTER.isHost(el);
        } catch (err) {
          candidate = false;
        }
      }
      if (!candidate && localName(el).indexOf('-') >= 0) candidate = true;
      if (!candidate) continue;
      if (el.shadowRoot) {
        S.adopt(el);
        if (ADAPTER && ADAPTER.afterAdopt) ADAPTER.afterAdopt(el);
        if (changeHandler) changeHandler();
      } else {
        if (pending.some(function (one) { return one.host === el; })) continue;
        if (pending.length >= 60) continue;
        pending.push({ host: el, tries: 0 });
        stats.pending = pending.length;
        schedulePending();
      }
    }
  };

  S.enable = function (opts) {
    var options = opts || {};
    MODE = options.mode === 'auto' ? 'auto' : 'targets';
    ADAPTER = options;
    MAX_ROOTS = Math.max(1, Math.min(400, Number(options.maxRoots) || 160));
    S.reset();
    ensureCss();
  };

  S.disable = function () {
    MODE = 'off';
    ADAPTER = null;
    S.reset();
  };

  S.reset = function () {
    clearPending();
    records.forEach(function (rec) {
      disconnect(rec);
      removeStyle(rec);
    });
    records = [];
    rootRecords = new WeakMap();
    hostRecords = new WeakMap();
    stats.roots = 0;
    stats.observers = 0;
    stats.targets = 0;
  };

  S.active = function () {
    return MODE !== 'off';
  };

  S.mode = function () {
    return MODE;
  };

  S.setChangeHandler = function (fn) {
    changeHandler = typeof fn === 'function' ? fn : null;
  };

  S.diagnostics = function () {
    return {
      mode: MODE,
      name: ADAPTER && ADAPTER.name ? ADAPTER.name : '',
      roots: records.length,
      observers: stats.observers,
      targets: stats.targets,
      pending: stats.pending,
      discovered: stats.discovered,
      capped: stats.capped,
      maxRoots: MAX_ROOTS
    };
  };

  // 通用测试夹具 / 后续适配器显式 opt-in；Bilibili 由适配器自己 enable。
  // 不在所有网站默认打开 Shadow DOM 扫描。
  function maybeAutoEnable() {
    try {
      var html = document.documentElement;
      if (html && html.hasAttribute('data-dt-shadow-auto')) {
        S.enable({ mode: 'auto', name: 'shadow-fixture' });
      }
    } catch (err) {
      /* 忽略 */
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', maybeAutoEnable, { once: true });
  } else {
    maybeAutoEnable();
  }
})();
