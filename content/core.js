// 内容脚本：公共层（命名空间 / 工具 / 提示条）
(function () {
  'use strict';

  var DT = (window.__DT = window.__DT || {});
  DT.VERSION = '0.8.1';

  DT.state = {
    enabled: false,
    mode: 'dual',
    theme: 'underline',
    target: 'zh-CN',
    style: 'plain', // 趣味翻译：只对当前页生效（弹窗选），还原后回到 plain
    config: null,
    total: 0,
    translated: 0,
    failed: 0
  };

  // 趣味翻译风格的 id（文案与提示词在 lib/config.js 的 STYLES，内容脚本只认 id）
  DT.STYLE_IDS = ['plain', 'classical', 'catgirl'];
  DT.STYLE_MIN_CHARS = 12;

  // 这个单元按什么风格翻：只改写正文里够长的段落；导航、按钮、短标签照常普通翻译，
  // 免得菜单也变成文言文 / 带「喵」。area 是 DT.areaOf 的结果
  DT.unitStyle = function (style, text, area) {
    if (!style || style === 'plain' || DT.STYLE_IDS.indexOf(style) < 0) return 'plain';
    if (String(text || '').length < DT.STYLE_MIN_CHARS) return 'plain';
    if (area && area !== 'content') return 'plain';
    return style;
  };

  // 配置变了（启动、设置页保存、换了网址）时通知各模块：外观、站点规则、悬浮入口各自订阅
  var configHooks = [];
  DT.onConfig = function (fn) {
    configHooks.push(fn);
    if (DT.state.config) {
      try {
        fn(DT.state.config);
      } catch (err) {
        DT.log('config hook failed', err);
      }
    }
  };
  DT.emitConfig = function (cfg) {
    configHooks.forEach(function (fn) {
      try {
        fn(cfg);
      } catch (err) {
        DT.log('config hook failed', err);
      }
    });
  };

  // 线条小图标（悬浮入口、气泡上的按钮）：只用 createElementNS 拼，不写 innerHTML
  var SVG_NS = 'http://www.w3.org/2000/svg';
  DT.icon = function (d, size) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size || 18));
    svg.setAttribute('height', String(size || 18));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.style.display = 'block';
    var path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  };

  // 我们自己加到网页上的界面（悬浮入口、置顶小窗）跟着「界面语言」走；正文提示仍是中文
  DT.uiText = function (zh, en) {
    return DT.state.config && DT.state.config.uiLang === 'en' ? en : zh;
  };

  DT.log = function () {
    if (DT.state.config && DT.state.config.debug) {
      var args = Array.prototype.slice.call(arguments);
      console.log.apply(console, ['[凛狐]'].concat(args));
    }
  };

  // 与后台通信。
  // 必须自带超时：MV3 的 service worker 可能被回收，此时 sendMessage 的
  // 回调永远不会触发，Promise 会挂死（表现为"一直翻译中、0 段"）。
  // 扩展被重新加载 / 更新后，旧页面里的内容脚本会"失去宿主"：
  // chrome.runtime.id 变成 undefined，任何调用都会抛 "Extension context invalidated"。
  // 这种情况只能刷新页面，所以给一句人能看懂的话，而不是把原始错误弹给用户。
  var CONTEXT_LOST = '扩展已重新加载，请刷新页面（F5）后再试';

  function friendlyError(message) {
    var text = String(message || '');
    if (/Extension context invalidated|message port closed|receiving end does not exist/i.test(text)) {
      return CONTEXT_LOST;
    }
    return text;
  }

  DT.send = function (msg, timeoutMs) {
    var limit = timeoutMs || 90000;
    return new Promise(function (resolve, reject) {
      // 上下文已失效时直接给出结论，不再白跑一次调用
      try {
        if (!chrome || !chrome.runtime || !chrome.runtime.id) {
          reject(new Error(CONTEXT_LOST));
          return;
        }
      } catch (err) {
        reject(new Error(CONTEXT_LOST));
        return;
      }

      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('与后台通信超时（' + Math.round(limit / 1000) + 's）'));
      }, limit);

      function finish(fn, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      }

      try {
        chrome.runtime.sendMessage(msg, function (res) {
          var err = chrome.runtime.lastError;
          if (err) finish(reject, new Error(friendlyError(err.message)));
          else finish(resolve, res);
        });
      } catch (e) {
        finish(reject, new Error(friendlyError(e && e.message ? e.message : String(e))));
      }
    });
  };

  // 快捷键显示名："alt+a" → Mac 上 "Option + A"，其它系统 "Alt + A"。
  // 与 lib/config.js 的 hotkeyLabel 同一套逻辑（内容脚本不能 import）
  var IS_MAC = /mac/i.test(
    (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || ''
  );
  DT.hotkeyLabel = function (spec) {
    var names = IS_MAC ? { alt: 'Option', ctrl: 'Control', shift: 'Shift' } : { alt: 'Alt', ctrl: 'Ctrl', shift: 'Shift' };
    return String(spec || 'alt+a')
      .split('+')
      .filter(Boolean)
      .map(function (part) {
        var p = part.trim().toLowerCase();
        if (names[p]) return names[p];
        if (p.length === 1) return p.toUpperCase();
        return p.charAt(0).toUpperCase() + p.slice(1);
      })
      .join(' + ');
  };

  // 折叠空白
  DT.normalizeText = function (text) {
    return String(text == null ? '' : text)
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t\r\n\f\v]+/g, ' ')
      .trim();
  };

  // 译文排版归一化：只对 CJK 做，不按网站写死字号。
  // 中文 / 日文 / 韩文的字面比拉丁字母更"满"（汉字占满 em 方框），
  // 原站给英文大标题的 72px/1.0 行高直接套到中文上会显得过大且换行重叠。
  // 这里只做大标题的相对缩放（0.8em）和行高下限（1.25），字号仍随原站响应式变化。
  var CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;
  var CJK_HEADING_MIN_PX = 36;
  DT.hasCjk = function (text) {
    return CJK_RE.test(String(text == null ? '' : text));
  };
  DT.translationLayout = function (text, fontPx, linePx, isHeading, inline) {
    var font = Number(fontPx) || 0;
    var line = Number(linePx) || 0;
    var cjk = DT.hasCjk(text);
    if (!cjk || inline) return { tight: false, heading: false };
    // 只处理明确写死的紧行高；line-height: normal（计算值为 "normal"）保持浏览器默认
    var tight = font > 0 && line > 0 && line / font < 1.25;
    var heading = !!isHeading && font >= CJK_HEADING_MIN_PX;
    return { tight: tight, heading: heading };
  };

  // 纯符号 / 纯数字 / 太短 —— 不值得翻译
  DT.skipText = function (text) {
    if (!text || text.length < 2) return true;
    if (!/[\p{L}]/u.test(text)) return true;
    if (/^[\p{P}\p{S}\d\s]+$/u.test(text)) return true;
    return false;
  };

  // 这段文本是否已经基本是目标语言（避免中→中、英→英）
  // 注意：不能只看 CJK 占比。中英混排的段落（作者原文就混写）如果被判成
  // "已是中文"，整段就不会翻，表现为"有些段落没翻译"。
  // 规则：要同时满足「CJK 占绝对多数」且「拉丁字母很少」才算已达标；
  // 另外必须排除假名 / 谚文 —— 日文常混大量汉字（「進捗状況」「無料」），
  // 只看汉字比例会把日文判成中文，然后被"跳过已是目标语言"漏掉。
  DT.looksLikeTarget = function (text, lang) {
    if (!text) return false;
    var letters = (text.match(/\p{L}/gu) || []).length;
    if (letters < 4) return false;

    var code = String(lang || '');
    var cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
    var kana = (text.match(/[\u3040-\u30ff]/g) || []).length;
    var hangul = (text.match(/[\uac00-\ud7af\u1100-\u11ff]/g) || []).length;
    var latin = (text.match(/[A-Za-z]/g) || []).length;

    if (code.indexOf('zh') === 0) {
      if (kana > 0 || hangul > 0) return false; // 有假名/谚文就不是中文
      if (cjk / letters <= 0.75) return false;
      if (latin / letters > 0.15) return false;
      return true;
    }
    if (code.indexOf('ja') === 0) {
      if (kana === 0) return false; // 没有假名的不当日语（否则中文会被判成"已是日语"）
      if ((kana + cjk) / letters <= 0.6) return false;
      if (latin / letters > 0.2) return false;
      return true;
    }
    if (code.indexOf('ko') === 0) {
      if (hangul === 0) return false; // 没有谚文的不当韩语
      if (hangul / letters <= 0.6) return false;
      if (latin / letters > 0.2) return false;
      return true;
    }
    if (code.indexOf('en') === 0) {
      return latin / letters > 0.9;
    }
    return false;
  };

  // ---------------- 近似重复闸门 ----------------
  // 这段文字是不是「主要已经是目标语言」：比 looksLikeTarget 宽松（中英混排也算），只给近似重复闸门用。
  // 收集阶段不能用它 —— 中英混排的段落会被当成已是中文整段不翻（HANDOFF 记过的坑）。
  // 中文目标同样排除假名 / 谚文：日文原文和中文译文共用大量汉字，相似度会虚高
  DT.isMostlyTargetLanguage = function (text, lang) {
    var s = String(text || '');
    var letters = (s.match(/\p{L}/gu) || []).length;
    if (letters < 4) return false;
    var han = (s.match(/[\u3400-\u9fff]/g) || []).length;
    var kana = (s.match(/[\u3040-\u30ff]/g) || []).length;
    var hangul = (s.match(/[\uac00-\ud7af\u1100-\u11ff]/g) || []).length;
    var code = String(lang || '');
    if (code.indexOf('zh') === 0) return kana === 0 && hangul === 0 && han / letters >= 0.4;
    if (code.indexOf('ja') === 0) return kana > 0 && (kana + han) / letters >= 0.4;
    if (code.indexOf('ko') === 0) return hangul / letters >= 0.4;
    return false;
  };

  // 两段文字有多像：字符多重集的 Dice 系数，O(n)。超过 300 字或长度差超过 40% 直接判不像
  DT.similarity = function (a, b) {
    a = DT.normalizeText(a);
    b = DT.normalizeText(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    var longer = Math.max(a.length, b.length);
    if (longer > 300) return 0;
    if (Math.abs(a.length - b.length) / longer > 0.4) return 0;
    var bag = new Map();
    var hit = 0;
    var i;
    var c;
    for (i = 0; i < a.length; i += 1) bag.set(a[i], (bag.get(a[i]) || 0) + 1);
    for (i = 0; i < b.length; i += 1) {
      c = bag.get(b[i]);
      if (c) {
        bag.set(b[i], c - 1);
        hit += 1;
      }
    }
    return (2 * hit) / (a.length + b.length);
  };

  // 译文是不是原文的「近似重复」：完全相同；或者原文本来就主要是目标语言，模型只改写了几个词
  // （GitHub 提交列表里 "feat: 界面美化" 被改成 "新功能: 界面美化"）—— 插进去就是一行几乎一样的字。
  // 原文不是目标语言时只认完全相同：Settings → 设置（Settings）这类合法译文和原文很像，不能误杀
  DT.NEAR_DUP_THRESHOLD = 0.75;
  DT.isNearDuplicate = function (source, output, lang) {
    var a = DT.normalizeText(source);
    var b = DT.normalizeText(output);
    if (a === b) return true;
    return DT.isMostlyTargetLanguage(a, lang) && DT.similarity(a, b) >= DT.NEAR_DUP_THRESHOLD;
  };

  // 长段落按句切开，避免单条请求过大
  DT.splitLong = function (text, max) {
    var limit = Math.max(200, Number(max) || 1200);
    if (text.length <= limit) return [text];

    var marked = text.replace(/([.!?。！？；;:：])\s*/g, '$1\u0001');
    var parts = marked.split('\u0001');

    var out = [];
    var buf = '';
    parts.forEach(function (part) {
      if (!part) return;
      if (buf && buf.length + part.length > limit) {
        out.push(buf);
        buf = part;
      } else {
        buf = buf ? buf + ' ' + part : part;
      }
    });
    if (buf) out.push(buf);

    var safe = [];
    out.forEach(function (chunk) {
      var s = chunk;
      while (s.length > limit * 1.6) {
        safe.push(s.slice(0, Math.floor(limit * 1.6)));
        s = s.slice(Math.floor(limit * 1.6));
      }
      if (s) safe.push(s);
    });

    return safe.length ? safe : [text.slice(0, limit)];
  };

  // ---------------- 调度用的纯函数 ----------------
  // 这些函数不读 window、不调 getBoundingClientRect：矩形由调用方传进来。
  // 这样自检页能直接给假矩形做断言，main.js 里只剩流程编排。

  // 懒翻译范围：屏幕上方 1 屏到下方 2 屏
  DT.LAZY_ABOVE = 1;
  DT.LAZY_BELOW = 2;

  // 元素是否在"该翻"的可视区范围内（rect 为元素相对视口的矩形）
  DT.nearView = function (rect, viewH) {
    if (!rect) return false;
    var h = Number(viewH) || 800;
    return rect.bottom >= -h * DT.LAZY_ABOVE && rect.top <= h * (1 + DT.LAZY_BELOW);
  };

  // 离当前屏幕多远：屏幕内 0；上方按 2 倍权重；下方按距离；不在布局里给一个极大值
  DT.distanceOf = function (rect, viewH) {
    if (!rect || (!rect.width && !rect.height)) return 1e9;
    var h = Number(viewH) || 800;
    if (rect.bottom < 0) return -rect.bottom * 2;
    if (rect.top > h) return rect.top - h;
    return 0;
  };

  // 取批上限：屏幕内的批次要小（非流式要等整批生成完），下一屏以内中等，其余用满
  DT.BATCH_NEAR_ITEMS = 3;
  DT.BATCH_NEAR_CHARS = 500;
  DT.BATCH_SOON_CHARS = 1000;

  DT.batchLimits = function (prio, viewH, maxItems, maxChars) {
    var h = Number(viewH) || 800;
    var items = Number(maxItems) || 8;
    var chars = Number(maxChars) || 2000;
    var near = prio === 0;
    var soon = prio <= h;
    return {
      items: near ? Math.min(items, DT.BATCH_NEAR_ITEMS) : items,
      chars: near ? Math.min(chars, DT.BATCH_NEAR_CHARS) : soon ? Math.min(chars, DT.BATCH_SOON_CHARS) : chars
    };
  };

  // 失败退避表：同一段文本连续失败依次等 5s / 15s / 45s，第 4 次返回 0 表示放弃
  DT.RETRY_DELAYS = [5000, 15000, 45000];

  DT.nextRetry = function (prev, text, now) {
    var count = prev && prev.text === text ? prev.count + 1 : 1;
    var delay = DT.RETRY_DELAYS[count - 1] || 0;
    return { count: count, delay: delay, until: (Number(now) || Date.now()) + delay };
  };

  // 长段落被切成多段后拼回去：丢掉空段，用空格连接
  DT.joinSlots = function (slots) {
    return (slots || [])
      .filter(function (part) {
        return part;
      })
      .join(' ')
      .trim();
  };

  // 是否正在可编辑控件里（输入框 / 文本域 / 下拉 / contenteditable）。
  // 浏览器快捷键是浏览器层触发的，页面内守卫拦不住，内容脚本这里再判一次。
  DT.isEditableTarget = function (el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  };

  // 物理键位上的字母 / 数字（"KeyA" → "a"）
  DT.keyFromCode = function (code) {
    var m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(String(code || ''));
    return m ? (m[1] || m[2]).toLowerCase() : '';
  };

  // 解析 "alt+a" / "alt+shift+a" / "ctrl+shift+a" 这类配置。
  // event 只用到 altKey / ctrlKey / shiftKey / metaKey / key / code 这几个字段
  DT.matchesHotkey = function (event, spec) {
    if (!event) return false;
    var parts = String(spec || 'alt+a').toLowerCase().split('+');
    var key = parts.pop();
    if (!key) return false;
    var wantAlt = parts.indexOf('alt') >= 0;
    var wantCtrl = parts.indexOf('ctrl') >= 0;
    var wantShift = parts.indexOf('shift') >= 0;
    if (wantAlt !== !!event.altKey) return false;
    if (wantCtrl !== !!event.ctrlKey) return false;
    if (wantShift !== !!event.shiftKey) return false;
    if (event.metaKey) return false;
    var pressed = String(event.key || '').toLowerCase();
    if (pressed === key) return true;
    // macOS 上 Option+A 的 event.key 是 "å"（Option+E 是 "Dead"），俄语布局下是 "ф"：
    // 按出来的不是 ASCII 字母数字时，退回看物理键位
    return !/^[a-z0-9]$/.test(pressed) && DT.keyFromCode(event.code) === key;
  };

  // 轻量提示条（不依赖页面样式）
  DT.toast = function (message, ms) {
    try {
      var host = document.getElementById('dt-toast-root');
      if (!host) {
        host = document.createElement('div');
        host.id = 'dt-toast-root';
        host.setAttribute('data-dt-ui', '1');
        host.style.cssText =
          'position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:2147483647;' +
          'display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;';
        (document.body || document.documentElement).appendChild(host);
      }
      var el = document.createElement('div');
      el.textContent = message;
      el.style.cssText =
        'max-width:72vw;padding:9px 14px;border-radius:10px;background:rgba(22,24,30,.93);color:#fff;' +
        'font:13px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.24);opacity:0;transition:opacity .18s ease;';
      host.appendChild(el);
      requestAnimationFrame(function () {
        el.style.opacity = '1';
      });
      setTimeout(function () {
        el.style.opacity = '0';
        setTimeout(function () {
          el.remove();
        }, 240);
      }, ms || 2200);
    } catch (err) {
      /* 忽略 */
    }
  };
})();
