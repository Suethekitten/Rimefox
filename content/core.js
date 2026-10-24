// 内容脚本：公共层（命名空间 / 工具 / 提示条）
(function () {
  'use strict';

  var DT = (window.__DT = window.__DT || {});
  DT.VERSION = '0.12.0';
  // 允许重复注入：页面还没加载完就打开弹窗 / 按快捷键时，后台补注入（ensureInjected）的这批脚本
  // 会和 manifest 声明的那批各跑一次。只初始化一次：再跑会清空 DT.state 和 onConfig 的订阅，
  // 而 main.js、appearance.js、dock.js 这些已经启动过的模块不会重新订阅，站点规则 / 外观就再也不生效
  if (DT.__coreReady) return;
  DT.__coreReady = true;

  DT.state = {
    enabled: false,
    mode: 'dual',
    theme: 'underline',
    target: 'zh-CN', // 当前页面译文实际使用的目标语言
    configTarget: null, // 配置里待生效的目标语言（删除在用语言回退时可能与 target 不同）
    targetPending: false, // 配置目标已变，但页面仍有旧目标译文，等用户明确重译
    langInfo: null, // 当前页面实际使用语言的元数据（内部 id 与 BCP 47 code 分开）
    configLangInfo: null, // 配置里待生效语言的元数据
    contextStale: false, // AI 精翻上下文已更新，但现有译文仍用旧上下文；重译后清掉
    style: 'plain', // 当前实际生效的趣味风格（只对当前页生效）
    selectedStyle: 'plain', // 用户在弹窗里选中、尚未应用的风格
    intensity: 'standard', // 当前页面实际生效的趣味强度
    contextStatus: null, // AI 精翻只记录模式 / 条数，不记录上下文正文
    config: null,
    total: 0,
    translated: 0,
    failed: 0
  };

  // 趣味翻译风格的 id（文案与提示词在 lib/config.js 的 STYLES，内容脚本只认 id）
  DT.STYLE_IDS = ['plain', 'classical', 'catgirl'];
  DT.STYLE_MIN_CHARS = 12;
  // 风格强度 id（提示词在 lib/config.js 的 FUN_INTENSITIES；内容脚本只认 id）
  DT.INTENSITY_IDS = ['light', 'standard', 'exaggerated'];
  DT.normalizeIntensity = function (id) {
    var value = String(id == null ? '' : id).trim();
    return DT.INTENSITY_IDS.indexOf(value) >= 0 ? value : 'standard';
  };

  // 自定义目标语言的配置值（cl_…）不是 BCP 47：方向 / 字体 / lang 属性只拿后台下发的 code。
  DT.langCode = function (lang) {
    var value = String(lang == null ? '' : lang);
    var info = DT.state && DT.state.langInfo;
    if (info && info.value === DT.state.target && (!value || value === DT.state.target)) return String(info.code || '');
    return value;
  };

  // 当前目标语言的元数据：只有 value 与当前 target 对得上才算数，避免弹窗 setTarget
  // 与配置广播之间的窗口把旧语言的 code 用到新一轮。
  DT.targetInfo = function () {
    var info = DT.state && DT.state.langInfo;
    return info && info.value === DT.state.target ? info : null;
  };

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

  // 折叠空白，但保留有阅读意义的换行（<br>、white-space: pre-* 里的 \n，由 dom.js 换成 \n 传进来）：
  // 每行内部照 normalizeText 折叠；首尾空行去掉；连续空行只留一个（段落间隔）。
  // 没有换行的文本结果与 normalizeText 完全相同（缓存键、已有站点不受影响）
  DT.normalizeLines = function (text) {
    var out = [];
    var gap = false;
    String(text == null ? '' : text)
      .split(/\r\n?|\n/)
      .forEach(function (line) {
        var t = DT.normalizeText(line);
        if (!t) {
          gap = out.length > 0;
          return;
        }
        if (gap) out.push('');
        out.push(t);
        gap = false;
      });
    return out.join('\n');
  };

  // 文本里的非空行（每行已折叠空白）
  DT.splitLines = function (text) {
    return String(text == null ? '' : text)
      .split(/\r\n?|\n/)
      .map(DT.normalizeText)
      .filter(Boolean);
  };

  // 这种 white-space 下文本里的 \n 是不是真换行（pre / pre-wrap / pre-line / break-spaces）。
  // 参数是 getComputedStyle 的 whiteSpace 与 whiteSpaceCollapse（新写法的长属性）
  DT.keepsLineBreaks = function (whiteSpace, collapse) {
    if (/^(pre|pre-wrap|pre-line|break-spaces)$/.test(String(whiteSpace || ''))) return true;
    return /^(preserve|preserve-breaks|break-spaces)$/.test(String(collapse || ''));
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

  // ---------------- 简体 / 繁体 ----------------
  // 只收两边写法不同的常用字（这 / 這、们 / 們……），一一对应排列；两边写法相同的字（中、文、人）不算
  var HANS_CHARS =
    '这们个为说时对来会过还没发现样从点问间经两进动开关门见车东题实学书话语读写觉买卖钱电乐听业认识让万与专种义习乡乱争产亲众优传伤体儿党兴军农决况净减几击刘则刚创删别剧办务劳势医华协单卫厂历压县参双变号吗员响团园围国图圆场块坏处备复够头夺奖妇妈孙宁宝审宫宽寻导寿将尔尽层岁岛币师带帮广庆应库废张弹强归当录忆忧怀态总恶惊惯愿战户扩扫扬护报担择挂挥损换据摄敌数断无旧显术机杀杂权条极枪标树桥梦检楼欢残毕气汉沟泪洁测济浓涛温湾满灭灯灵灾炼烟热爱独猎环画盐监盖盘矿码确礼离积称税稳穷笔简类粮紧红纪约级纯纸线练组细织终结绝统继续维绿编网罗职联胜脑脚脸艺节药获营虑虽补装观规视览计讨训议讯记讲许论设访证评词译试诗询该详误请课谁调谈谢负财责败货质购贵费资赛赞赢转轮软轻载较辆输边达运远违连迟适选遗邮释错键镇长闪闭闻阅队阳阴阵阶际陆陈险随隐难雾静页顶项顺须顾预领频颜额风飞饭饮馆马验骑鱼鸟鸡麦黄齐龙';
  var HANT_CHARS =
    '這們個為說時對來會過還沒發現樣從點問間經兩進動開關門見車東題實學書話語讀寫覺買賣錢電樂聽業認識讓萬與專種義習鄉亂爭產親眾優傳傷體兒黨興軍農決況淨減幾擊劉則剛創刪別劇辦務勞勢醫華協單衛廠歷壓縣參雙變號嗎員響團園圍國圖圓場塊壞處備復夠頭奪獎婦媽孫寧寶審宮寬尋導壽將爾盡層歲島幣師帶幫廣慶應庫廢張彈強歸當錄憶憂懷態總惡驚慣願戰戶擴掃揚護報擔擇掛揮損換據攝敵數斷無舊顯術機殺雜權條極槍標樹橋夢檢樓歡殘畢氣漢溝淚潔測濟濃濤溫灣滿滅燈靈災煉煙熱愛獨獵環畫鹽監蓋盤礦碼確禮離積稱稅穩窮筆簡類糧緊紅紀約級純紙線練組細織終結絕統繼續維綠編網羅職聯勝腦腳臉藝節藥獲營慮雖補裝觀規視覽計討訓議訊記講許論設訪證評詞譯試詩詢該詳誤請課誰調談謝負財責敗貨質購貴費資賽贊贏轉輪軟輕載較輛輸邊達運遠違連遲適選遺郵釋錯鍵鎮長閃閉聞閱隊陽陰陣階際陸陳險隨隱難霧靜頁頂項順須顧預領頻顏額風飛飯飲館馬驗騎魚鳥雞麥黃齊龍';
  var SCRIPT_OF = {};
  (function () {
    var i;
    for (i = 0; i < HANS_CHARS.length; i += 1) SCRIPT_OF[HANS_CHARS.charAt(i)] = 'hans';
    for (i = 0; i < HANT_CHARS.length; i += 1) SCRIPT_OF[HANT_CHARS.charAt(i)] = 'hant';
  })();

  // 'hans' 简体 / 'hant' 繁体 / '' 看不出来（只有两边写法相同的字，比如「中文」，这时两边都算对）
  DT.chineseScript = function (text) {
    var s = String(text || '');
    var hans = 0;
    var hant = 0;
    for (var i = 0; i < s.length; i += 1) {
      var w = SCRIPT_OF[s.charAt(i)];
      if (w === 'hans') hans += 1;
      else if (w === 'hant') hant += 1;
    }
    if (hans > hant) return 'hans';
    if (hant > hans) return 'hant';
    return '';
  };

  // 目标语言要哪种写法：zh-TW / zh-HK / zh-Hant 是繁体，其余中文按简体
  function targetScript(lang) {
    return /^zh-(tw|hk|mo|hant)/i.test(String(lang || '')) ? 'hant' : 'hans';
  }

  // 写法和目标对不上（简体页面翻成繁體中文、或反过来）：不算「已是目标语言」，要送去转换
  function wrongScript(text, lang) {
    var script = DT.chineseScript(text);
    return !!script && script !== targetScript(lang);
  }

  // 这段文本是否已经基本是目标语言（避免中→中、英→英）
  // 注意：不能只看 CJK 占比。中英混排的段落（作者原文就混写）如果被判成
  // "已是中文"，整段就不会翻，表现为"有些段落没翻译"。
  // 规则：要同时满足「CJK 占绝对多数」且「拉丁字母很少」才算已达标；
  // 另外必须排除假名 / 谚文 —— 日文常混大量汉字（「進捗状況」「無料」），
  // 只看汉字比例会把日文判成中文，然后被"跳过已是目标语言"漏掉。
  // info（可选）= 后台 config:get 的 activeLanguage：{ kind, code, detect, script, cjk }。
  // 自定义语言的 detect 只有 zh / ja / ko / en 这类高置信度才参与「已是目标语言」判定；
  // yue / lzh / wuu / 未知代码一律 none —— 宁可多翻，也不因误判跳过本应翻译的文字。
  function detectOf(code, info) {
    if (info && info.value === code && info.detect) return info.detect;
    var s = String(code || '');
    if (s.indexOf('zh') === 0 || s.indexOf('cmn') === 0) return 'zh';
    if (s.indexOf('ja') === 0) return 'ja';
    if (s.indexOf('ko') === 0) return 'ko';
    if (s.indexOf('en') === 0) return 'en';
    return 'none';
  }

  DT.looksLikeTarget = function (text, lang, info) {
    if (!text) return false;
    var letters = (text.match(/\p{L}/gu) || []).length;
    if (letters < 4) return false;

    var code = String(lang || '');
    var detect = detectOf(code, info);
    if (detect === 'none') return false; // 没有高置信度识别：安全降级为照常翻译
    var scriptCode = info && info.code ? String(info.code) : code;
    var cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
    var kana = (text.match(/[\u3040-\u30ff]/g) || []).length;
    var hangul = (text.match(/[\uac00-\ud7af\u1100-\u11ff]/g) || []).length;
    var latin = (text.match(/[A-Za-z]/g) || []).length;

    if (detect === 'zh') {
      if (kana > 0 || hangul > 0) return false; // 有假名/谚文就不是中文
      if (cjk / letters <= 0.75) return false;
      if (latin / letters > 0.15) return false;
      return !wrongScript(text, scriptCode); // 简体 ≠ 繁体：简体页面选了繁體中文也要翻
    }
    if (detect === 'ja') {
      if (kana === 0) return false; // 没有假名的不当日语（否则中文会被判成"已是日语"）
      if ((kana + cjk) / letters <= 0.6) return false;
      if (latin / letters > 0.2) return false;
      return true;
    }
    if (detect === 'ko') {
      if (hangul === 0) return false; // 没有谚文的不当韩语
      if (hangul / letters <= 0.6) return false;
      if (latin / letters > 0.2) return false;
      return true;
    }
    if (detect === 'en') {
      return latin / letters > 0.9;
    }
    return false;
  };

  // ---------------- 近似重复闸门 ----------------
  // 这段文字是不是「主要已经是目标语言」：比 looksLikeTarget 宽松（中英混排也算），只给近似重复闸门用。
  // 收集阶段不能用它 —— 中英混排的段落会被当成已是中文整段不翻（HANDOFF 记过的坑）。
  // 中文目标同样排除假名 / 谚文：日文原文和中文译文共用大量汉字，相似度会虚高
  DT.isMostlyTargetLanguage = function (text, lang, info) {
    var s = String(text || '');
    var letters = (s.match(/\p{L}/gu) || []).length;
    if (letters < 4) return false;
    var han = (s.match(/[\u3400-\u9fff]/g) || []).length;
    var kana = (s.match(/[\u3040-\u30ff]/g) || []).length;
    var hangul = (s.match(/[\uac00-\ud7af\u1100-\u11ff]/g) || []).length;
    var code = String(lang || '');
    var detect = detectOf(code, info);
    var scriptCode = info && info.code ? String(info.code) : code;
    if (detect === 'zh') return kana === 0 && hangul === 0 && han / letters >= 0.4 && !wrongScript(s, scriptCode);
    if (detect === 'ja') return kana > 0 && (kana + han) / letters >= 0.4;
    if (detect === 'ko') return hangul / letters >= 0.4;
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
  DT.isNearDuplicate = function (source, output, lang, info) {
    var a = DT.normalizeText(source);
    var b = DT.normalizeText(output);
    if (a === b) return true;
    return DT.isMostlyTargetLanguage(a, lang, info) && DT.similarity(a, b) >= DT.NEAR_DUP_THRESHOLD;
  };

  // 保留区（dom.js 的 attachKeep）：段落里有 notranslate 等行内内容时，送翻文本带 <kN> 标记
  // （unit.wire；缓存按它记，和不带标记的原文互不串）。没有保留区就是 unit.text
  DT.wireText = function (unit) {
    return (unit && unit.wire) || (unit ? unit.text : '');
  };
  // 模型回来的译文去掉保留标记（标记里的内容换回原文）：去重、对齐校验都按页面上实际显示的文字算
  DT.keepText = function (unit, text) {
    if (unit && unit.inlineProtocol && DT.inlineText) return DT.inlineText(unit, text);
    return unit && unit.keep && unit.keep.length ? DT.units.keepParse(text, unit.keep, unit.text).text : text;
  };

  // 长段落按句切开，避免单条请求过大。
  // 有分行（\n）的文本先按整行装段，一行本身超长才在行内按句切。
  // 返回的数组带 seps：seps[i] 是第 i 段和第 i+1 段之间原来的分隔（换行 '\n' / '\n\n'；行内切点处有空白为 ' '，没有为 ''）。
  // 每一段都是原文的原样子串。拼回译文时先用 DT.translationSeps 按目标语言换掉行内分隔，再交给 DT.joinSlots，
  // 段落换行不会被拼成空格
  DT.splitLong = function (text, max, inlineProtocol) {
    var limit = Math.max(200, Number(max) || 1200);
    var out;
    if (text.length <= limit) {
      out = [text];
      out.seps = [];
      return out;
    }
    if (text.indexOf('\n') >= 0) return splitByLines(text, limit, inlineProtocol);
    var cut = splitSentences(text, limit, inlineProtocol);
    out = cut.parts;
    out.seps = cut.seps;
    return out;
  };

  function splitByLines(text, limit, inlineProtocol) {
    // 先拆成「块」：一整行，或超长行按句切出的一截；sep 是它和前一块之间的分隔
    var atoms = [];
    var gap = '';
    var spans = keepSpans(text, inlineProtocol);
    var lines = [];
    var from = 0;
    for (var ni = 0; ni < text.length; ni += 1) {
      if (text.charAt(ni) === '\n' && !spanAt(spans, ni)) {
        lines.push(text.slice(from, ni));
        from = ni + 1;
      }
    }
    lines.push(text.slice(from));
    lines.forEach(function (line) {
      if (!line.trim()) {
        if (atoms.length) gap += '\n';
        return;
      }
      var sep = atoms.length ? '\n' + gap : '';
      gap = '';
      if (line.length <= limit) {
        atoms.push({ text: line, sep: sep });
        return;
      }
      var cut = splitSentences(line, limit, inlineProtocol);
      cut.parts.forEach(function (piece, k) {
        atoms.push({ text: piece, sep: k ? cut.seps[k - 1] : sep });
      });
    });
    // 再把相邻的块装进不超过 limit 的段
    var out = [];
    var seps = [];
    var buf = '';
    atoms.forEach(function (atom) {
      if (buf && buf.length + atom.sep.length + atom.text.length <= limit) {
        buf += atom.sep + atom.text;
        return;
      }
      if (buf) out.push(buf);
      if (out.length) seps.push(atom.sep);
      buf = atom.text;
    });
    if (buf) out.push(buf);
    if (!out.length) out.push(text.slice(0, limit));
    out.seps = seps;
    return out;
  }

  // 一行之内的句末切点：中日文的句末标点直接切；西文的 . ! ? ; : 后面要跟空白才算句末
  // （3.5、example.com、10:30 不切）。紧跟的引号 / 括号算在前一句里（「……。」）
  var SENT_END = /[.!?…;:]+["'”’)\]]*(?=\s|$)|[。！？；：]+["'”’」』）)\]]*/g;

  // 完整原子与v1格式区间不可切开。普通正文不把字面<fN>解释成协议。
  function keepSpans(text, inlineProtocol) {
    var out = [];
    var stack = [];
    var re = inlineProtocol === 'v1' ? /<(\/?)([kf])(\d{1,3})>/g : /<(\/?)(k)(\d{1,3})>/g;
    var m;
    while ((m = re.exec(text))) {
      if (!m[1]) {
        stack.push({ key: m[2] + m[3], start: m.index });
      } else if (stack.length && stack[stack.length - 1].key === m[2] + m[3]) {
        var open = stack.pop();
        if (!stack.length) out.push([open.start, re.lastIndex]);
      }
    }
    return out;
  }
  function spanAt(spans, at) {
    for (var i = 0; i < spans.length; i += 1) {
      if (at > spans[i][0] && at < spans[i][1]) return spans[i];
    }
    return null;
  }

  // 一行之内按句切（参考 Wenyi 的 split_long_segments：在句末之后切，不增删任何字）。
  // 返回 { parts, seps }：parts 是原文的原样子串（只去掉切点两边的空白），seps[i] 是切点处原来有没有空白（' ' / ''）。
  // 以前先吃掉标点后的空白、再用空格拼回去：发给模型的原文里 3.5 变成 "3. 5"、example.com 变成 "example. com"，
  // 中文「你好。」里也被塞进空格（只影响超过 maxUnitChars 的长段落）
  function splitSentences(text, limit, inlineProtocol) {
    var spans = keepSpans(text, inlineProtocol);
    var pieces = [];
    var last = 0;
    var m;
    SENT_END.lastIndex = 0;
    while ((m = SENT_END.exec(text))) {
      var end = m.index + m[0].length;
      if (spanAt(spans, end)) continue; // 保留区里的句号不是切点
      if (end > last) pieces.push(text.slice(last, end));
      last = end;
    }
    if (last < text.length) pieces.push(text.slice(last));

    // 单句本身超长：按 limit 的 1.6 倍硬切，尽量切在空白处；落在保留区里就挪到它前面（它在开头就挪到后面），
    // 整段只剩一个超长保留区就不切
    var max = Math.floor(limit * 1.6);
    var units = [];
    var pos = 0;
    pieces.forEach(function (piece) {
      var rest = piece;
      var base = pos;
      pos += piece.length;
      while (rest.length > max) {
        var at = rest.lastIndexOf(' ', max);
        if (at < max / 2) at = max;
        var span = spanAt(spans, base + at);
        if (span) at = span[0] > base ? span[0] - base : span[1] - base;
        if (at <= 0 || at >= rest.length) break;
        units.push(rest.slice(0, at));
        rest = rest.slice(at);
        base += at;
      }
      if (rest) units.push(rest);
    });

    var parts = [];
    var seps = [];
    var buf = '';
    units.forEach(function (unit) {
      if (buf && buf.length + unit.length > limit) {
        var gap = /\s$/.test(buf) || /^\s/.test(unit);
        parts.push(buf.replace(/\s+$/, ''));
        seps.push(gap ? ' ' : '');
        buf = unit.replace(/^\s+/, '');
      } else {
        buf += unit;
      }
    });
    if (buf.replace(/\s+$/, '')) parts.push(buf.replace(/\s+$/, ''));
    if (!parts.length) parts.push(text.slice(0, limit));
    return { parts: parts, seps: seps };
  }

  // 拼回译文用的分隔：换行照原样；行内切点按目标语言定——中文 / 日文句子之间不加空格，其它语言加一个空格。
  // 原文切点有没有空白不能照搬：中文原文译成英文，句子之间要有空格；英文原文译成中文则不要
  DT.translationSeps = function (seps, target, info) {
    var custom = info && info.kind === 'custom';
    var cjk = custom ? info.cjk === true : /^(zh|ja)/i.test(String(target || ''));
    return (seps || []).map(function (sep) {
      if (String(sep).indexOf('\n') >= 0) return sep;
      // 没有标准代码的虚构语言：不猜测是否需要空格，保留原文切点处的空白形态。
      if (custom && !info.code) return /\s/.test(String(sep)) ? ' ' : '';
      return cjk ? '' : ' ';
    });
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

  // 长段落被切成多段后拼回去：丢掉空段。seps 是 splitLong 记下的原分隔（换行拼回仍是换行），
  // 没给就用空格连接（旧行为）。中间有空段被丢掉时，保留其中换行最多的那个分隔
  DT.joinSlots = function (slots, seps) {
    var out = '';
    var sep = '';
    (slots || []).forEach(function (part, i) {
      if (i > 0) {
        var s = seps && typeof seps[i - 1] === 'string' ? seps[i - 1] : ' ';
        if (!sep || s.split('\n').length > sep.split('\n').length) sep = s;
      }
      if (!part) return;
      out = out ? out + sep + part : part;
      sep = '';
    });
    return out.trim();
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
  // ---------------- 悬浮入口位置（0.9.3）：纯函数，dock.js / 自检 / 单测共用 ----------------
  // view = { vw, vh, w, h }：视口尺寸与 dock 自身尺寸；pos = { x, y } 期望左上角，可以越界、可以是 NaN
  // 返回 { x, y, side, snapped }：snapped 为 'left' / 'right'（吸附到边）或 null（自由悬浮）；side 给说明气泡 / 菜单决定弹出方向
  DT.dockPlace = function (pos, view, opt) {
    var o = opt || {};
    var margin = o.margin == null ? 8 : o.margin;
    var vw = Math.max(1, view.vw);
    var vh = Math.max(1, view.vh);
    var w = Math.min(view.w, vw);
    var h = Math.min(view.h, vh);
    var room = vw - w - margin * 2;
    var snap = o.snap == null ? 72 : o.snap;
    // 视口窄到两边吸附区会重叠时，把吸附区收窄到不重叠为止
    if (room < snap * 2) snap = Math.max(0, Math.floor(room / 2));
    var maxY = Math.max(margin, vh - h - margin);
    var y = Math.round(pos.y >= margin ? (pos.y <= maxY ? pos.y : maxY) : margin);
    if (pos.x <= snap) return { x: 0, y: y, side: 'left', snapped: 'left' };
    if (vw - (pos.x + w) <= snap) return { x: Math.max(0, vw - w), y: y, side: 'right', snapped: 'right' };
    var maxX = Math.max(margin, vw - w - margin);
    var x = Math.round(pos.x >= margin ? (pos.x <= maxX ? pos.x : maxX) : margin);
    return { x: x, y: y, side: x + w / 2 < vw / 2 ? 'left' : 'right', snapped: null };
  };

  // 没拖过时的默认位置：跟 dockSide 贴边，竖直方向在视口高度 58% 处居中（与旧 CSS top:58% 一致）
  DT.dockDefault = function (side, view) {
    var vw = Math.max(1, view.vw);
    var vh = Math.max(1, view.vh);
    var w = Math.min(view.w, vw);
    var h = Math.min(view.h, vh);
    var maxY = Math.max(8, vh - h - 8);
    var y = Math.round(vh * 0.58 - h / 2);
    if (y > maxY) y = maxY;
    if (y < 8) y = 8;
    return side === 'left' ? { x: 0, y: y } : { x: Math.max(0, vw - w), y: y };
  };
})();
