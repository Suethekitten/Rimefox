// 输入框翻译（0.9.0）：光标在可编辑区域里时按快捷键 / 右键菜单，把这段文字翻成目标语言后原地写回。
//   - 有选区只翻选区，否则翻整个框
//   - 写入用 execCommand('insertText')：会进浏览器自己的撤销栈（Ctrl+Z 能回到原文），
//     同时触发原生 input 事件，React 等受控输入框能收到改动
//   - 输入框里多半是草稿 / 私信：请求带 noCache，后台不读也不写三层缓存
//   - 密码框、autocomplete="cc-*" 这类支付字段、输入法拼字中，一律不碰
// 目标语言：config.inputTargetLang（'auto' = 跟随页面 <html lang>，由后台 lib/config.js 解析）
(function () {
  'use strict';

  var DT = window.__DT;
  if (!DT) return;
  if (DT.__inputReady) return; // 允许被重复注入（popup 的 ensure 会再执行一次）
  DT.__inputReady = true;

  var MAX_CHARS = 4000;
  var running = false;
  var composing = false;

  // 输入法拼字中（中文 / 日文输入）：不能打断，也不能在按下快捷键时把候选框清掉
  document.addEventListener(
    'compositionstart',
    function () {
      composing = true;
    },
    true
  );
  document.addEventListener(
    'compositionend',
    function () {
      composing = false;
    },
    true
  );

  // 不该翻译的字段：密码、支付 / 账号类 autocomplete、只读 / 禁用
  function isBlockedField(el) {
    if (!el) return true;
    if (el.disabled || el.readOnly) return true;
    var tag = String(el.tagName || '').toUpperCase();
    if (tag !== 'INPUT') return false;
    var type = String(el.type || 'text').toLowerCase();
    if (type === 'password') return true;
    var ac = String(el.getAttribute('autocomplete') || '').toLowerCase();
    if (ac === 'current-password' || ac === 'new-password') return true;
    if (ac.indexOf('cc-') === 0) return true;
    return false;
  }

  // 当前能翻的元素：contenteditable、textarea、单行文本框（text / search）。
  // 宁可少翻：URL、邮箱、数字等字段里放翻译没有意义，还可能把表单搞坏
  function activeEditable() {
    var el = document.activeElement;
    if (!el) return null;
    if (el.isContentEditable) return el;
    var tag = String(el.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA') return el;
    if (tag === 'INPUT') {
      var type = String(el.type || 'text').toLowerCase();
      return /^(text|search)$/.test(type) ? el : null;
    }
    return null;
  }

  // 读要翻的文字：有选区读选区，否则整个框
  function readInput(el) {
    if (el.isContentEditable) {
      var sel = window.getSelection();
      var range = document.createRange();
      var text = String(el.innerText || el.textContent || '');
      var where = 'all';
      if (sel && !sel.isCollapsed && sel.rangeCount && el.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        range = sel.getRangeAt(0);
        text = String(sel.toString() || '');
        where = 'selection';
      } else {
        range.selectNodeContents(el);
      }
      // Range 本身会随 DOM 变化移动；保存原始端点，在确认内容未变后重新创建。
      return {
        text: text, where: where, rich: true, snapshot: el.innerHTML,
        startNode: range.startContainer, start: range.startOffset,
        endNode: range.endContainer, end: range.endOffset
      };
    }
    var value = String(el.value || '');
    var start = Number(el.selectionStart);
    var end = Number(el.selectionEnd);
    if (isFinite(start) && isFinite(end) && end > start) {
      return { text: value.slice(start, end), where: 'selection', snapshot: value, start: start, end: end };
    }
    return { text: value, where: 'all', snapshot: value, start: 0, end: value.length };
  }

  function canWriteBack(el, info) {
    if (!el.isConnected || composing || document.activeElement !== el || isBlockedField(el)) return false;
    if (info.rich) {
      return el.isContentEditable && el.innerHTML === info.snapshot &&
        el.contains(info.startNode) && el.contains(info.endNode);
    }
    return !el.isContentEditable && String(el.value || '') === info.snapshot;
  }

  function execInsert(text) {
    try {
      return document.execCommand('insertText', false, text);
    } catch (err) {
      return false;
    }
  }

  // 写回：走浏览器的原生编辑命令，可撤销、会发 input 事件
  function writeBack(el, info, text) {
    if (!canWriteBack(el, info)) return false;
    try {
      el.focus();
    } catch (err) {
      /* 拿不到焦点也继续试 */
    }
    // focus 事件也可能触发站点更新；写入前再确认一次。
    if (!canWriteBack(el, info)) return false;
    if (info.rich) {
      var sel = window.getSelection();
      if (!sel) return false;
      try {
        var range = document.createRange();
        range.setStart(info.startNode, info.start);
        range.setEnd(info.endNode, info.end);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (err) {
        return false;
      }
      return execInsert(text);
    }
    try {
      el.setSelectionRange(info.start, info.end);
    } catch (err) {
      return false;
    }
    return execInsert(text);
  }

  function pageLang() {
    try {
      return String((document.documentElement && document.documentElement.lang) || '');
    } catch (err) {
      return '';
    }
  }

  function say(zh, en, ms) {
    DT.toast(DT.uiText(zh, en), ms);
  }

  async function translateActive() {
    if (running) return false;
    if (composing) return false;
    var el = activeEditable();
    if (!el) {
      say('先把光标放进输入框，再按快捷键', 'Put the cursor in a text box first');
      return false;
    }
    if (isBlockedField(el)) {
      say('密码框和支付类字段不翻译', 'Password and payment fields are never translated');
      return false;
    }
    var info = readInput(el);
    var text = String(info.text || '').trim();
    if (!text) {
      say('输入框是空的', 'The text box is empty');
      return false;
    }
    if (text.length > MAX_CHARS) {
      say('这段太长了（最多 ' + MAX_CHARS + ' 字），先拆开再翻', 'Too long (max ' + MAX_CHARS + ' characters)');
      return false;
    }

    var cfg = DT.state.config || {};
    var pref = String(cfg.inputTargetLang || 'auto');
    running = true;
    say('翻译输入框中…', 'Translating the text box…', 1600);
    try {
      var res = await DT.send(
        {
          type: 'translate',
          texts: [text],
          target: pref === 'auto' ? 'auto' : pref,
          pageLang: pageLang(),
          noCache: true
        },
        120000
      );
      if (!res || !res.ok) throw new Error((res && res.error) || '翻译失败');
      var value = res.results && res.results[0];
      if (typeof value !== 'string' || !value.trim()) {
        say('没有拿到可用的译文，原文没动', 'No usable translation; text left unchanged');
        return false;
      }
      var out = value.trim();
      if (out === text) {
        say('译文和原文一样，没有改动', 'Same as the original; nothing changed');
        return false;
      }
      if (!canWriteBack(el, info)) {
        say('输入框内容或焦点已变化，已取消写回，请重新翻译', 'Text or focus changed; translation was not inserted. Please translate again', 3200);
        return false;
      }
      if (!writeBack(el, info, out)) {
        say('写回失败，原文没动', 'Could not write back; text left unchanged');
        return false;
      }
      say('已翻译输入框（Ctrl+Z 撤销）', 'Text box translated (Ctrl+Z to undo)', 2600);
      return true;
    } catch (err) {
      say(
        '输入框翻译失败：' + ((err && err.message) || err),
        'Text box translation failed: ' + ((err && err.message) || err),
        3200
      );
      return false;
    } finally {
      running = false;
    }
  }

  DT.inputTranslate = function () {
    return translateActive();
  };

  // 右键菜单「凛狐：翻译输入框内容」：由后台发到点中的那个框架
  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.type !== 'dt:translateInput') return false;
    translateActive();
    return false;
  });

  DT.log('input translate ready');
})();
