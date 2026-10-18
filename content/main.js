// 内容脚本：调度层（开关 / 批处理 / 动态补翻 / 快捷键）
(function () {
  'use strict';

  var DT = window.__DT;
  if (!DT) return;
  // 允许被 popup / 快捷键重复注入：只初始化一次
  if (DT.__booted) return;
  DT.__booted = true;

  var observer = null;
  var debounceTimer = 0;
  var lastUrl = location.href;
  var urlTimer = 0;
  var running = false;
  var runningSince = 0;
  var dirty = false; // 翻译过程中页面又变了

  function applyChrome() {
    var html = document.documentElement;
    if (!html) return;
    html.setAttribute('data-dt', DT.state.enabled ? 'on' : 'off');
    html.setAttribute('data-dt-mode', DT.state.mode || 'dual');
    html.setAttribute('data-dt-theme', DT.state.theme || 'underline');
  }

  async function loadConfig() {
    try {
      var res = await DT.send({ type: 'config:get' });
      if (res && res.ok && res.config) {
        DT.state.config = res.config;
        DT.state.target = res.config.targetLang || 'zh-CN';
        DT.state.mode = res.config.mode || 'dual';
        DT.state.theme = res.config.theme || 'underline';
      }
    } catch (err) {
      DT.log('loadConfig failed', err);
    }
    applyChrome();
    return DT.state.config;
  }

  function summarize() {
    return {
      enabled: DT.state.enabled,
      mode: DT.state.mode,
      target: DT.state.target,
      total: DT.state.total,
      translated: DT.state.translated,
      failed: DT.state.failed,
      skipped: DT.state.skipped || 0,
      lastError: DT.state.lastError || '',
      busy: running
    };
  }

  // ---------------- 翻译主流程 ----------------
  // opts: { reset: 是否清零统计, silent: 是否不弹提示 }
  async function translatePage(opts) {
    var options = opts || {};
    if (running || !DT.state.enabled) return;
    running = true;
    runningSince = Date.now();
    try {
      var cfg = DT.state.config || {};
      var target = DT.state.target;
      var maxUnit = Number(cfg.maxUnitChars) || 1200;

      var units = DT.collect(document.body);
      var queue = [];
      units.forEach(function (unit) {
        if (DT.skipText(unit.text)) return;
        if (cfg.skipSameLang !== false && DT.looksLikeTarget(unit.text, target)) return;
        queue.push(unit);
      });

      if (!queue.length) {
        if (!options.silent) DT.toast('没有需要翻译的段落（可能已是目标语言）');
        running = false;
        return;
      }

      if (options.reset) {
        DT.state.translated = 0;
        DT.state.failed = 0;
      }
      DT.state.total = Math.max(DT.state.total || 0, queue.length);

      // 长段落切成多段，逐段翻完后拼回同一位置
      var segments = [];
      queue.forEach(function (unit, ui) {
        var parts = DT.splitLong(unit.text, maxUnit);
        unit.slots = new Array(parts.length);
        unit.done = false;
        parts.forEach(function (part, k) {
          segments.push({ ui: ui, k: k, text: part });
        });
      });

      // 组批：条数 + 字符数双阈值
      var maxItems = Math.max(1, Number(cfg.batchSize) || 12);
      var maxChars = Math.max(200, Number(cfg.maxCharsPerBatch) || 3000);
      var batches = [];
      var current = [];
      var chars = 0;
      segments.forEach(function (seg) {
        if (current.length && (current.length >= maxItems || chars + seg.text.length > maxChars)) {
          batches.push(current);
          current = [];
          chars = 0;
        }
        current.push(seg);
        chars += seg.text.length;
      });
      if (current.length) batches.push(current);

      DT.log('segments', segments.length, 'batches', batches.length);

      function tryInject(unit) {
        if (!unit || unit.done) return;
        if (DT.state.abort) return;
        for (var k = 0; k < unit.slots.length; k += 1) {
          if (unit.slots[k] === undefined) return; // 还有段没回来
        }
        var text = unit.slots
          .filter(function (part) {
            return part;
          })
          .join(' ')
          .trim();
        unit.done = true;
        if (!text) {
          DT.state.skipped = (DT.state.skipped || 0) + 1;
          return;
        }

        // 译文与原文完全一致（用户名、数字、专有名词等）就不插入了，
        // 否则会叠成一条"删除线"，看着像渲染 bug。
        if (DT.normalizeText(text) === DT.normalizeText(unit.text)) {
          DT.state.skipped = (DT.state.skipped || 0) + 1;
          return;
        }

        if (DT.inject(unit.el, text, target)) {
          DT.state.translated += 1;
        }
      }

      async function runBatch(batch) {
        if (DT.state.abort) return;
        var texts = batch.map(function (seg) {
          return seg.text;
        });
        var res = null;
        try {
          res = await DT.send({ type: 'translate', texts: texts, target: target });
        } catch (err) {
          DT.log('send failed', err);
          DT.state.failed += batch.length;
          return;
        }
        if (DT.state.abort) return; // 期间用户点了"还原"
        if (!res || !res.results) {
          DT.state.failed += batch.length;
          if (res && res.error) {
            DT.state.lastError = res.error;
            DT.log('batch error', res.error);
          }
          return;
        }
        if (res.error) DT.state.lastError = res.error;
        batch.forEach(function (seg, k) {
          var value = res.results[k];
          if (typeof value === 'string' && value.trim()) {
            queue[seg.ui].slots[seg.k] = value.trim();
          } else {
            // 模型返回空（比如原文本身是 "EN"/"×" 这种）：记为"同原文跳过"，
            // 不算失败 —— 否则统计里会出现莫名其妙的"失败 N 段"
            queue[seg.ui].slots[seg.k] = '';
            DT.state.skipped = (DT.state.skipped || 0) + 1;
          }
        });
        batch.forEach(function (seg) {
          tryInject(queue[seg.ui]);
        });
      }

      var cursor = 0;
      async function worker() {
        while (cursor < batches.length) {
          if (DT.state.abort) return;
          var batch = batches[cursor];
          cursor += 1;
          await runBatch(batch);
        }
      }

      var workers = [];
      var parallel = Math.min(3, batches.length);
      for (var w = 0; w < parallel; w += 1) workers.push(worker());
      await Promise.all(workers);

      // 兜底：把剩余能拼的补上
      queue.forEach(tryInject);

      if (DT.state.abort) {
        // 用户中途点了"还原"，不再弹提示
      } else if (!options.silent) {
        if (DT.state.failed > 0) {
          DT.toast('新增 ' + (DT.state.translated) + ' 段译文，' + DT.state.failed + ' 段失败');
        } else {
          DT.toast('已翻译 ' + queue.length + ' 段');
        }
      }
    } catch (err) {
      DT.log('translatePage error', err);
      if (!options.silent) {
        DT.toast('翻译出错：' + (err && err.message ? err.message : String(err)));
      }
    } finally {
      running = false;
      runningSince = 0;
      if (dirty) {
        dirty = false;
        scheduleIncremental();
      }
    }
  }

  // ---------------- 开关 ----------------
  async function enable() {
    var cfg = await loadConfig();
    if (!cfg || !cfg.apiKey) {
      DT.toast('还没配置 API Key：点扩展图标 → 设置');
      return summarize();
    }
    DT.state.enabled = true;
    DT.state.abort = false;
    DT.send({ type: 'resume:set', value: true }).catch(function () {});
    detectForeignTranslator();
    DT.state.total = 0;
    DT.state.translated = 0;
    DT.state.failed = 0;
    DT.state.skipped = 0;
    DT.state.lastError = '';
    applyChrome();
    // 注意：这里故意不 await —— 弹窗要能立刻拿到状态并开始轮询
    translatePage({ reset: true });
    return summarize();
  }

  function disable() {
    DT.state.abort = true;
    DT.state.enabled = false;
    DT.send({ type: 'resume:set', value: false }).catch(function () {});
    DT.restore();
    applyChrome();
    DT.toast('已还原原文');
    return summarize();
  }

  async function toggle() {
    lastToggleAt = Date.now();
    if (DT.state.enabled) return disable();
    return enable();
  }

  // Alt+A 的页面级兜底。
  // 浏览器的 commands 一旦被别的扩展占用，onCommand 就永远不触发。
  // 这里在页面里再抓一次，两者用 lastToggleAt 去重，不会翻两次。
  var lastToggleAt = 0;

  // 解析 "alt+a" / "alt+shift+a" / "ctrl+shift+a" 这类配置
  function matchesHotkey(event, spec) {
    var parts = String(spec || 'alt+a').toLowerCase().split('+');
    var key = parts.pop();
    if (!key) return false;
    var wantAlt = parts.indexOf('alt') >= 0;
    var wantCtrl = parts.indexOf('ctrl') >= 0;
    var wantShift = parts.indexOf('shift') >= 0;
    if (wantAlt !== event.altKey) return false;
    if (wantCtrl !== event.ctrlKey) return false;
    if (wantShift !== event.shiftKey) return false;
    if (event.metaKey) return false;
    return String(event.key || '').toLowerCase() === key;
  }

  function bindHotkey() {
    document.addEventListener(
      'keydown',
      function (event) {
        var spec = (DT.state.config && DT.state.config.hotkey) || 'alt+a';
        if (!matchesHotkey(event, spec)) return;
        var target = event.target;
        if (target && target.nodeType === 1) {
          if (target.isContentEditable) return;
          if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
        }
        event.preventDefault();
        var now = Date.now();
        if (now - lastToggleAt < 400) return; // 和浏览器命令去重
        toggle().catch(function (err) {
          DT.log('hotkey toggle failed', err);
        });
      },
      true
    );
  }

  // ---------------- 动态内容 ----------------
  function scheduleIncremental() {
    if (!DT.state.enabled) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      if (!DT.state.enabled) return;
      if (running) {
        dirty = true;
        return;
      }
      translatePage({ silent: true });
    }, 600);
  }

  // 悬停/聚焦时补扫：下拉菜单、浮层往往是 hover 时才把内容塞进 DOM，
  // 光靠 MutationObserver 会漏（有的站点只改 class 不改结构）。
  function bindHoverRescan() {
    var hoverTimer = 0;

    function poke(target) {
      if (!DT.state.enabled || !target || target.nodeType !== 1) return;
      if (!target.closest) return;
      var menu = target.closest(
        '[role="menu"],[role="listbox"],[role="dialog"],[class*="dropdown"],[class*="popup"],[class*="menu"],[class*="submenu"],[class*="tooltip"]'
      );
      if (!menu) return;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(function () {
        if (DT.state.enabled && !running) translatePage({ silent: true });
      }, 400);
    }

    document.addEventListener(
      'mouseover',
      function (event) {
        poke(event.target);
      },
      true
    );
    document.addEventListener(
      'focusin',
      function (event) {
        poke(event.target);
      },
      true
    );
  }

  // 站点会克隆整块内容（轮播、动画、骨架屏），克隆时把我们的译文节点
  // 一起复制了 —— 表现为同一段译文出现两遍。这里清理同级重复的译文节点。
  function cleanupDuplicateTargets(nodes) {
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (!node || node.nodeType !== 1) continue;
      var targets = null;
      if (node.hasAttribute && node.hasAttribute('data-dt-target')) {
        targets = [node];
      } else if (node.querySelectorAll) {
        targets = node.querySelectorAll('[data-dt-target]');
      }
      if (!targets || !targets.length) continue;

      for (var k = 0; k < targets.length; k += 1) {
        var target = targets[k];
        var parent = target.parentElement;
        if (!parent) continue;
        var siblings = parent.querySelectorAll(':scope > [data-dt-target]');
        if (siblings.length <= 1) continue;
        for (var s = 1; s < siblings.length; s += 1) siblings[s].remove();
      }
    }
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i += 1) {
        var record = records[i];
        var target = record.target;
        // 忽略我们自己造成的变更
        if (target && target.nodeType === 1 && target.closest && target.closest('[data-dt-ui]')) continue;
        if (record.type === 'childList' && record.addedNodes && record.addedNodes.length) {
          cleanupDuplicateTargets(record.addedNodes);
          scheduleIncremental();
          return;
        }
        if (record.type === 'characterData') {
          scheduleIncremental();
          return;
        }
      }
    });
    try {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
      });
    } catch (err) {
      DT.log('observer failed', err);
    }
  }

  function watchUrl() {
    if (urlTimer) return;
    urlTimer = setInterval(function () {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      if (!DT.state.enabled) return;
      // SPA 路由切换 / 打开弹层时 URL 会变。
      // 这里不再整页清空重翻（那样会闪一下），只把"源文本确实变了"的元素撤掉，
      // 剩下的保持原样，然后补扫一遍。
      var stale = DT.refreshStale();
      DT.log('url change, stale units:', stale);
      scheduleIncremental();
    }, 1000);
  }

  // 中途重建：先掐断在途请求，等它退出，再清空重来
  async function startOver() {
    DT.state.abort = true;
    var guard = 0;
    while (running && guard < 120) {
      await new Promise(function (resolve) {
        setTimeout(resolve, 100);
      });
      guard += 1;
    }
    DT.restore();
    DT.state.total = 0;
    DT.state.translated = 0;
    DT.state.failed = 0;
    DT.state.skipped = 0;
    DT.state.lastError = '';
    DT.state.abort = false;
    applyChrome();
    if (DT.state.enabled) translatePage({ reset: true, silent: true });
  }

  // 点击触发的补扫：Tab 切换、折叠面板、弹层往往只切 class/style，
  // 不产生 DOM 插入，MutationObserver 抓不到。点完 300ms 主动扫一次。
  function bindClickRescan() {
    document.addEventListener(
      'click',
      function (event) {
        if (!DT.state.enabled) return;
        var target = event.target;
        if (target && target.closest && target.closest('[data-dt-ui]')) return;
        setTimeout(function () {
          if (!DT.state.enabled) return;
          if (running) {
            dirty = true;
            return;
          }
          translatePage({ silent: true });
        }, 300);
      },
      true
    );
  }

  // 检测页面上是否已经有"别的翻译器"在工作。
  // 浏览器的自带翻译会先把内容换成中文，导致我们看到的源文本已是目标语言，
  // 于是整页被跳过 —— 这是"插件没反应"最常见的假象。
  function detectForeignTranslator() {
    var html = document.documentElement;
    var cls = String(html.className || '');
    var note = '';

    if (/(^|\s)translated-(ltr|rtl)/.test(cls) || document.getElementById('goog-gt-tt')) {
      note = '检测到「浏览器自带翻译」已生效。请先把它关掉（地址栏翻译图标 → 显示原文），再按 Alt+A。';
    } else if (
      html.getAttribute('imt-state') ||
      html.getAttribute('data-immersive-translate') ||
      document.querySelector('[data-immersive-translate-root-translation-theme]')
    ) {
      // 技术检测保留（对方会注入这些属性），但提示文案不点名产品
      note = '检测到其它翻译扩展已在本页生效，两个扩展会互相跳过。建议只保留一个。';
    }

    if (note) {
      DT.log('foreign translator detected');
      DT.toast(note, 7000);
    }
    return note;
  }

  // ---------------- 消息 ----------------
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return false;

    if (msg.type === 'dt:toggle') {
      toggle()
        .then(sendResponse)
        .catch(function (err) {
          sendResponse({ error: String(err) });
        });
      return true;
    }

    if (msg.type === 'dt:status') {
      sendResponse(summarize());
      return false;
    }

    if (msg.type === 'dt:setMode') {
      DT.state.mode = msg.mode === 'translation' ? 'translation' : 'dual';
      // 注入策略跟模式相关（双语=追加，仅译文=原地替换），必须重建
      startOver();
      sendResponse(summarize());
      return false;
    }

    if (msg.type === 'dt:setTarget') {
      DT.state.target = msg.target || DT.state.target;
      startOver();
      sendResponse(summarize());
      return false;
    }

    if (msg.type === 'dt:diagnose') {
      var report;
      try {
        report = DT.diagnose(150);
      } catch (err) {
        report = { error: String(err) };
      }
      // 同时留在页面全局，方便在 Console 里 copy(JSON.stringify(__DT_LAST_DIAG))
      try {
        window.__DT_LAST_DIAG = report;
      } catch (err) {
        /* 忽略 */
      }
      sendResponse(report);
      return false;
    }

    if (msg.type === 'dt:retranslate') {
      DT.state.enabled = true;
      startOver();
      sendResponse(summarize());
      return false;
    }

    return false;
  });

  // 看门狗：MV3 的 service worker 可能被回收，此时 sendMessage 的 Promise
  // 可能永远不 resolve，running 会卡死（面板一直显示"翻译中… 0 / ? 段"）。
  function startWatchdog() {
    setInterval(function () {
      if (!running || !runningSince) return;
      if (Date.now() - runningSince < 90000) return;
      DT.log('watchdog: 翻译卡住，强制复位');
      running = false;
      runningSince = 0;
      DT.state.abort = true;
      DT.toast('翻译超时，已复位。可以再点一次按钮重试。');
    }, 5000);
  }

  // 从 bfcache 返回（浏览器的前进/后退）：DOM 是旧的，状态可能已被冻结打断
  window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    running = false;
    runningSince = 0;
    if (DT.state.enabled) scheduleIncremental();
  });

  // ---------------- 启动 ----------------
  (async function boot() {
    await loadConfig();
    startObserver();
    bindHoverRescan();
    bindHotkey();
    bindClickRescan();
    watchUrl();
    startWatchdog();

    // 设置页保存后立刻生效（尤其是快捷键，不用刷新页面）
    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes || !changes.config) return;
        loadConfig();
      });
    } catch (err) {
      /* 忽略 */
    }

    // 同一个标签页里"刚才正在翻译"：刷新 / 返回后自动接着翻
    var resume = null;
    try {
      resume = await DT.send({ type: 'resume:get' }, 5000);
    } catch (err) {
      resume = null;
    }

    if (resume && resume.ok && resume.value) {
      DT.log('resume: 自动继续翻译');
      enable();
    } else if (DT.state.config && DT.state.config.translateOnLoad) {
      enable();
    }

    DT.log('content script ready', DT.VERSION);
  })();
})();
