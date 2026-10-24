// 双向文字排版：目标语言方向 + 原始 DOM 实际方向。
// 这是纯内容脚本模块，不请求 API、不改翻译流程；只给 DOM 渲染提供 dir / alignment 元数据。
(function () {
  'use strict';

  var DT = window.__DT;
  if (!DT || DT.direction) return;

  var RTL_LANGS = {
    ar: 1, arc: 1, he: 1, fa: 1, ur: 1, ps: 1, ckb: 1, ug: 1, sd: 1,
    yi: 1, dv: 1, syr: 1, nqo: 1, sam: 1, aeb: 1, arz: 1, apc: 1, apd: 1,
    acm: 1, ary: 1, ars: 1, mzn: 1, glk: 1, lrc: 1, prs: 1, khw: 1, bal: 1,
    brh: 1, hnd: 1, ks: 1
  };
  var RTL_SCRIPTS = {
    arab: 1, aran: 1, hebr: 1, syrc: 1, thaa: 1, nkoo: 1, adlm: 1,
    mand: 1, samr: 1, yezi: 1, rohg: 1, phnx: 1, cprt: 1, ugar: 1, avst: 1,
    orkh: 1, phli: 1, prti: 1, sarb: 1, nbat: 1, palm: 1, hatr: 1
  };
  var LTR_SCRIPTS = {
    latn: 1, cyrl: 1, grek: 1, hans: 1, hant: 1, jpan: 1, kore: 1, hang: 1,
    deva: 1, beng: 1, thai: 1, laoo: 1, khmr: 1, mymr: 1, tibt: 1,
    armn: 1, geor: 1, ethi: 1, taml: 1, telu: 1, knda: 1, mlym: 1,
    gujr: 1, guru: 1, orya: 1, sinh: 1, java: 1, bali: 1
  };
  var RTL_TEXT = /[\u0590-\u05ff\u0600-\u06ff\u0700-\u074f\u0750-\u077f\u0780-\u07bf\u07c0-\u07ff\u0800-\u083f\u0840-\u085f\u0860-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;
  var LTR_TEXT = /[A-Za-z\u00c0-\u02af\u0370-\u03ff\u0400-\u04ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

  function parts(lang) {
    return String(lang || '').replace(/_/g, '-').split('-').filter(Boolean);
  }

  function scriptOf(list) {
    for (var i = 1; i < list.length; i += 1) {
      if (/^[A-Za-z]{4}$/.test(list[i])) return list[i].toLowerCase();
    }
    return '';
  }

  // 目标语言 -> 排版方向。script 子标签优先于基础语言：
  // ug-Arab / ku-Arab -> RTL，ug-Cyrl / ku-Latn -> LTR；pa-Arab -> RTL，pa-Guru -> LTR。
  function dirForLang(lang) {
    var p = parts(lang);
    var base = (p[0] || '').toLowerCase();
    var script = scriptOf(p);
    if (script) {
      if (RTL_SCRIPTS[script]) return 'rtl';
      if (LTR_SCRIPTS[script]) return 'ltr';
    }
    if (RTL_LANGS[base]) return 'rtl';
    return 'ltr';
  }

  function explicitDir(el) {
    var node = el && el.closest ? el.closest('[dir]') : null;
    if (!node) return '';
    var value = String(node.getAttribute('dir') || '').toLowerCase();
    return value === 'rtl' || value === 'ltr' ? value : '';
  }

  function textHint(text) {
    var s = String(text || '');
    if (!s) return '';
    var rtl = 0;
    var ltr = 0;
    for (var i = 0; i < s.length; i += 1) {
      var ch = s.charAt(i);
      if (RTL_TEXT.test(ch)) rtl += 1;
      else if (LTR_TEXT.test(ch)) ltr += 1;
    }
    if (!rtl && !ltr) return '';
    return rtl > ltr ? 'rtl' : 'ltr';
  }

  // 原始方向：最近的显式 dir 优先，其次 computed style，再退回文档语言 / 文字特征。
  // 明确写出的 LTR 不会被一段阿拉伯语引用反转；computed 为默认值时才看文字特征。
  function sourceDir(el, text) {
    if (!el) return 'ltr';
    var explicit = explicitDir(el);
    if (explicit) return explicit;
    var cs = null;
    try {
      cs = window.getComputedStyle(el);
    } catch (err) {
      cs = null;
    }
    if (cs && cs.direction === 'rtl') return 'rtl';
    if (cs && cs.direction === 'ltr') {
      // computed 的默认 ltr 在阿拉伯语正文上常见：只有显式 dir 缺失时，用文字特征纠正
      // 明显以 RTL 为主的正文。混合引用 / 短拉丁词不会把段落翻成 RTL。
      var hint = textHint(text || el.textContent || '');
      if (hint === 'rtl') return 'rtl';
      return 'ltr';
    }
    var doc = document.documentElement;
    var docDir = doc && (doc.getAttribute('dir') || '');
    if (docDir === 'rtl' || docDir === 'ltr') return docDir;
    var docLang = document.documentElement && document.documentElement.lang;
    if (docLang && dirForLang(docLang) === 'rtl') return 'rtl';
    return textHint(text || '') || 'ltr';
  }

  function alignmentOf(el) {
    var align = '';
    try {
      align = (window.getComputedStyle(el).textAlign || '').toLowerCase();
    } catch (err) {
      align = '';
    }
    if (align === 'center' || align === '-webkit-center' || align === 'justify' || align === 'justify-all') return align;
    return 'start';
  }

  function targetMeta(unit) {
    var rawLang = (DT.state && (DT.state.targetCode || DT.state.target)) || (unit && unit.targetLang) || 'en';
    // lang 只返回可验证的 BCP 47 code；没有 code 的自定义语言返回空字符串，
    // 方向仍按内部 id 安全降级为 LTR，但绝不把 cl_… 写进 lang 属性。
    var lang = DT.langCode ? DT.langCode(rawLang) : rawLang;
    var target = dirForLang(lang || rawLang);
    var source = sourceDir(unit && unit.el, unit && unit.text);
    return {
      lang: lang,
      target: target,
      source: source,
      mismatch: source !== target,
      align: alignmentOf(unit && unit.el)
    };
  }

  // 给新译文节点设置独立方向。用 isolate 而不是 bidi-override，保留 Unicode BiDi 算法。
  function applyTargetNode(node, sourceEl, lang, inline) {
    if (!node) return null;
    var targetLang = lang || (DT.state && (DT.state.targetCode || DT.state.target)) || 'en';
    // 自定义语言的内部 id 不是 BCP 47：只把有效的 code 写进 lang；没有 code 时不伪造标签。
    var code = DT.langCode ? DT.langCode(targetLang) : targetLang;
    var target = dirForLang(code || targetLang);
    var source = sourceDir(sourceEl);
    node.setAttribute('dir', target);
    node.setAttribute('data-dt-dir', target);
    if (code) node.setAttribute('lang', code);
    try {
      node.style.setProperty('direction', target, 'important');
      node.style.setProperty('unicode-bidi', 'isolate', 'important');
      if (!inline) {
        var align = alignmentOf(sourceEl);
        node.style.setProperty('text-align', align, 'important');
      }
    } catch (err) {
      /* style API 不可用时保留 dir 属性 */
    }
    return { target: target, source: source, mismatch: target !== source, align: alignmentOf(sourceEl) };
  }

  DT.direction = {
    dirForLang: dirForLang,
    sourceDir: sourceDir,
    alignmentOf: alignmentOf,
    targetMeta: targetMeta,
    applyTargetNode: applyTargetNode,
    textHint: textHint
  };
})();
