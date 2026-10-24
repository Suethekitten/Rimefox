#!/usr/bin/env node
// 真实浏览器端到端检查：真实 Chrome（或 Edge）+ 加载工作树里的扩展 + 本地假 OpenAI 兼容接口，不需要 API Key。
//   node tools/e2e-extension.mjs                                  普通文章页 / 划词 / 仅译文 / 还原 / 配置广播 / 简繁 / 缓存落盘 / 设置页
//   node tools/e2e-extension.mjs --youtube <视频地址>              再加 YouTube 真实页面的双语字幕（需要能上 YouTube，视频要有人工字幕）
//   --browser <可执行文件>（或环境变量 RIMEFOX_BROWSER）换浏览器，比如 Edge；--headed 显示窗口；--keep 保留临时用户目录；
//   --verbose 打印扩展的调试日志、YouTube 的字幕请求和广告开始 / 结束（排查用）；--youtube-only 跳过文章页和设置页
// 品牌版 Chrome 137+ 不认 --load-extension：带 --enable-unsafe-extension-debugging 启动，再用 CDP 的 Extensions.loadUnpacked 加载。
// 全部通过时退出码 0；结果另存在临时目录的 result.json。Node 22+（用内置 WebSocket），不依赖 npm 包。
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const ROOT = argv.includes('--root')
  ? path.resolve(argv[argv.indexOf('--root') + 1])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
const flag = (name) => argv.includes(name);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : '';
};
const DEFAULT_BROWSER = {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: 'google-chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
}[process.platform];
const BROWSER = option('--browser') || process.env.RIMEFOX_BROWSER || DEFAULT_BROWSER;
const YOUTUBE = option('--youtube');
const LIVE_AOZORA = flag('--aozora-live')
  ? (() => {
      const arg = option('--aozora-live');
      return arg && !arg.startsWith('--') ? arg : 'https://www.aozora.gr.jp/cards/000879/files/127_15260.html';
    })()
  : '';
const VERBOSE = flag('--verbose');
const SHADOW_ONLY = flag('--shadow-only');
const MEDICAL_ONLY = flag('--medical-only');
const SELFTEST_ONLY = flag('--selftest-only');
const GLOSSARY_ONLY = flag('--glossary-only');
const SCIENCE_LIVE = flag('--science-live');
const DUAL_LIVE = flag('--dual-live')
  ? (() => {
      const arg = option('--dual-live');
      return arg && !arg.startsWith('--') ? arg : 'https://www.chosun.com/economy/industry-company/2026/10/23/ZWDCNVYTJ5AJ3OEPV2PTABG5WA/';
    })()
  : '';
const DUAL_LABEL = option('--label') || 'current';
const CHOSUN_LIVE = flag('--chosun-live')
  ? (() => {
      const arg = option('--chosun-live');
      return arg && !arg.startsWith('--') ? arg : 'https://www.chosun.com/economy/industry-company/2026/10/23/ZWDCNVYTJ5AJ3OEPV2PTABG5WA/';
    })()
  : '';
const BILIBILI_LIVE = flag('--bilibili-live')
  ? (() => {
      const arg = option('--bilibili-live');
      return arg && !arg.startsWith('--') ? arg : 'https://www.bilibili.com/zh-Hans/video/BV1xrnz6gEVD';
    })()
  : '';
const t0 = Date.now();
const verbose = (...args) => VERBOSE && console.log('    · ' + ((Date.now() - t0) / 1000).toFixed(1) + 's', ...args);
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'rimefox-e2e-'));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const DEBUG_PORT = 19300 + Math.floor(Math.random() * 500);
const ORIGIN = 'http://127.0.0.1:' + PORT;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail !== undefined ? ' — ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 反复试 fn 直到返回真值；超时返回 null（中途抛错当作还没好）
async function until(fn, ms = 15000, step = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      /* 还没好 */
    }
    await sleep(step);
  }
  return null;
}

// ---------------- 假接口 + 测试页 ----------------
// 模型：每条译文 = '译:' + 原文（目标是繁體中文时 '繁:'）；单条带 CITE 回纯文本「巴黎是首都[1]。」，带 SPLIT 回拆开的两句。
// 带 reasoning_effort 的请求回 400（OpenAI 官方非推理模型就是这样），用来看扩展会不会记住、不再发
const stats = { requests: 0, texts: 0, withEffort: 0, lateRejected: 0, firstOk: 0, aligned: 0, aozoraLive: false, sent: [], systems: [], lastSystem: '', lastAlignedSystem: '', keepSystem: '' };
const OWID_ZH =
  '这9张图表展示了世界不同地区的数据。每张图表的横轴是平均收入（人均GDP），纵轴是生活在极端贫困中的人口比例。' +
  '每条轨迹的起点显示的是1820年的数据，它告诉我们，两个世纪前，无论人们身处世界何处，大多数人都生活在极端贫困之中。' +
  '11 自那时起，世界所有地区都实现了增长——商品和服务的生产增加了——生活在贫困中的人口比例下降了。';

// 文献引用：Nature Medicine 那一段的真实 DOM，取自 selftest/index.html 的 tpl-nature-cite（只存一份）。
// 页面放在和 nature.com 相同的路径上，两种 href（#ref-CR3 和 /articles/…#ref-CR1）都是本页锚点，能真实点击
const NATURE_PATH = '/articles/s41591-022-01767-6';
const NATURE_FIXTURE = (() => {
  const html = fs.readFileSync(path.join(ROOT, 'selftest', 'index.html'), 'utf8');
  const m = /<template id="tpl-nature-cite">([\s\S]*?)<\/template>/.exec(html);
  if (!m) throw new Error('selftest/index.html 里找不到 tpl-nature-cite');
  return m[1];
})();
const SCIENCE_FIXTURE = (() => {
  const html = fs.readFileSync(path.join(ROOT, 'selftest', 'index.html'), 'utf8');
  const m = /<template id="tpl-science-cite">([\s\S]*?)<\/template>/.exec(html);
  if (!m) throw new Error('selftest/index.html 里找不到 tpl-science-cite');
  return m[1];
})();
const LINK_FIXTURE = (() => {
  const html = fs.readFileSync(path.join(ROOT, 'selftest', 'index.html'), 'utf8');
  const m = /<template id="tpl-link-boundary">([\s\S]*?)<\/template>/.exec(html);
  if (!m) throw new Error('selftest/index.html 里找不到 tpl-link-boundary');
  return m[1];
})();

const SHADOW_BILI_PAGE = `<!doctype html><html lang="en" data-dt-shadow-test><head><meta charset="utf-8"><title>Bilibili shadow fixture</title>
<style>body{font:15px/1.6 system-ui;margin:24px;max-width:760px} bili-comments{display:block;margin-top:16px} .spacer{height:1600px}</style></head><body>
<h1 id="video-title">A normal video title that is outside the comment shadow roots.</h1>
<p id="video-desc">The video description is ordinary DOM and should keep translating as before.</p>
<bili-comments id="comments"></bili-comments>
<div id="closed"></div>
<button id="late-reply" type="button">late reply</button>
<button id="show-hidden" type="button">show hidden</button>
<div class="spacer"></div>
<script>
(function () {
  function upgrade(root) {
    try { if (window.customElements && customElements.upgrade) customElements.upgrade(root); } catch (err) {}
  }
  class BiliRichText extends HTMLElement {
    constructor() {
      super();
      var root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<div id="contents"></div>';
    }
    contents() { return this.shadowRoot.querySelector('#contents'); }
    setText(text) { this.contents().textContent = text; }
    setRich(text) {
      var c = this.contents();
      c.textContent = '';
      c.appendChild(document.createTextNode(text + ' '));
      var a = document.createElement('a');
      a.id = 'comment-link';
      a.href = '#comment-link';
      a.textContent = '@friend';
      c.appendChild(a);
      c.appendChild(document.createTextNode(' and a link.'));
    }
  }
  class BiliCommentRenderer extends HTMLElement {
    constructor() {
      super();
      var root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<div class="user" id="user">User Name</div><div class="time" id="time">2 hours ago</div><bili-rich-text></bili-rich-text><div class="actions" id="actions">Like 12</div>';
      upgrade(root);
    }
    rich() { return this.shadowRoot.querySelector('bili-rich-text'); }
    setText(text) { var r = this.rich(); if (r) r.setText(text); }
    setRich(text) { var r = this.rich(); if (r) r.setRich(text); }
  }
  class BiliReplyRenderer extends HTMLElement {
    constructor() {
      super();
      var root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<bili-comment-renderer></bili-comment-renderer>';
      upgrade(root);
    }
    renderer() { return this.shadowRoot.querySelector('bili-comment-renderer'); }
  }
  class BiliThreadRenderer extends HTMLElement {
    constructor() {
      super();
      var root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<div id="comment"></div><div id="replies"></div>';
      var r = document.createElement('bili-comment-renderer');
      root.querySelector('#comment').appendChild(r);
      upgrade(root);
    }
    primary() { return this.shadowRoot.querySelector('#comment bili-comment-renderer'); }
    replies() { return this.shadowRoot.querySelector('#replies'); }
    setPrimary(text, rich) { if (rich) this.primary().setRich(text); else this.primary().setText(text); }
    addReply(text) {
      var wrap = document.createElement('bili-comment-reply-renderer');
      this.replies().appendChild(wrap);
      var r = wrap.renderer();
      if (r) r.setText(text);
      return wrap;
    }
  }
  class BiliComments extends HTMLElement {
    constructor() {
      super();
      var root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<div id="feed"></div>';
    }
    feed() { return this.shadowRoot.querySelector('#feed'); }
  }
  customElements.define('bili-rich-text', BiliRichText);
  customElements.define('bili-comment-renderer', BiliCommentRenderer);
  customElements.define('bili-comment-reply-renderer', BiliReplyRenderer);
  customElements.define('bili-comment-thread-renderer', BiliThreadRenderer);
  customElements.define('bili-comments', BiliComments);

  var comments = document.getElementById('comments');
  window.__comments = comments;
  function addThread(primary, reply, rich) {
    var thread = document.createElement('bili-comment-thread-renderer');
    comments.feed().appendChild(thread);
    thread.setPrimary(primary, rich);
    if (reply) thread.addReply(reply);
    return thread;
  }
  window.biliAddThread = function (primary, reply) {
    return addThread(primary, reply || '');
  };
  window.biliLateReply = function () {
    var first = comments.feed().children[0];
    if (first) first.addReply('Late nested reply loaded after the click in the fixture.');
  };
  window.biliShowHidden = function () {
    var hidden = window.__hiddenThread;
    if (hidden) hidden.replies().style.display = '';
  };
  window.biliSort = function () {
    var feed = comments.feed();
    var list = Array.prototype.slice.call(feed.children).reverse();
    feed.textContent = '';
    list.forEach(function (one) { feed.appendChild(one); });
  };
  window.biliReplace = function () {
    var old = window.__comments;
    old.remove();
    var next = document.createElement('bili-comments');
    next.id = 'comments';
    document.body.insertBefore(next, document.getElementById('closed'));
    window.__comments = next;
    var thread = document.createElement('bili-comment-thread-renderer');
    next.feed().appendChild(thread);
    thread.setPrimary('A fresh comment tree after switching the video.');
    return next;
  };

  addThread('Top-level comment one: the new Bilibili comment tree lives in shadow roots.', 'Nested reply one: I can see this reply after expanding.');
  addThread('Top-level comment two: this video is great, and the comments should translate too.', 'Nested reply two: same here, the reply is also translated.');
  var withInput = addThread('Comment with an input box should still translate its body.');
  var ta = document.createElement('textarea');
  ta.id = 'shadow-input';
  ta.value = 'shadow input draft';
  withInput.shadowRoot.querySelector('#comment').appendChild(ta);
  var hidden = addThread('Top-level comment with a hidden reply should translate its body.');
  hidden.replies().classList.add('hidden-reply');
  hidden.replies().style.display = 'none';
  window.__hiddenThread = hidden;
  hidden.addReply('Hidden reply text should stay untranslated until it is shown.');

  var rich = addThread('', '');
  rich.setPrimary('Top-level comment with an inline mention is translated while the link stays clickable.', true);

  var closedRoot = document.getElementById('closed').attachShadow({ mode: 'closed' });
  closedRoot.innerHTML = '<bili-comment-renderer></bili-comment-renderer>';
  upgrade(closedRoot);
  closedRoot.querySelector('bili-comment-renderer').setText('Closed shadow comment must not be translated.');
  window.__closedRoot = closedRoot;

  document.getElementById('late-reply').addEventListener('click', function () {
    setTimeout(window.biliLateReply, 700);
  });
  document.getElementById('show-hidden').addEventListener('click', function () {
    window.biliShowHidden();
  });
})();
</script>
</body></html>`;
const SHADOW_AUTO_PAGE = `<!doctype html><html lang="en" data-dt-shadow-auto><head><meta charset="utf-8"><title>Generic shadow fixture</title></head><body>
<h1 id="title">Generic open Shadow DOM fixture</h1>
<x-card id="card1"><span id="slot1">Slotted light DOM text should be translated exactly once.</span></x-card>
<x-outer id="outer"></x-outer>
<x-closed id="closed"></x-closed>
<script>
class XCard extends HTMLElement {
  constructor() {
    super();
    var root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<div id="body">Shadow body text inside a custom card should be translated.</div><slot></slot>';
  }
}
class XOuter extends HTMLElement {
  constructor() {
    super();
    var root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<x-card id="inner"><span id="inner-slot">Nested slotted text should also be translated once.</span></x-card>';
  }
}
class XClosed extends HTMLElement {
  constructor() {
    super();
    var root = this.attachShadow({ mode: 'closed' });
    root.innerHTML = '<div>Closed shadow text must not be translated.</div>';
  }
}
customElements.define('x-card', XCard);
customElements.define('x-outer', XOuter);
customElements.define('x-closed', XClosed);
window.__outer = document.getElementById('outer');
</script>
</body></html>`;

// selftest/index.html 里的夹具模板（夹具只存一份，E2E 直接取用）
function templateOf(id) {
  const html = fs.readFileSync(path.join(ROOT, 'selftest', 'index.html'), 'utf8');
  const m = new RegExp('<template id="' + id + '">([\\s\\S]*?)<\\/template>').exec(html);
  if (!m) throw new Error('selftest/index.html 里找不到 ' + id);
  return m[1];
}

const PAGES = {
  '/shadow-bili.html': SHADOW_BILI_PAGE,
  '/shadow-auto.html': SHADOW_AUTO_PAGE,
  [NATURE_PATH]: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Nature citations</title>
<style>.fx-nature sup{position:relative;top:-.375em;font-size:.75em;line-height:0;vertical-align:baseline}</style></head><body>
${NATURE_FIXTURE}
</body></html>`,
  '/science-cite.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Science citations</title></head><body>
${SCIENCE_FIXTURE}
</body></html>`,
  // 混合行内内容：文献引用 + Fig. 1 图表链接 + 普通文字（selftest 的 tpl-science-mixed，只存一份）
  '/science-mixed.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Science mixed inline</title></head><body>
${templateOf('tpl-science-mixed')}
</body></html>`,
  '/chinagp.html': `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>中国全科医学 RichHTML</title></head><body>
${templateOf('tpl-chinagp')}
</body></html>`,
  '/korean-bold.html': `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Korean style boundaries</title></head><body style="font:16px/1.7 sans-serif;max-width:760px;margin:30px">
<p id="bold-start"><strong>한국어 문장의 일부만 강조된 부분</strong> 나머지 기사 본문은 일반 굵기로 이어집니다. 같은 문장 안에서 강조가 끝나야 합니다.</p>
<p id="font-foreign" style="font-family:'AppleMyungjo',serif;font-size:18px;font-weight:400;line-height:1.7;color:rgb(20,30,40)">한국어 본문은 한글 전용 명조체로 표시되지만 중국어 번역은 글자마다 다른 대체 글꼴로 섞여 보입니다.</p>
<p id="font-native" style="font-family:'PingFang SC',sans-serif;font-size:17px">한국어 본문이 이미 중국어 글꼴을 포함한 경우에는 글꼴을 바꾸지 않습니다.</p>
<h2 id="font-heading" style="font-family:'AppleMyungjo',serif;font-size:40px">굵은 제목은 번역해도 제목 글꼴을 유지합니다</h2>
<p id="font-emphasis" style="font-family:'AppleMyungjo',serif"><strong>이 문장 전체가 의도적으로 강조된 안내입니다.</strong></p>
<p id="bold-mid">앞부분은 일반 본문이고 <strong>중간의 중요한 표현</strong> 뒤로 다시 일반 본문이 이어지는 문장입니다.</p>
<p id="bold-end">마지막에만 <strong>강조된 표현</strong></p>
<p id="bold-span"><span style="font-weight:700">굵은 span으로 시작하는 문장</span> 뒤에는 일반 텍스트가 이어집니다.</p>
<p id="bold-medium"><span style="font-weight:500">중간 굵기 span으로 시작하는 문장</span> 뒤에는 일반 텍스트가 이어집니다.</p>
<p id="bold-family"><span style="font-family:'Arial Black',sans-serif">굵은 글꼴 family로 시작하는 문장</span> 뒤에는 일반 텍스트가 이어집니다.</p>
<p id="bold-b"><b>굵은 b로 시작하는 문장</b> 뒤에는 일반 텍스트가 이어집니다.</p>
<p id="bold-em"><em>기울임 강조</em>와 <i>다른 기울임</i>이 섞인 일반 문장입니다. 번역은 일반 굵기여야 합니다.</p>
<p id="whole-strong"><strong>이 문단 전체가 의도적으로 강조된 안내 문구입니다.</strong></p>
<h2 id="whole-heading"><strong>전체가 굵은 제목</strong></h2>
<p id="multi-bold"><strong>첫 번째 줄 강조</strong><br>두 번째 줄은 일반 본문입니다.<br><strong>세 번째 줄 강조</strong> 뒤에 일반 텍스트.</p>
<p id="nested-bold"><strong><em>중첩 strong em 강조</em> 뒤쪽 strong</strong> 일반 꼬리 텍스트</p>
<p id="prewrap" style="white-space:pre-wrap"><strong>pre-wrap 첫 줄 강조</strong>
일반 둘째 줄 텍스트
셋째 줄도 일반 텍스트</p>
<p id="link-strong">본문 중간에 <strong>강조</strong>와 <a href="#ref-1">[1]</a> 인용이 같이 있습니다.</p>
<div id="ref-1">Reference one.</div>
</body></html>`,
  '/direction.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Bidirectional layout</title></head><body>
${templateOf('tpl-direction')}
</body></html>`,
  '/pmc.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>PMC adverse events</title></head><body>
${templateOf('tpl-pmc')}
</body></html>`,
  '/inline-links.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Inline links</title></head><body>
${LINK_FIXTURE}
</body></html>`,
  '/medical.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Medical</title></head><body>
<p id="med">An odds ratio of 2.1 (95% CI 1.2–3.4) was reported in the randomized controlled trial.</p>
</body></html>`,
  '/page.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Article</title></head><body>
<h1>Rimefox release test page</h1>
<p id="p1">This is the first paragraph of the article with enough words to translate.</p>
<p id="p2">Hello <span class="notranslate">Rimefox</span> world</p>
<p id="p3">The second normal paragraph talks about translation quality and speed.</p>
<iframe id="f" src="/frame.html" width="420" height="120"></iframe>
</body></html>`,
  '/frame.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>
<p id="fp">Text inside the embedded frame should stay original after reload.</p></body></html>`,
  '/simp.html': `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>简体</title></head><body>
<p id="s1">这是一个完整的中文句子，用于测试简繁转换的效果。</p>
<p id="s2">我们发现这个问题以后，马上开始处理相关的工作。</p>
</body></html>`,
  '/aozora.html': `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Aozora</title></head><body>
<div id="mt" class="main_text" style="width:640px;font:16px/2 serif">ある日の暮方の事である。一人の下人が、羅生門の下で雨やみを待っていた。<br><br>広い門の下には、この男のほかに誰もいない。ただ、所々丹塗りの剥げた、大きな円柱に、蟋蟀が一匹とまっている。<br><br>羅生門が、朱雀大路にある以上は、この男のほかにも、雨やみをする市女笠や揉烏帽子が、もう二三人はありそうなものである。</div>
</body></html>`,
  '/pixiv.html': `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Pixiv</title></head><body>
<div id="novel" style="white-space:pre-wrap;width:640px;font:16px/2 serif"><p id="np1"><span>「今日は何の日？」</span><br><span>「ポッキーの日だ。」</span></p><p id="np2">彼は<ruby>羅生門<rt>らしょうもん</rt></ruby>の下で、雨やみを待っていた。</p><p id="np3">静かな夜だった。</p></div>
</body></html>`,
  // Our World in Data 式：脚注号 <sup> 紧跟句号；假接口对这段只回普通字符串（没有 parts），模拟旧缓存 / 模型不按格式输出
  '/owid.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>OWID</title></head><body>
<div style="width:640px;font:16px/1.7 sans-serif"><p id="ow">The 9 charts show the data for different regions in the world. On the horizontal axis of each chart, you find the average income (GDP per capita) and on the vertical axis you see the share living in extreme poverty. The starting point of each trajectory shows the data for 1820 and it tells us that two centuries ago the majority of people lived in extreme poverty, no matter where in the world they were at home.<sup><a href="#n11">11</a></sup> Since then, all world regions achieved growth – the production of goods and services increased – and the share living in poverty declined.</p>
<p id="ow2">[See also my related article: 'What is Economic Growth?']</p></div>
</body></html>`,
  '/input.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Inputs</title></head><body>
<p id="hint">Text box translation fixture.</p>
<textarea id="ta" rows="3">Hello draft line</textarea>
<input id="tx" type="text" value="Another draft">
<input id="rx" type="text" value="Controlled input">
<div id="ce" contenteditable="true">Editable rich text</div>
<input id="pw" type="password" value="secret">
<script>
  // 模拟 React 受控输入框：state 只认 input 事件（没收到事件就当没改），并写回 data-state 供检查
  (function () {
    var rx = document.getElementById('rx');
    var state = rx.value;
    rx.addEventListener('input', function () {
      state = rx.value;
      rx.setAttribute('data-state', state);
    });
    rx.setAttribute('data-state', state);
  })();
</script>
</body></html>`
};

// 假模型从系统提示词里认目标语言：0.9.6 用「唯一目标语言：Name (code)」，
// 旧写法（普通模式的「目标语言（繁體中文）」）留作兜底。认不出来按简体中文。
function targetCodeOf(system) {
  const sys = String(system || '');
  const m = /唯一目标语言：[^\n(]+\(([^)]+)\)/.exec(sys);
  if (m) return m[1].trim();
  if (sys.includes('目标语言（繁體中文）')) return 'zh-TW';
  if (sys.includes('目标语言（简体中文）')) return 'zh-CN';
  if (sys.includes('目标语言（English）')) return 'en';
  return 'zh-CN';
}

const server = http.createServer((req, res) => {
  const route = req.url.split('?')[0];
  if (req.method === 'GET' && PAGES[route]) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGES[route]);
    return;
  }
  if (req.method === 'POST' && route === '/v1/chat/completions') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      const headers = { 'content-type': 'application/json' };
      stats.lastSystem = String((body.messages && body.messages[0] && body.messages[0].content) || '');
      stats.systems.push(stats.lastSystem);
      if (body.reasoning_effort !== undefined) {
        stats.withEffort += 1;
        // 已经有请求去掉参数重发成功过（后台一定收到过 400）之后还带着参数来：记忆没生效
        if (stats.firstOk) stats.lateRejected += 1;
        res.writeHead(400, headers);
        res.end('{"error":{"message":"Unrecognized request argument supplied: reasoning_effort"}}');
        return;
      }
      const texts = JSON.parse(body.messages[1].content);
      stats.requests += 1;
      stats.texts += texts.length;
      stats.sent.push(...texts);
      // 带保留标记（<kN>）的那一批的系统提示词：文献引用检查要看它，不能拿最后一批
      if (texts.some((one) => /<k\d+>[\s\S]*?<\/k\d+>/.test(String(one)))) stats.keepSystem = String(body.messages[0].content || '');
      if (!stats.firstOk) stats.firstOk = Date.now();
      let content;
      const sys = String(body.messages[0].content || '');
      // 0.9.6：从提示词里读目标语言。只有「唯一目标语言：English (en)」真的写进去时才回英文，
      // 否则回中文 —— 这样提示词一旦退回旧写法，目标语言相关的 E2E 会重新变红。
      const targetCode = targetCodeOf(sys);
      const english = /^en/i.test(targetCode);
      const hant = /^zh-(tw|hk|mo)/i.test(targetCode);
      const prefix = hant ? '繁:' : '译:';
      const CHOSUN_ZH = '韩国电力公司已启动下一任社长的重新公开招募。这是选拔李在明政府任命的首位韩电掌门人的程序，新任社长将负责为湖南、龙仁半导体集群和人工智能数据中心等三大超大型项目扩充所需电网。';
      const wantsAlign = sys.includes('"parts"');
      if (wantsAlign) {
        stats.aligned += 1;
        stats.lastAlignedSystem = sys;
      }
      const aligned = (text, i) => {
        // 和内容脚本同一套简单切句：句末标点后断开；每句一个 n=1 的片段
        const sents = String(text)
          .split(/(?<=[。！？…])|(?<=[.!?])\s+/)
          .map((one) => one.trim())
          .filter(Boolean);
        const list = sents.length ? sents : [String(text)];
        if (english) {
          // 目标英文：回确定是英文的片段，n 仍按源句数切好，句级对照照常能校验
          return { parts: list.map((one, k) => ({ n: 1, t: 'EN sentence ' + (i + 1) + '.' + (k + 1) })) };
        }
        // 真实青空文库验收：译文用纯中文填充（同长度），这样「页面上是否残留假名」才是有效断言
        if (stats.aozoraLive && /[\u3040-\u30ff]/.test(String(text))) {
          return { parts: list.map((one) => ({ n: 1, t: '汉'.repeat(Math.max(4, one.length)) })) };
        }
        return { parts: list.map((one) => ({ n: 1, t: prefix + one })) };
      };
      if (texts.length === 1 && texts[0].includes('CITE')) content = '巴黎是首都[1]。';
      else if (texts.length === 1 && texts[0].includes('SPLIT')) content = '["Hello.","How are you?"]';
      else {
        content = JSON.stringify(
          texts.map((t, i) => {
            if (String(t).includes('trajectory')) return OWID_ZH;
            if (wantsAlign) return aligned(t, i);
            if (english) return 'EN translation ' + (i + 1);
            if (stats.aozoraLive && /[\u3040-\u30ff]/.test(String(t))) return '汉'.repeat(Math.max(4, String(t).length));
            if (stats.chosunLive && /^zh/i.test(targetCode) && /[\uac00-\ud7af]/.test(String(t))) return CHOSUN_ZH;
            return prefix + t;
          })
        );
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

// ---------------- 浏览器 + CDP ----------------
const profile = path.join(WORK, 'profile');
const browser = spawn(BROWSER, [
  ...(flag('--headed') ? [] : ['--headless=new']),
  '--enable-unsafe-extension-debugging',
  '--remote-debugging-port=' + DEBUG_PORT,
  '--remote-allow-origins=*',
  '--user-data-dir=' + profile,
  '--autoplay-policy=no-user-gesture-required',
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank'
], { stdio: 'ignore' });

const version = await until(async () => {
  const r = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/version');
  return r.ok ? r.json() : null;
}, 20000);
if (!version) throw new Error('浏览器没有起来：' + BROWSER);
console.log(version.Browser + ' · 扩展目录 ' + ROOT + ' · 假接口 ' + ORIGIN);

const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let seq = 0;
const pending = new Map();
const exceptions = [];
const contexts = []; // 各标签页里的执行环境：内容脚本跑在扩展的隔离环境里
const timedtext = new Map(); // YouTube 字幕请求：requestId → { v, mime }，跟踪它的响应
const captionResponses = []; // 加载完的字幕回包：{ v, mime, bytes }
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message + ' ' + (m.error.data || '')));
    else p.resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.executionContextCreated') contexts.push({ session: m.sessionId, ctx: m.params.context });
  if (VERBOSE && m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args || []).map((a) => (a.value !== undefined ? a.value : a.description)).join(' ');
    if (text.indexOf('[凛狐') === 0) verbose(text.slice(0, 200));
  }
  if (m.method === 'Network.requestWillBeSent' && /\/api\/timedtext/.test(m.params.request.url)) {
    const q = new URL(m.params.request.url).searchParams;
    timedtext.set(m.params.requestId, { v: q.get('v'), mime: '' });
    const init = m.params.initiator || {};
    const frame = init.stack && init.stack.callFrames && init.stack.callFrames[0];
    if (VERBOSE) verbose('字幕请求 v=' + q.get('v') + ' lang=' + q.get('lang') + ' kind=' + (q.get('kind') || '-') + ' fmt=' + q.get('fmt') + ' type=' + m.params.type +
      ' 发起=' + init.type + (frame ? ' ' + (frame.functionName || '?') + ' @ ' + String(frame.url).split('/').pop() : '') + ' frame=' + String(m.params.frameId).slice(0, 8));
  }
  if (timedtext.has(m.params && m.params.requestId)) {
    const req = timedtext.get(m.params.requestId);
    if (m.method === 'Network.responseReceived') {
      const r = m.params.response;
      req.mime = r.mimeType;
      verbose('  字幕响应 ' + r.status + ' ' + r.mimeType + (r.fromServiceWorker ? ' 来自 Service Worker' : '') + (r.fromDiskCache ? ' 来自磁盘缓存' : ''));
    }
    if (m.method === 'Network.loadingFinished') {
      captionResponses.push({ v: req.v, mime: req.mime, bytes: m.params.encodedDataLength });
      verbose('  字幕加载完成 ' + m.params.encodedDataLength + ' 字节');
    }
    if (m.method === 'Network.loadingFailed') verbose('  字幕加载失败 ' + m.params.errorText + (m.params.canceled ? '（被取消）' : ''));
  }
  // 只记扩展自己的异常：YouTube 这类网页自己的报错不算
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    const where = d.url || (d.stackTrace && d.stackTrace.callFrames[0] && d.stackTrace.callFrames[0].url) || '';
    if (!where || where.startsWith('chrome-extension://') || where.startsWith(ORIGIN)) {
      exceptions.push(((d.exception && d.exception.description) || d.text) + ' @ ' + where);
    }
  }
};
function send(method, params = {}, sessionId) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(sessionId, expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result.value;
}
async function attach(targetId) {
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  return sessionId;
}

const { id: extId } = await send('Extensions.loadUnpacked', { path: ROOT });
const swTarget = await until(async () => {
  const { targetInfos } = await send('Target.getTargets');
  return targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://' + extId));
});
if (!swTarget) throw new Error('找不到扩展的 service worker');
const sw = await attach(swTarget.targetId);
const swEval = (code) => evaluate(sw, '(async () => {' + code + '})()');
const readConfig = () => swEval("return (await chrome.storage.local.get('config')).config;");
const patchConfig = (patch) => {
  // This fixture writes storage directly; keep the v7 compatibility aliases coherent,
  // as saveConfig does for the actual popup/options controls tested below.
  const next = { ...patch };
  if (next.professionalProfile === 'general' || next.professionalProfile === 'medical') next.medicalMode = next.professionalProfile === 'medical';
  else if (typeof next.medicalMode === 'boolean') next.professionalProfile = next.medicalMode ? 'medical' : 'general';
  return swEval("const c = (await chrome.storage.local.get('config')).config; Object.assign(c, " + JSON.stringify(next) + '); await chrome.storage.local.set({ config: c }); return true;');
};

await swEval(
  'await chrome.storage.local.set({ config: ' +
    JSON.stringify({
      _v: 6,
      currentProvider: '__custom__',
      customProviders: [{ id: '__custom__', name: 'Fake' }, { id: 'custom:2', name: 'Two' }],
      providerConfig: {
        __custom__: { engine: 'openai', baseUrl: ORIGIN + '/v1', apiKey: 'sk-test', model: 'fake' },
        'custom:2': { engine: 'openai', baseUrl: ORIGIN + '/v1', apiKey: 'sk-two-secret', model: 'fake2' }
      },
      targetLang: 'zh-CN',
      mode: 'dual',
      lazy: false,
      thinkingMode: 'off',
      hoverCompare: true
    }) +
    ' }); return true;'
);

// 新开一个标签页，等内容脚本起来（它会在 <html> 上写 data-dt）
async function openTab(url, before) {
  const { targetId } = await send('Target.createTarget', { url: before ? 'about:blank' : url });
  const s = await attach(targetId);
  if (before) {
    await before(s);
    await send('Page.navigate', { url }, s);
  }
  await until(() => evaluate(s, "['off', 'on'].indexOf(document.documentElement.getAttribute('data-dt')) >= 0"), 30000);
  const tabId = await swEval('const t = await chrome.tabs.query({}); return t.filter((x) => x.url === ' + JSON.stringify(url) + ' || (x.url && x.url.indexOf(' + JSON.stringify(url) + ') === 0)).map((x) => x.id).pop();');
  return { s, targetId, tabId };
}
const tabMsg = (tabId, msg) => swEval('return await chrome.tabs.sendMessage(' + tabId + ', ' + JSON.stringify(msg) + ', { frameId: 0 });');
const settled = (tab) =>
  until(async () => {
    const st = await tabMsg(tab.tabId, { type: 'dt:status' });
    return st && !st.busy && st;
  });
const pageEval = (tab, code) => evaluate(tab.s, '(() => {' + code + '})()');
// 在这个标签页顶层框架的内容脚本环境（扩展的隔离环境）里求值
async function contentEval(tab, expression) {
  const mine = contexts.filter((c) => c.session === tab.s && c.ctx.auxData && c.ctx.auxData.type === 'isolated' && c.ctx.origin === 'chrome-extension://' + extId);
  for (let i = mine.length - 1; i >= 0; i -= 1) {
    const top = await send('Runtime.evaluate', { contextId: mine[i].ctx.id, expression: 'window.top === window && !!window.__DT', returnByValue: true }, tab.s).catch(() => null);
    if (!top || !top.result || top.result.value !== true) continue;
    const r = await send('Runtime.evaluate', { contextId: mine[i].ctx.id, expression, awaitPromise: true, returnByValue: true }, tab.s);
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  }
  throw new Error('找不到内容脚本的执行环境');
}

// ---------------- 普通文章页 ----------------
async function articleChecks() {
  console.log('\n[普通文章页]');
  const a = await openTab(ORIGIN + '/page.html');
  await tabMsg(a.tabId, { type: 'dt:toggle' });
  await until(() => pageEval(a, "return document.querySelectorAll('[data-dt-target]').length >= 3"));
  await settled(a);
  const dual = await pageEval(a, `return {
    p1: (document.querySelector('#p1 [data-dt-target]') || {}).textContent || '',
    brand: document.querySelector('#p2 .notranslate').textContent
  }`);
  check('双语：段落追加译文', dual.p1.startsWith('译:This is the first'), dual.p1);
  check('双语：notranslate 原样', dual.brand === 'Rimefox', dual.brand);

  // 刷新：主框架按标签页记忆恢复，iframe 不自己开始翻译
  await evaluate(a.s, 'location.reload(); true');
  await sleep(500);
  await until(() => pageEval(a, "return document.querySelectorAll('#p1 [data-dt-target]').length === 1"));
  await sleep(2500);
  const reloaded = await pageEval(a, `return {
    main: document.querySelectorAll('[data-dt-target]').length,
    frame: document.getElementById('f').contentDocument.querySelectorAll('[data-dt-target]').length
  }`);
  check('刷新后主框架自动恢复翻译', reloaded.main >= 3, reloaded.main);
  check('刷新后 iframe 没有自己开始翻译', reloaded.frame === 0, reloaded.frame);

  await tabMsg(a.tabId, { type: 'dt:setMode', mode: 'translation' });
  await until(() => pageEval(a, "return document.querySelectorAll('[data-dt-replaced]').length >= 3"));
  await settled(a);
  const only = await pageEval(a, `return { p2: document.getElementById('p2').textContent, brand: document.querySelector('#p2 .notranslate').textContent, p1: document.getElementById('p1').textContent }`);
  check('仅译文：段落原地替换', only.p1.startsWith('译:'), only.p1);
  check('仅译文：notranslate 的品牌名还在', only.brand === 'Rimefox' && only.p2.includes('译:'), only.p2);

  const bubble = (needle) =>
    until(() => pageEval(a, 'return Array.from(document.querySelectorAll(\'[data-dt-ui]\')).map((n) => n.textContent).find((t) => t.includes(' + JSON.stringify(needle) + ')) || ""'));
  await tabMsg(a.tabId, { type: 'dt:translateSelection', text: 'Paris CITE is the capital.' });
  const cite = await bubble('巴黎');
  check('划词：纯文本回复里的引注 [1] 不会顶替译文', cite && cite.includes('巴黎是首都[1]。'), cite);
  await tabMsg(a.tabId, { type: 'dt:translateSelection', text: 'SPLIT this into sentences please.' });
  const split = await bubble('Hello.');
  check('划词：拆成几句时句间有空格', split && split.includes('Hello. How are you?'), split);

  // 划词气泡「加入术语表」：两栏表单 → 后台 glossary:add → 配置；同名原文换了译法先问是否覆盖
  console.log('\n[加入术语表]');
  const cfgOf = () => swEval("return (await chrome.storage.local.get('config')).config;");
  const termOf = async (target) => {
    const cfg = await cfgOf();
    const list = cfg && Array.isArray(cfg.glossary) ? cfg.glossary : [];
    return list.find((one) => one.source === 'Rebranded term' && one.target === target) || null;
  };
  const fillTermForm = (target) =>
    pageEval(
      a,
      `const bubble = Array.from(document.querySelectorAll('[data-dt-ui]')).find((n) => n.textContent.includes('Glossary term goes here.'));
      if (!bubble) return 'no-bubble';
      const add = bubble.querySelector('span[aria-label="加入术语表"]');
      if (!add) return 'no-button';
      add.click();
      const inputs = Array.from(bubble.querySelectorAll('input'));
      if (inputs.length < 2) return 'no-form';
      inputs[0].value = 'Rebranded term';
      inputs[1].value = ` + JSON.stringify(target) + `;
      const save = Array.from(bubble.querySelectorAll('button')).find((n) => n.textContent === '保存');
      if (!save) return 'no-save';
      save.click();
      return 'clicked';`
    );

  await tabMsg(a.tabId, { type: 'dt:translateSelection', text: 'Glossary term goes here.' });
  await bubble('译:Glossary term goes here.');
  const firstTry = await fillTermForm('凛狐术语');
  const stored = await until(() => termOf('凛狐术语'), 8000);
  check('收录：原文和译法都能改，改完写进配置', firstTry === 'clicked' && !!stored, firstTry + ' / ' + JSON.stringify(stored));

  await tabMsg(a.tabId, { type: 'dt:translateSelection', text: 'Glossary term goes here.' });
  await bubble('译:Glossary term goes here.');
  const secondTry = await fillTermForm('另一个译法');
  const asked = await until(
    () =>
      pageEval(
        a,
        `const bubble = Array.from(document.querySelectorAll('[data-dt-ui]')).find((n) => n.textContent.includes('已有译法'));
        if (!bubble) return '';
        const ow = Array.from(bubble.querySelectorAll('button')).find((n) => n.textContent === '覆盖');
        return ow && ow.style.display !== 'none' ? 'asked' : '';`
      ),
    8000
  );
  check('同名原文不同译法：先问一句，没确认就不改', secondTry === 'clicked' && asked === 'asked', secondTry + ' / ' + asked);
  const notYet = await termOf('另一个译法');
  check('没点「覆盖」之前旧译法还在', !notYet && !!(await termOf('凛狐术语')), JSON.stringify(notYet));

  const confirmed = await pageEval(
    a,
    `const bubble = Array.from(document.querySelectorAll('[data-dt-ui]')).find((n) => n.textContent.includes('已有译法'));
    if (!bubble) return 'no-bubble';
    const ow = Array.from(bubble.querySelectorAll('button')).find((n) => n.textContent === '覆盖');
    if (!ow) return 'no-overwrite';
    ow.click();
    return 'clicked';`
  );
  const replaced = await until(() => termOf('另一个译法'), 8000);
  check('点「覆盖」后换成新译法', confirmed === 'clicked' && !!replaced && !(await termOf('凛狐术语')), confirmed + ' / ' + JSON.stringify(replaced));

  // 后面的设置页用例假设术语表是空的（它要验证「导入配置带着术语表一起进来」）：把这段留下的条目清掉
  await patchConfig({ glossary: [] });

  await tabMsg(a.tabId, { type: 'dt:toggle' });
  await sleep(600);
  const restored = await pageEval(a, `return { p1: document.getElementById('p1').textContent, p2: document.getElementById('p2').textContent, left: document.querySelectorAll('[data-dt-target],[data-dt-src],[data-dt-collapsed]').length }`);
  check(
    '还原：原文逐字恢复、没有残留标记',
    restored.p1 === 'This is the first paragraph of the article with enough words to translate.' && restored.p2 === 'Hello Rimefox world' && restored.left === 0,
    JSON.stringify(restored)
  );

  console.log('\n[缓存落盘]');
  await sleep(3200); // LIMITS.flushMs = 2500
  const keys = await swEval('return { s: Object.keys(await chrome.storage.session.get(null)), l: Object.keys(await chrome.storage.local.get(null)) };');
  check('session 区是分段格式', keys.s.includes('dt.cache.v1.s.index') && keys.s.some((k) => /^dt\.cache\.v1\.s\.\d+$/.test(k)) && !keys.s.includes('dt.cache.v1'), keys.s.filter((k) => k.startsWith('dt.cache')).join(','));
  check('local 区是分段格式', keys.l.includes('dt.cache.v1.l.index') && !keys.l.includes('dt.cache.v1'), keys.l.filter((k) => k.startsWith('dt.cache')).join(','));

  console.log('\n[配置广播]');
  const b = await openTab(ORIGIN + '/page.html?b');
  await tabMsg(b.tabId, { type: 'dt:toggle' });
  await until(() => pageEval(b, "return document.querySelectorAll('[data-dt-target]').length >= 3"));
  await settled(b);
  await patchConfig({ mode: 'translation' });
  await until(() => pageEval(b, "return document.documentElement.getAttribute('data-dt-mode') === 'translation' && document.querySelectorAll('[data-dt-replaced]').length >= 3"));
  await settled(b);
  const mixed = await pageEval(b, `return { mode: document.documentElement.getAttribute('data-dt-mode'), appended: document.querySelectorAll('[data-dt-target]').length, replaced: document.querySelectorAll('[data-dt-replaced]').length }`);
  check('别处改成仅译文：本页整页重建，不再混着追加的译文', mixed.mode === 'translation' && mixed.appended === 0 && mixed.replaced >= 3, JSON.stringify(mixed));
  await tabMsg(b.tabId, { type: 'dt:toggle' });

  console.log('\n[简繁]');
  await patchConfig({ targetLang: 'zh-TW', mode: 'dual' });
  await sleep(500);
  const c = await openTab(ORIGIN + '/simp.html');
  await tabMsg(c.tabId, { type: 'dt:toggle' });
  const hant = await until(() => pageEval(c, "const n = document.querySelector('#s1 [data-dt-target]'); return n ? n.textContent : ''"), 10000);
  check('简体页面选繁體中文：照常送翻并插入译文', hant && hant.startsWith('繁:'), hant || '没有译文');
  await tabMsg(c.tabId, { type: 'dt:toggle' });
  await patchConfig({ targetLang: 'zh-CN' });

  console.log('\n[思考参数]');
  check('reasoning_effort 被拒绝过之后不再发（首批并发的那几个除外）', stats.lateRejected === 0 && stats.withEffort < stats.requests, 'withEffort=' + stats.withEffort + ' late=' + stats.lateRejected + ' requests=' + stats.requests);
}

// ---------------- 设置页 ----------------

// ---------------- 0.9.1 段落单元 / Ruby / 悬停 ----------------
// 文献引用：上标引用当保留区。双语译文里放上标副本（可点击），仅译文原地不动，关闭翻译逐字还原
async function citationChecks() {
  console.log('\n[文献引用（Nature 上标）]');
  const cites = ['1,2', '3,4,5', '6,7,8,9', '7,10', '11,12,13,14'];
  const t = await openTab(ORIGIN + NATURE_PATH);
  const before = await pageEval(t, "return document.querySelector('.fx-nature').innerHTML");
  const originalSups = await pageEval(t, "return Array.from(document.querySelectorAll('.fx-nature p sup')).map((s) => s.outerHTML)");
  const sentBefore = stats.sent.length;
  await tabMsg(t.tabId, { type: 'dt:toggle' });
  const ready = await until(() => pageEval(t, "return document.querySelectorAll('.fx-nature p [data-dt-target] sup').length === 5"), 20000);
  await settled(t);
  const sent = stats.sent.slice(sentBefore).join('\n');
  check('请求：引用编号带 <kN> 标记随整句送翻，书目 title 不进请求', sent.includes('diseases<k1>1,2</k1>.') && sent.includes('significance<k2>3,4,5</k2>,') && !/Shendure|ebi\.ac\.uk/.test(sent), sent.slice(0, 160));
  check('请求：带标记的批次提示词要求不另写 / 合并 / 删引用编号', stats.keepSystem.includes('不要自己另写、合并或删掉引用编号'), stats.keepSystem ? '' : '没有带标记的请求');
  const dual = await pageEval(
    t,
    `const p = document.querySelector('.fx-nature p');
    const target = p.querySelector('[data-dt-target]');
    const clones = Array.from(target.querySelectorAll('sup'));
    const originals = Array.from(p.querySelectorAll('sup')).filter((s) => !target.contains(s));
    const hrefs = (list) => list.map((s) => Array.from(s.querySelectorAll('a')).map((a) => a.getAttribute('href')).join(' '));
    const ids = Array.from(document.querySelectorAll('[id]')).map((n) => n.id);
    return {
      texts: clones.map((s) => s.textContent),
      sameLinks: JSON.stringify(hrefs(clones)) === JSON.stringify(hrefs(originals)),
      cloneIds: target.querySelectorAll('[id]').length,
      dupIds: ids.length - new Set(ids).size,
      superscript: getComputedStyle(clones[0]).top === getComputedStyle(originals[0]).top,
      originals: originals.map((s) => s.outerHTML),
      head: target.textContent.slice(0, 12)
    };`
  );
  check('双语：译文里 5 组引用都是上标链接副本、顺序和编号不变', !!ready && JSON.stringify(dual.texts) === JSON.stringify(cites), JSON.stringify(dual.texts));
  check('双语：副本的链接和原上标一致、上标样式一致、没有重复 id', dual.sameLinks && dual.cloneIds === 0 && dual.dupIds === 0 && dual.superscript, JSON.stringify({ sameLinks: dual.sameLinks, cloneIds: dual.cloneIds, dupIds: dual.dupIds, sup: dual.superscript }));
  check('双语：原文段落的上标没被动过', JSON.stringify(dual.originals) === JSON.stringify(originalSups), '');
  const jump = await pageEval(
    t,
    `const link = document.querySelector('.fx-nature p [data-dt-target] a[href$="#ref-CR1"]');
    if (!link) return { hash: 'no-link' };
    link.click();
    return { hash: location.hash, still: document.querySelectorAll('.fx-nature p [data-dt-target]').length };`
  );
  check('双语：点译文里的引用跳到参考文献（同页，不重新加载）', jump.hash === '#ref-CR1' && jump.still === 1, JSON.stringify(jump));

  await tabMsg(t.tabId, { type: 'dt:setMode', mode: 'translation' });
  await until(() => pageEval(t, "return !!document.querySelector('.fx-nature p[data-dt-replaced]')"), 20000);
  await settled(t);
  const only = await pageEval(
    t,
    `const p = document.querySelector('.fx-nature p');
    const sups = Array.from(p.querySelectorAll('sup'));
    const link = p.querySelector('a[href="#ref-CR3"]');
    if (link) link.click();
    return { sups: sups.map((s) => s.outerHTML), target: !!p.querySelector('[data-dt-target]'), text: p.textContent.slice(0, 12), hash: location.hash, after: sups[0].nextSibling ? sups[0].nextSibling.nodeValue.slice(0, 8) : '' };`
  );
  check('仅译文：5 组上标链接原地不动（id / href / 编号都在），没有另插译文块', JSON.stringify(only.sups) === JSON.stringify(originalSups) && !only.target, '');
  check('仅译文：译文写在引用前后（句末引用后面接下一句的译文）', only.text.startsWith('译:') && only.after.replace(/\s+/g, '').startsWith('.译:'), JSON.stringify({ text: only.text, after: only.after }));
  check('仅译文：点原上标照常跳到参考文献', only.hash === '#ref-CR3', only.hash);

  await tabMsg(t.tabId, { type: 'dt:toggle' });
  const after = await until(() => pageEval(t, "return document.querySelector('[data-dt-target],[data-dt-replaced]') ? '' : document.querySelector('.fx-nature').innerHTML"), 8000);
  check('关闭翻译后 DOM 逐字还原', after === before, after === before ? '' : String(after || '').slice(0, 120));
}

// 混合行内内容（Science 段落：引用 + Fig. 1）：仅译文原地变成译文、链接节点和属性不变、图表标签写成「图 1」、真实点击；
// 双语放可点击副本；结构不支持的注音段落记成注入失败（不是跳过）；关闭后逐字还原
async function scienceMixedChecks() {
  console.log('\n[混合行内内容（Science 引用 + 图表链接）]');
  const t = await openTab(ORIGIN + '/science-mixed.html');
  const before = await pageEval(t, "return document.querySelector('.fx-science').innerHTML");
  const linksBefore = await pageEval(t, "return Array.from(document.querySelectorAll('#sci-mixed a')).map((a) => [a.getAttribute('href'), a.id, a.getAttribute('role')].join('|'))");
  const labels = ['10', '10', '12', '13', '16', '图 1', '16', '24', '25', '29'];

  await tabMsg(t.tabId, { type: 'dt:toggle' });
  const dualReady = await until(() => pageEval(t, "return document.querySelectorAll('#sci-mixed [data-dt-target] a').length === 10"), 20000);
  await settled(t);
  const dual = await pageEval(
    t,
    `const target = document.querySelector('#sci-mixed [data-dt-target]');
    const fig = target.querySelector('a[href="#F1"]');
    history.replaceState(null, '', location.pathname);
    fig.click();
    return { labels: Array.from(target.querySelectorAll('a')).map((a) => a.textContent), ids: target.querySelectorAll('[id]').length, hash: location.hash };`
  );
  check('双语：译文块里引用和图表链接是可点击的副本（无 id），图表标签「图 1」', !!dualReady && dual.ids === 0 && JSON.stringify(dual.labels) === JSON.stringify(labels) && dual.hash === '#F1', JSON.stringify(dual));

  await tabMsg(t.tabId, { type: 'dt:setMode', mode: 'translation' });
  const ready = await until(() => pageEval(t, "return !!document.querySelector('#sci-mixed[data-dt-replaced]') && !!document.querySelector('#sci-figonly[data-dt-replaced]')"), 20000);
  await settled(t);
  const only = await pageEval(
    t,
    `const p = document.getElementById('sci-mixed');
    const links = Array.from(p.querySelectorAll('a'));
    const fig = p.querySelector('a[href="#F1"]');
    const outside = [];
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!n.parentElement.closest('a') && n.nodeValue.trim()) outside.push(n.nodeValue);
    history.replaceState(null, '', location.pathname);
    fig.click();
    return {
      dual: !!document.querySelector('#sci-mixed [data-dt-target], #sci-figonly [data-dt-target]'),
      start: p.textContent.slice(0, 2),
      labels: links.map((a) => a.textContent),
      facts: links.map((a) => [a.getAttribute('href'), a.id, a.getAttribute('role')].join('|')),
      prefixed: outside.join('').indexOf('译:') >= 0,
      hash: location.hash,
      figonly: document.getElementById('sci-figonly').textContent.slice(0, 2)
    };`
  );
  check('仅译文：引用 + 图表链接的段落原地翻译，不退回双语（只有图表链接的段落也是）', !!ready && !only.dual && only.start === '译:' && only.figonly === '译:', JSON.stringify({ ready, dual: only.dual, start: only.start, figonly: only.figonly }));
  check('仅译文：引用和图表链接是原来的节点（href / id / role 不变），图表标签写成「图 1」，译文在链接外', JSON.stringify(only.facts) === JSON.stringify(linksBefore) && JSON.stringify(only.labels) === JSON.stringify(labels) && only.prefixed, JSON.stringify(only.labels));
  check('仅译文：点「图 1」跳到图表', only.hash === '#F1', only.hash);
  const status = await tabMsg(t.tabId, { type: 'dt:status' });
  check('注音 + 引用段落已成功重建，不再记成注入失败', !!status && status.renderFailed === 0 && !/unsafe-structure: ruby/.test(status.lastRenderError || ''), JSON.stringify(status && { renderFailed: status.renderFailed, lastRenderError: status.lastRenderError, skipped: status.skipped }));
  const rubyMixed = await pageEval(t, "const p = document.getElementById('sci-ruby'); const rt = p.querySelector('rt'); return { rendered: p.hasAttribute('data-dt-replaced'), target: !!p.querySelector('[data-dt-target]'), rt: rt && rt.textContent, ruby: !!p.querySelector('ruby'), link: !!p.querySelector('a[role=\"doc-biblioref\"]'), chineseRt: !!(rt && /[\u4e00-\u9fff]/.test(rt.textContent)) };");
  check('注音 + 引用：注音节点和引用保留，普通正文原地重建，中文不写进 rt', !!rubyMixed && rubyMixed.rendered && !rubyMixed.target && rubyMixed.ruby && rubyMixed.rt === 'くれがた' && !rubyMixed.chineseRt && rubyMixed.link, JSON.stringify(rubyMixed));
  const prewrap = await pageEval(t, "const p = document.getElementById('sci-prewrap'); const a = p.querySelectorAll('a'); return { rendered: p.hasAttribute('data-dt-replaced'), target: !!p.querySelector('[data-dt-target]'), newline: p.textContent.indexOf('\\n') >= 0, links: Array.from(a).map((x) => x.textContent), hrefs: Array.from(a).map((x) => x.getAttribute('href')) };");
  check('pre-wrap：文本节点里的硬换行保留，链接仍可点击且不退回双语', !!prewrap && prewrap.rendered && !prewrap.target && prewrap.newline && prewrap.links.length === 2 && prewrap.links[0] === '图 1' && prewrap.hrefs[0] === '#F1', JSON.stringify(prewrap));

  await tabMsg(t.tabId, { type: 'dt:toggle' });
  const after = await until(() => pageEval(t, "return document.querySelector('[data-dt-target],[data-dt-replaced]') ? '' : document.querySelector('.fx-science').innerHTML"), 8000);
  check('关闭翻译后 DOM 逐字还原', after === before, after === before ? '' : String(after || '').slice(0, 120));
}


// PMC 等价夹具：只有普通补充材料链接的段落，仅译文仍应原地翻译而不是双语回退
async function pmcChecks() {
  console.log('\n[PMC 普通补充材料链接]');
  await patchConfig({ targetLang: 'zh-CN', lazy: false, hoverCompare: false });
  const t = await openTab(ORIGIN + '/pmc.html');
  const before = await pageEval(t, "return document.querySelector('#pmc-ae').innerHTML");
  await tabMsg(t.tabId, { type: 'dt:toggle' });
  await until(() => pageEval(t, "return !!document.querySelector('#pmc-ae [data-dt-target]')"), 20000);
  await tabMsg(t.tabId, { type: 'dt:setMode', mode: 'translation' });
  const ready = await until(() => pageEval(t, "return !!document.querySelector('#pmc-ae[data-dt-replaced]')"), 20000);
  await settled(t);
  const out = await pageEval(
    t,
    `const p = document.getElementById('pmc-ae');
    const a = p.querySelector('#pmc-supp-link');
    return {
      ready: p.hasAttribute('data-dt-replaced'),
      dual: !!p.querySelector('[data-dt-target]'),
      label: a && a.textContent,
      href: a && a.getAttribute('href'),
      same: a === document.querySelector('#pmc-supp-link'),
      text: p.textContent.slice(0, 120)
    };`
  );
  check('PMC 普通链接：仅译文原地翻译、没有双语回退，链接标签和 href 保留', !!ready && !!out && out.ready && !out.dual && out.same && out.label === '补充材料 3' && out.href === '#pmc-supp-3', JSON.stringify(out));
  await tabMsg(t.tabId, { type: 'dt:toggle' });
  const after = await until(() => pageEval(t, "return document.querySelector('[data-dt-target],[data-dt-replaced]') ? '' : document.querySelector('#pmc-ae').innerHTML"), 8000);
  check('PMC 普通链接：关闭翻译后原文逐字还原', after === before, after === before ? '' : String(after || '').slice(0, 120));
}


// RTL 页面 -> LTR 目标 / LTR 页面 -> RTL 目标：检查真实扩展管线的 dir 与计算样式

// 中国全科医学 RichHTML：医学专业模式 + 中文→英文仅译文；检查无 linkFallback 双语、无自身 mutation 循环
async function chinagpChecks() {
  console.log('\n[中国全科医学 RichHTML]');
  await patchConfig({
    targetLang: 'en',
    mode: 'translation',
    lazy: false,
    hoverCompare: false,
    dockEnabled: false,
    professionalProfile: 'medical',
    medicalMode: true,
    professionalOptions: { quality: 'fast', subdomain: 'auto', maxReviewRequests: 0 }
  });
  const t = await openTab(ORIGIN + '/chinagp.html');
  await contentEval(t, 'window.__DT.debugReset()');
  await tabMsg(t.tabId, { type: 'dt:toggle' });
  const ready = await until(() => pageEval(t, "return !!document.querySelector('#gp-p[data-dt-replaced]') && !!document.querySelector('#gp-heading[data-dt-replaced]')"), 20000);
  await settled(t);
  const first = await contentEval(t, `(() => {
    const p = document.getElementById('gp-p');
    const links = Array.from(p.querySelectorAll('a'));
    return {
      dual: !!p.querySelector('[data-dt-target]'),
      links: links.map((a) => [a.getAttribute('href'), a.textContent].join('|')),
      text: p.textContent.slice(0, 80),
      stats: window.__DT.debugSnapshot()
    };
  })()`);
  const requestsBefore = stats.requests;
  await sleep(2200);
  const second = await contentEval(t, "(() => ({ stats: window.__DT.debugSnapshot(), dual: !!document.querySelector('#gp-p [data-dt-target]'), replaced: document.querySelectorAll('#gp-p[data-dt-replaced]').length }))()");
  check('中国全科医学：稳定正文不重复请求模型', stats.requests === requestsBefore, JSON.stringify({ before: requestsBefore, after: stats.requests }));
  check('中国全科医学：医学 + 仅译文中文→英文，[8]/［9］/补充材料链接保留，无双语块', !!ready && !first.dual && first.links.length === 3 && first.links[0].indexOf('#gp-ref8') === 0 && first.links[1].indexOf('#gp-ref9') === 0 && first.links[2].indexOf('#gp-supp') === 0, JSON.stringify(first));
  check('中国全科医学：稳定正文运行多轮观察后不 startOver / restore / 重复双语', second.stats.stats.startOverCount === 0 && second.stats.stats.restoreCount === 0 && second.stats.stats.injectDualCount === 0 && second.stats.stats.linkFallbackCount === 0 && !second.dual && second.replaced === 1, JSON.stringify(second.stats));
  // 动态导航：只改无关节点，不应导致全页 startOver/restore。
  const navRequests = stats.requests;
  await pageEval(t, "const n=document.getElementById('gp-nav'); const s=document.createElement('span'); s.setAttribute('data-nav','1'); n.appendChild(s); return true;");
  await sleep(1400);
  const afterNav = await contentEval(t, "window.__DT.debugSnapshot()");
  check('中国全科医学：无关导航节点更新不重新请求正文', stats.requests === navRequests, JSON.stringify({ before: navRequests, after: stats.requests }));
  check('中国全科医学：动态导航更新只做增量补扫，不撤销已翻译正文', afterNav.stats.startOverCount === 0 && afterNav.stats.restoreCount === 0 && afterNav.stats.injectDualCount === 0, JSON.stringify(afterNav));
  await tabMsg(t.tabId, { type: 'dt:toggle' });
  await until(() => pageEval(t, "return !document.querySelector('[data-dt-target],[data-dt-replaced]')"), 10000);
  await patchConfig({ targetLang: 'zh-CN', mode: 'dual', professionalProfile: 'general', medicalMode: false, professionalOptions: { quality: 'balanced', subdomain: 'auto', maxReviewRequests: 1 } });
}


async function koreanBoldChecks() {
  console.log('\n[韩文样式边界]');
  await patchConfig({ targetLang: 'zh-CN', mode: 'translation', lazy: false, hoverCompare: false, dockEnabled: false });
  const t = await openTab(ORIGIN + '/korean-bold.html');
  const before = await pageEval(t, "return { start: document.getElementById('bold-start').innerHTML, whole: document.getElementById('whole-strong').innerHTML };");
  await tabMsg(t.tabId, { type: 'dt:toggle' });
  await until(() => pageEval(t, "return !!document.querySelector('#bold-start[data-dt-replaced]') && !!document.querySelector('#whole-heading[data-dt-replaced]')"), 20000);
  await settled(t);
  const styles = await pageEval(t, `return (function(){
    function info(id){
      var el=document.getElementById(id); if(!el) return null;
      var w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT); var node=null;
      for(var n=w.nextNode();n;n=w.nextNode()){ if(/\\S/.test(n.nodeValue)){ node=n; break; } }
      if(!node) return { text:'', weight:0, style:'', parent:'' };
      var parent=node.parentElement || el; var cs=getComputedStyle(parent);
      return { text:node.nodeValue.slice(0,30), weight:parseInt(cs.fontWeight,10), style:cs.fontStyle, family:cs.fontFamily, size:cs.fontSize, line:cs.lineHeight, color:cs.color, parent:parent.tagName };
    }
    return { start: info('bold-start'), mid: info('bold-mid'), end: info('bold-end'), span: info('bold-span'), b: info('bold-b'), medium: info('bold-medium'), family: info('bold-family'), em: info('bold-em'), multi: info('multi-bold'), nested: info('nested-bold'), prewrap: info('prewrap'), whole: info('whole-strong'), heading: info('whole-heading'), link: info('link-strong'), linkCount: document.querySelectorAll('#link-strong a[href="#ref-1"]').length };
  })()`);
  const loaded = await contentEval(t, "({ version: window.__DT.VERSION, styleBoundaryAware: window.__DT.styleBoundaryAware, inspect: typeof window.__DT.inspectTextStyle })");
  check('实际加载的扩展脚本：版本与 manifest 一致且包含样式边界修复 / 诊断器', loaded.version === VERSION && loaded.styleBoundaryAware === 1 && loaded.inspect === 'function', JSON.stringify(loaded));
  const fontApi = await contentEval(t, "(function(){var f=window.__DT.fonts;var el=document.getElementById('font-foreign');return {zh:!!f.stackFor('zh-CN','chosun-myeongjo, serif'),tw:!!f.stackFor('zh-TW','chosun-myeongjo, serif'),ja:!!f.stackFor('ja','Noto Sans KR'),ko:!!f.stackFor('ko','PingFang SC, sans-serif'),native:!!f.stackFor('zh-CN','PingFang SC, sans-serif'),sc:!f.stackFor('zh-CN','NotoSansSC, sans-serif'),krBold:!!f.stackFor('zh-CN','NotoSansKR-Bold, sans-serif'),generic:!!f.stackFor('zh-CN','Georgia, serif'),dual:f.policy({mode:'dual',target:'zh-CN',sourceElement:el}).adapt,translation:f.policy({mode:'translation',target:'zh-CN',sourceElement:el}).adapt};})()");
  check('目标语言字体：中简 / 中繁 / 日 / 韩档案与兼容性判定可扩展', fontApi.zh && fontApi.tw && fontApi.ja && fontApi.ko && fontApi.sc && fontApi.krBold && !fontApi.native && !fontApi.generic && !fontApi.dual && fontApi.translation, JSON.stringify(fontApi));
  const futureFont = await contentEval(t, "(function(){var f=window.__DT.fonts;var ok=f.register('th',{compatible:/thai/i,foreign:/myeongjo/i,stack:'\"Noto Sans Thai\", sans-serif'});return {ok:ok,stack:!!f.stackFor('th-TH','chosun-myeongjo, serif')};})()");
  check('目标语言字体：register 接口可扩展其他文字系统', futureFont.ok && futureFont.stack, JSON.stringify(futureFont));
  const inspect = await contentEval(t, "window.__DT.inspectTextStyle('译:', 12)");
  const affected = (inspect.matches || []).find(function (m) { return m.before && m.before.sourceHtml && m.before.sourceHtml.indexOf('<strong>') >= 0 && m.style && parseInt(m.style.fontWeight, 10) < 600; });
  check('样式诊断：记录写入前 DOM / 祖先链 / computed font-weight，并显示局部强调未污染整段', !!affected && affected.before.chain.some(function (x) { return x && parseInt(x.fontWeight, 10) >= 600; }) && affected.afterHtml.indexOf('strong') >= 0, JSON.stringify(affected && { parent: affected.parent, before: affected.before.chain[0], after: affected.chain[0] }));
  function normal(x){ return x && x.weight > 0 && x.weight < 600; }
  check('韩文仅译文：段首局部 strong / b / 粗体 span 不会让整段译文变粗', normal(styles.start) && normal(styles.span) && normal(styles.b) && normal(styles.medium) && normal(styles.family) && styles.family.family.indexOf('Arial Black') < 0 && styles.em && styles.em.style === 'normal', JSON.stringify(styles));
  check('韩文仅译文：中间 / 段末强调、链接引用不会污染整段字重', normal(styles.mid) && normal(styles.end) && normal(styles.link) && styles.linkCount === 1, JSON.stringify(styles));
  check('韩文仅译文：多行段落第一行局部 strong 也不污染整行', normal(styles.multi), JSON.stringify(styles.multi));
  check('韩文仅译文：嵌套 strong/em 与 pre-wrap 局部强调仍保持正文基准字重', normal(styles.nested) && normal(styles.prewrap), JSON.stringify({ nested: styles.nested, prewrap: styles.prewrap }));
  check('韩文仅译文：整段加粗公告和整段加粗标题继续保持粗体', styles.whole && styles.whole.weight >= 600 && styles.heading && styles.heading.weight >= 600, JSON.stringify({ whole: styles.whole, heading: styles.heading }));
  const font = await pageEval(t, `return (function(){
    function info(id){var p=document.getElementById(id);var w=document.createTreeWalker(p,NodeFilter.SHOW_TEXT);var n=null;for(var x=w.nextNode();x;x=w.nextNode()){if(x.nodeValue.trim()){n=x;break;}}var wrap=p.querySelector('.dt-font');var pe=n&&n.parentElement;var pc=getComputedStyle(p);var wc=wrap?getComputedStyle(wrap):null;return {sourceFamily:pc.fontFamily,sourceWeight:pc.fontWeight,sourceSize:pc.fontSize,sourceLine:pc.lineHeight,sourceColor:pc.color,wrappers:p.querySelectorAll('.dt-font').length,parent:pe&&pe.tagName,targetFamily:wc&&wc.fontFamily,targetWeight:wc&&wc.fontWeight,targetSize:wc&&wc.fontSize,targetLine:wc&&wc.lineHeight,targetColor:wc&&wc.color};}
    return {foreign:info('font-foreign'),native:info('font-native'),heading:info('font-heading'),emphasis:info('font-emphasis')};
  })()`);
  check('目标语言字体：韩文字体显示中文时只给译文加中文字体栈', font.foreign.wrappers > 0 && /PingFang SC|Microsoft YaHei|Noto Sans CJK SC/.test(font.foreign.targetFamily) && /AppleMyungjo/.test(font.foreign.sourceFamily), JSON.stringify(font.foreign));
  check('目标语言字体：保留字号 / 字重 / 行高 / 颜色', font.foreign.targetWeight === font.foreign.sourceWeight && font.foreign.targetSize === font.foreign.sourceSize && font.foreign.targetLine === font.foreign.sourceLine && font.foreign.targetColor === font.foreign.sourceColor, JSON.stringify(font.foreign));
  check('目标语言字体：已兼容中文字体、标题不替换', font.native.wrappers === 0 && font.heading.wrappers === 0, JSON.stringify({ native: font.native, heading: font.heading }));
  check('目标语言字体：真正的整段强调保持粗体，只适配字体族', font.emphasis.wrappers > 0 && font.emphasis.targetWeight === '700' && /AppleMyungjo/.test(font.emphasis.sourceFamily), JSON.stringify(font.emphasis));
  const reqBefore = stats.requests;
  const fontCountBefore = await pageEval(t, "return document.querySelectorAll('.dt-font').length");
  await sleep(800);
  const fontCountAfter = await pageEval(t, "return document.querySelectorAll('.dt-font').length");
  check('目标语言字体：字体壳不会触发重复扫描 / 重译 / 重复包裹', stats.requests === reqBefore && fontCountAfter === fontCountBefore, JSON.stringify({ requests: [reqBefore, stats.requests], fonts: [fontCountBefore, fontCountAfter] }));
  await tabMsg(t.tabId, { type: 'dt:toggle' });
  const restored = await pageEval(t, "return (function(){var f=document.getElementById('font-foreign');var c=getComputedStyle(f);return {start:document.getElementById('bold-start').innerHTML,whole:document.getElementById('whole-strong').innerHTML,fontWrappers:document.querySelectorAll('.dt-font').length,fontFamily:c.fontFamily,fontSize:c.fontSize,fontWeight:c.fontWeight,lineHeight:c.lineHeight,color:c.color};})()");
  check('韩文仅译文：关闭翻译后逐字恢复原文和强调结构', restored.start === before.start && restored.whole === before.whole, JSON.stringify({ before, restored }));
  check('韩文仅译文：关闭翻译后字体包装和字体属性完整恢复', restored.fontWrappers === 0 && /AppleMyungjo/.test(restored.fontFamily) && restored.fontSize === '18px' && restored.fontWeight === '400' && restored.lineHeight === '30.6px' && restored.color === 'rgb(20, 30, 40)', JSON.stringify(restored));

  await patchConfig({ mode: 'dual' });
  await tabMsg(t.tabId, { type: 'dt:toggle' });
  await until(() => pageEval(t, "return !!document.querySelector('#bold-start .dt-target')"), 20000);
  const dual = await pageEval(t, "var n=document.querySelector('#bold-start .dt-target'); var c=getComputedStyle(n); return { weight:parseInt(c.fontWeight,10), sourceWeight:parseInt(getComputedStyle(document.querySelector('#bold-start strong')).fontWeight,10) };");
  check('韩文双语：目标译文保持正文基准字重，原文强调仍保留', dual.weight < 600 && dual.sourceWeight >= 600, JSON.stringify(dual));
  const dualFont = await pageEval(t, "return (function(){var p=document.getElementById('font-foreign');var t=p.querySelector('.dt-target');var pc=getComputedStyle(p);var tc=t?getComputedStyle(t):null;return {wrappers:p.querySelectorAll('.dt-font:not([data-dt-target])').length,sourceFamily:pc.fontFamily,targetFamily:tc&&tc.fontFamily,sourceWeight:pc.fontWeight,targetWeight:tc&&tc.fontWeight,sourceSize:pc.fontSize,targetSize:tc&&tc.fontSize,sourceLine:pc.lineHeight,targetLine:tc&&tc.lineHeight};})()");
  check('韩文双语：恢复原站字体策略，不把仅译文字体壳塞进双语目标', dualFont.wrappers === 0 && /AppleMyungjo/.test(dualFont.sourceFamily) && /AppleMyungjo/.test(dualFont.targetFamily) && dualFont.sourceWeight === '400' && dualFont.targetWeight === '400' && dualFont.sourceSize === dualFont.targetSize && dualFont.sourceLine === dualFont.targetLine, JSON.stringify(dualFont));
  const dualHeading = await pageEval(t, "return (function(){var h=document.getElementById('font-heading');var t=h.querySelector('.dt-target');var hc=getComputedStyle(h);var tc=t?getComputedStyle(t):null;return {sourceSize:hc.fontSize,targetSize:tc&&tc.fontSize,sourceLine:hc.lineHeight,targetLine:tc&&tc.lineHeight,heading:!!t&&t.classList.contains('dt-cjk-heading'),family:tc&&tc.fontFamily};})()");
  check('韩文双语：CJK 大标题缩放和响应式行高仍生效', dualHeading.sourceSize === '40px' && dualHeading.targetSize === '32px' && dualHeading.heading && /AppleMyungjo/.test(dualHeading.family), JSON.stringify(dualHeading));
  await pageEval(t, "document.documentElement.setAttribute('data-dt-typo','on');document.documentElement.style.setProperty('--dt-font-scale','1.25');document.documentElement.style.setProperty('--dt-line-height','2');return true;");
  await sleep(100);
  const typo = await pageEval(t, "var p=document.getElementById('font-foreign');var t=p.querySelector('.dt-target');var c=t?getComputedStyle(t):null;return {size:c&&c.fontSize,line:c&&c.lineHeight,family:c&&c.fontFamily};");
  check('韩文双语：用户自定义译文字号 / 行高仍覆盖目标译文', typo.size === '22.5px' && typo.line === '45px' && /AppleMyungjo/.test(typo.family), JSON.stringify(typo));
  await pageEval(t, "document.documentElement.removeAttribute('data-dt-typo');document.documentElement.style.removeProperty('--dt-font-scale');document.documentElement.style.removeProperty('--dt-line-height');return true;");

  // 模式热切换完整链路：双语开启 -> 仅译文 -> 双语 -> 关闭。
  await patchConfig({ mode: 'translation' });
  await until(() => pageEval(t, "return !!document.querySelector('#font-foreign[data-dt-replaced]') && !document.querySelector('#font-foreign .dt-target')"), 20000);
  await settled(t);
  const hotOnly = await pageEval(t, "return (function(){var p=document.getElementById('font-foreign');var f=p.querySelector('.dt-font');var c=getComputedStyle(p);var fc=f?getComputedStyle(f):null;return {targets:p.querySelectorAll('.dt-target').length,fonts:p.querySelectorAll('.dt-font').length,sourceFamily:c.fontFamily,targetFamily:fc&&fc.fontFamily,size:fc&&fc.fontSize,line:fc&&fc.lineHeight};})()");
  check('韩文模式热切换：双语 -> 仅译文不残留双语节点，字体壳生效', hotOnly.targets === 0 && hotOnly.fonts > 0 && /PingFang SC|Microsoft YaHei|Noto Sans CJK SC/.test(hotOnly.targetFamily) && /AppleMyungjo/.test(hotOnly.sourceFamily), JSON.stringify(hotOnly));

  await patchConfig({ mode: 'dual' });
  await until(() => pageEval(t, "return !!document.querySelector('#font-foreign .dt-target') && !document.querySelector('#font-foreign .dt-font')"), 20000);
  await settled(t);
  const hotDual = await pageEval(t, "return (function(){var p=document.getElementById('font-foreign');var t=p.querySelector('.dt-target');var c=getComputedStyle(p);var tc=t?getComputedStyle(t):null;return {targets:p.querySelectorAll('.dt-target').length,fonts:p.querySelectorAll('.dt-font').length,sourceFamily:c.fontFamily,targetFamily:tc&&tc.fontFamily,size:tc&&tc.fontSize,sourceSize:c.fontSize};})()");
  check('韩文模式热切换：仅译文 -> 双语恢复原站字体和字号', hotDual.targets > 0 && hotDual.fonts === 0 && /AppleMyungjo/.test(hotDual.targetFamily) && hotDual.size === hotDual.sourceSize, JSON.stringify(hotDual));

  await tabMsg(t.tabId, { type: 'dt:toggle' });

  await patchConfig({ mode: 'translation' });
  await tabMsg(t.tabId, { type: 'dt:toggle' });
  await until(() => pageEval(t, "return !!document.querySelector('#bold-start[data-dt-replaced]')"), 20000);
  const again = await pageEval(t, "return (function(){var el=document.getElementById('bold-start'); var w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT); for(var n=w.nextNode();n;n=w.nextNode()){ if(/\\S/.test(n.nodeValue)){ return parseInt(getComputedStyle(n.parentElement).fontWeight,10); } } return 0;})()");
  check('韩文仅译文：还原后再次翻译仍不随机加粗', again > 0 && again < 600, 'weight=' + again);
  await tabMsg(t.tabId, { type: 'dt:toggle' });
  const finalClean = await pageEval(t, "return {fonts:document.querySelectorAll('.dt-font,[data-dt-font]').length,replaced:document.querySelectorAll('[data-dt-replaced]').length,targets:document.querySelectorAll('[data-dt-target]').length,family:getComputedStyle(document.getElementById('font-foreign')).fontFamily};");
  check('韩文模式循环：关闭后字体壳 / 标记归零，原文韩文字体恢复', finalClean.fonts === 0 && finalClean.replaced === 0 && finalClean.targets === 0 && /AppleMyungjo/.test(finalClean.family), JSON.stringify(finalClean));
  await patchConfig({ targetLang: 'zh-CN', mode: 'dual', dockEnabled: false });
}

async function directionChecks() {
  console.log('\n[双向文字排版]');
  await patchConfig({ targetLang: 'zh-CN', mode: 'translation', lazy: false, hoverCompare: false, dockEnabled: false });
  let t = await openTab(ORIGIN + '/direction.html');
  await tabMsg(t.tabId, { type: 'dt:toggle' });
  const ready = await until(() => pageEval(t, "return !!document.querySelector('#dir-ar[data-dt-replaced]') && !!document.querySelector('#dir-links[data-dt-replaced]')"), 20000);
  await settled(t);
  const zh = await pageEval(t, `const ar = document.getElementById('dir-ar');
    const links = document.getElementById('dir-links');
    const center = document.getElementById('dir-center');
    return {
      arDir: ar.getAttribute('dir'), arComputed: getComputedStyle(ar).direction, arAlign: getComputedStyle(ar).textAlign,
      linksDir: links.getAttribute('dir'), linksComputed: getComputedStyle(links).direction,
      centerAlign: getComputedStyle(center).textAlign,
      dual: !!document.querySelector('#dir-ar [data-dt-target]'),
      text: ar.textContent.slice(0, 30)
    };`);
  check('阿拉伯语 RTL → 中文 LTR：完整段落、混合链接段落和起始对齐都变成 LTR', !!ready && zh.arDir === 'ltr' && zh.arComputed === 'ltr' && zh.arAlign === 'start' && zh.linksDir === 'ltr' && zh.linksComputed === 'ltr' && !zh.dual, JSON.stringify(zh));
  check('居中标题保留居中，不被目标方向强制改成左对齐', zh.centerAlign === 'center', zh.centerAlign);
  await tabMsg(t.tabId, { type: 'dt:toggle' });
  await until(() => pageEval(t, "return document.querySelector('#dir-ar[data-dt-replaced]') ? '' : 'restored'"), 8000);

  await patchConfig({ targetLang: 'ar' });
  t = await openTab(ORIGIN + '/direction.html');
  await tabMsg(t.tabId, { type: 'dt:toggle' });
  const readyRtl = await until(() => pageEval(t, "return !!document.querySelector('#dir-en[data-dt-replaced]')"), 20000);
  await settled(t);
  const rtl = await pageEval(t, "const p = document.getElementById('dir-en'); return { dir: p.getAttribute('dir'), computed: getComputedStyle(p).direction, target: !!p.querySelector('[data-dt-target]') };");
  check('英语 LTR → 阿拉伯语 RTL：目标段落从右到左显示，原文方向被正确替换', !!readyRtl && rtl.dir === 'rtl' && rtl.computed === 'rtl' && !rtl.target, JSON.stringify(rtl));
  await tabMsg(t.tabId, { type: 'dt:toggle' });
  // 后续语言用例从默认双语模式开始；不要把 translation 留在配置里。
  await patchConfig({ targetLang: 'zh-CN', mode: 'dual', dockEnabled: false });
}

async function paragraphChecks() {
  console.log('\n[段落单元 / Ruby]');

  // 青空文库式：一个容器里连续 <br> 分段
  const a = await openTab(ORIGIN + '/aozora.html');
  const before = await pageEval(a, "return document.getElementById('mt').innerHTML");
  await tabMsg(a.tabId, { type: 'dt:toggle' });
  const ready = await until(() => pageEval(a, "return document.querySelectorAll('#mt [data-dt-target]').length === 3"), 20000);
  await settled(a);
  check('青空文库：3 个段落各有一个译文节点', !!ready, ready);

  const layout = await pageEval(a, "return Array.from(document.getElementById('mt').childNodes).map(function (n) {\n    if (n.nodeType === 3) return n.nodeValue.trim() ? 'T' : '';\n    if (n.tagName === 'BR') return 'BR';\n    if (n.hasAttribute('data-dt-target')) return n.textContent.indexOf('译:') === 0 ? 'TGT' : 'TGT:' + n.textContent.slice(0, 12);\n    return 'X';\n  }).filter(Boolean)");
  const seqOk = JSON.stringify(layout) === JSON.stringify(['T', 'TGT', 'BR', 'BR', 'T', 'TGT', 'BR', 'BR', 'T', 'TGT']);
  check('青空文库：译文跟在各自段落后面，不堆到页面末尾', seqOk, JSON.stringify(layout));

  const recollect = await contentEval(a, "window.__DT.collect(document.getElementById('mt')).length");
  check('青空文库：已翻译段落不会被重复收集', recollect === 0, recollect);

  const hover = await contentEval(a, "(function () {\n    var t = document.querySelectorAll('#mt [data-dt-target]')[1];\n    if (!t || !t.firstChild) return { error: 'no-target' };\n    var r = document.createRange();\n    r.setStart(t.firstChild, 1);\n    r.setEnd(t.firstChild, Math.min(4, t.firstChild.nodeValue.length));\n    var rect = r.getBoundingClientRect();\n    window.__DT.hover.updateAt(rect.left + 1, rect.top + 1, t.firstChild);\n    var src = CSS.highlights.get('dt-hover-src');\n    var tgt = CSS.highlights.get('dt-hover-target');\n    var tip = document.querySelector('.dt-hover-tip');\n    return {\n      src: src ? Array.from(src).map(function (x) { return x.toString(); }).join('|') : '',\n      tgt: tgt ? Array.from(tgt).map(function (x) { return x.toString(); }).join('|') : '',\n      tip: tip && !tip.hidden ? tip.innerText : ''\n    };\n  })()");
  const alignInfo = await contentEval(a, "(function () {\n    var t = document.querySelectorAll('#mt [data-dt-target]')[1];\n    var u = window.__DT.unitOfNode(t.firstChild);\n    return { align: !!(u && u.align), want: !!(u && u.wantAlign), sentences: u ? u.sentences.length : -1, ali: u && u.ali ? u.ali.length : -1, first: u && u.ali ? u.ali[0] : null };\n  })()");
  check('青空文库·对齐：结构化 parts 通过校验（句级映射可用）', alignInfo && alignInfo.align, JSON.stringify(alignInfo));
  check('青空文库·请求：align 模式提示词确实发给模型', stats.aligned > 0, 'aligned=' + stats.aligned);
  check('青空文库·悬停：译文上只高亮这一句和对应原文，双语模式不弹气泡', !!hover && hover.tgt && hover.src && !hover.tip, JSON.stringify(hover));

  await tabMsg(a.tabId, { type: 'dt:toggle' });
  const after = await pageEval(a, "return document.getElementById('mt').innerHTML");
  check('青空文库：关闭翻译后原文逐字恢复', after === before, after === before ? '' : (after || '').slice(0, 120));

  // Pixiv 式：pre-wrap 容器 + span/<br> 对白 + Ruby
  const b = await openTab(ORIGIN + '/pixiv.html');
  const pixivBefore = await pageEval(b, "return document.getElementById('novel').innerHTML");
  await tabMsg(b.tabId, { type: 'dt:toggle' });
  await until(() => pageEval(b, "return document.querySelectorAll('#novel [data-dt-target]').length >= 3"), 20000);
  await settled(b);

  await tabMsg(b.tabId, { type: 'dt:setMode', mode: 'translation' });
  const rubyReady = await until(() => pageEval(b, "return document.querySelectorAll('#np2 [data-dt-rt-hidden]').length === 1"), 20000);
  await settled(b);
  const ruby = await pageEval(b, "return (function () {\n    var p = document.getElementById('np2');\n    var rt = p.querySelector('rt');\n    return {\n      hidden: !!rt && getComputedStyle(rt).display === 'none',\n      text: p.innerText,\n      rubyText: p.querySelector('ruby') ? p.querySelector('ruby').textContent : '',\n      target: (p.querySelector('[data-dt-target]') || {}).textContent || ''\n    };\n  })()");
  check('Pixiv·仅译文：Ruby 注音被隐藏，译文不写进 ruby', !!rubyReady && ruby.hidden && !/らしょうもん|あめ/.test(ruby.text) && ruby.rubyText.indexOf('译:') < 0, JSON.stringify(ruby));
  check('Pixiv·仅译文：译文显示在段落位置', ruby.target.startsWith('译:') && ruby.text.indexOf('译:') >= 0, JSON.stringify(ruby));

  await tabMsg(b.tabId, { type: 'dt:toggle' });
  const pixivAfter = await pageEval(b, "return document.getElementById('novel').innerHTML");
  check('Pixiv：关闭翻译后 Ruby / 结构逐字恢复', pixivAfter === pixivBefore, pixivAfter === pixivBefore ? '' : (pixivAfter || '').slice(0, 160));
}


// 悬停对照：模型没有给结构化对齐时，本地对齐仍然逐句高亮（0.9.3）
async function hoverLocalChecks() {
  console.log('\n[悬停·本地对齐]');
  const tab = await openTab(ORIGIN + '/owid.html');
  await tabMsg(tab.tabId, { type: 'dt:toggle' });
  const ready = await until(() => pageEval(tab, "return !!document.querySelector('#ow [data-dt-target]')"), 20000);
  await settled(tab);
  check('OWID：段落已翻译', !!ready, ready);
  const probe = (word, onTarget) =>
    contentEval(
      tab,
      "(function () {\n" +
        "  var el = document.getElementById('ow');\n" +
        "  var t = el.querySelector('[data-dt-target]');\n" +
        "  var node = " + (onTarget ? 't.firstChild' : 'el.firstChild') + ";\n" +
        "  var i = node.nodeValue.indexOf(" + JSON.stringify(word) + ");\n" +
        "  var r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 1);\n" +
        "  var rect = r.getBoundingClientRect();\n" +
        "  window.__DT.hover.clear();\n" +
        "  window.__DT.hover.updateAt(rect.left + 2, rect.top + rect.height / 2, node);\n" +
        "  var u = window.__DT.unitOfNode(el.firstChild);\n" +
        "  var get = function (name) { var h = CSS.highlights.get(name); return h ? Array.from(h).map(function (x) { return x.toString(); }).join('|') : ''; };\n" +
        "  var tip = document.querySelector('.dt-hover-tip');\n" +
        "  return { align: !!(u && u.align), sentences: u ? u.sentences.length : -1, src: get('dt-hover-src'), tgt: get('dt-hover-target'), tip: tip && !tip.hidden ? tip.innerText : '' };\n" +
        "})()"
    );
  const onSrc = await probe('starting point', false);
  check('OWID·悬停：没有模型对齐（只回了字符串）', onSrc && !onSrc.align && onSrc.sentences === 4, JSON.stringify(onSrc && { align: onSrc.align, sentences: onSrc.sentences }));
  check(
    'OWID·悬停：原文第三句只高亮这一句（到脚注号为止）和对应译文，不是整段',
    !!onSrc && onSrc.src.indexOf('The starting point') === 0 && /home\.11$/.test(onSrc.src) && onSrc.tgt.indexOf('每条轨迹') === 0 && onSrc.tgt.indexOf('自那时起') < 0,
    JSON.stringify(onSrc && { src: onSrc.src.slice(0, 30) + '…' + onSrc.src.slice(-12), tgt: onSrc.tgt.slice(0, 12) + '…' + onSrc.tgt.slice(-8) })
  );
  check('OWID·悬停：双语模式不弹「行级对应」气泡', !!onSrc && !onSrc.tip, onSrc && onSrc.tip);
  const onTgt = await probe('横轴', true);
  check(
    'OWID·悬停：译文第二句对回原文第二句',
    !!onTgt && onTgt.src.indexOf('On the horizontal axis') === 0 && onTgt.tgt.indexOf('每张图表') === 0 && !onTgt.tip,
    JSON.stringify(onTgt && { src: onTgt.src.slice(0, 24), tgt: onTgt.tgt.slice(0, 12), tip: onTgt.tip })
  );
  await tabMsg(tab.tabId, { type: 'dt:toggle' });
}

// ---------------- 真实青空文库《罗生门》验收（--aozora-live [url]） ----------------
async function captureScreenshot(tab, file, clip) {
  const params = { format: 'png', captureBeyondViewport: true };
  if (clip) params.clip = clip;
  const shot = await send('Page.captureScreenshot', params, tab.s);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
}

async function liveAozoraChecks(url) {
  console.log('\n[真实青空文库] ' + url);
  stats.aozoraLive = true;
  const tag = path.basename(ROOT);
  const outDir = path.join(process.cwd(), 'docs', 'verification', '2026-10-19-aozora-roshomon');
  const tab = await openTab(url);
  const ready = await until(() => pageEval(tab, "return !!document.querySelector('.main_text')"), 30000);
  check('真实页面：找到 .main_text', !!ready);
  const before = await pageEval(tab, "return (function(){var mt=document.querySelector('.main_text');return {html:mt.innerHTML,height:Math.round(mt.getBoundingClientRect().height),brs:mt.querySelectorAll('br').length,rubies:mt.querySelectorAll('ruby').length,rts:mt.querySelectorAll('rt').length};})()");
  const collect = await contentEval(tab, "(function(){var mt=document.querySelector('.main_text');var us=window.__DT.collect(mt);return {count:us.length,brs:mt.querySelectorAll('br').length,units:us.map(function(u){return {len:u.text.length,index:u.index,total:u.total,anchor:u.anchor?'before-br':'inside',ruby:u.ruby?u.ruby.length:0,lines:u.map.text.split('\\n').length,fallback:u.fallback||''};})};})()");
  check('真实页面：段落识别不是整篇一个单元', collect.count >= 10, JSON.stringify({ count: collect.count, first: collect.units.slice(0, 4) }));
  check('真实页面：单 <br> + 全角缩进被识别为段落', collect.units.filter((u) => u.lines === 1).length >= 10, JSON.stringify(collect.units.slice(0, 6)));
  await captureScreenshot(tab, path.join(outDir, tag + '-before.png'));

  await tabMsg(tab.tabId, { type: 'dt:toggle' });
  const dualReady = await until(() => pageEval(tab, "return document.querySelectorAll('.main_text [data-dt-target]').length >= 10"), 60000);
  await settled(tab);
  const dual = await pageEval(tab, "return (function(){var mt=document.querySelector('.main_text');var mtTop=mt.getBoundingClientRect().top;var ts=Array.prototype.slice.call(mt.querySelectorAll('[data-dt-target]'));var seq=[];Array.prototype.forEach.call(mt.childNodes,function(n){if(n.nodeType===3&&n.nodeValue.trim())seq.push('T');else if(n.tagName==='BR')seq.push('BR');else if(n.getAttribute&&n.getAttribute('data-dt-target'))seq.push('TGT');});var good=0;ts.forEach(function(t){var p=t.previousSibling;while(p){if(p.nodeType===3&&p.nodeValue.trim()){var r=document.createRange();r.selectNodeContents(p);if(r.getBoundingClientRect().top<=t.getBoundingClientRect().top+2)good++;break;}if(p.nodeType===1&&p.tagName!=='BR'&&!p.hasAttribute('data-dt-target')){var b=p.getBoundingClientRect();if(b.height>0){if(b.top<=t.getBoundingClientRect().top+2)good++;break;}}p=p.previousSibling;}});var tops=ts.map(function(t){return Math.round(t.getBoundingClientRect().top-mtTop);});return {targets:ts.length,tops:tops.slice(0,8),height:Math.round(mt.getBoundingClientRect().height),seq:seq.slice(0,24).join(','),good:good,firstText:ts[0]?String(ts[0].textContent).slice(0,24):''};})()");
  check('真实双语：每个实际段落都有译文（不是 1 个）', !!dualReady && dual.targets >= 10, JSON.stringify({ targets: dual.targets }));
  check('真实双语：译文紧跟在所属原文后面', dual.good >= Math.min(5, dual.targets), JSON.stringify({ good: dual.good, targets: dual.targets, seq: dual.seq }));
  check('真实双语：首段译文在第一段附近，不是页尾', dual.tops.length > 0 && dual.tops[0] < Math.max(160, before.height * 0.25), JSON.stringify(dual.tops));
  await captureScreenshot(tab, path.join(outDir, tag + '-dual.png'));

  const hover = await contentEval(tab, "(function(){var t=document.querySelectorAll('.main_text [data-dt-target]')[0];if(!t||!t.firstChild)return {error:'no-target'};var r=document.createRange();r.setStart(t.firstChild,0);r.setEnd(t.firstChild,1);var rect=r.getBoundingClientRect();window.__DT.hover.updateAt(rect.left+1,rect.top+1,t.firstChild);var tip=document.querySelector('.dt-hover-tip');return {tip:tip&&!tip.hidden?tip.innerText:'',tgt:!!CSS.highlights.get('dt-hover-target'),src:!!CSS.highlights.get('dt-hover-src')};})()");
  check('真实双语：悬停能找到原文并高亮', !!hover && hover.src && hover.tgt, JSON.stringify(hover));

  await tabMsg(tab.tabId, { type: 'dt:setMode', mode: 'translation' });
  const onlyReady = await until(() => pageEval(tab, "return document.querySelector('.main_text').hasAttribute('data-dt-replaced') || document.querySelectorAll('.main_text [data-dt-replaced]').length > 0"), 60000);
  await settled(tab);
  const only = await pageEval(tab, "return (function(){var mt=document.querySelector('.main_text');var mtRect=mt.getBoundingClientRect();var mtTop=mtRect.top;var ts=Array.prototype.slice.call(mt.querySelectorAll('[data-dt-target]'));var pieces=[];Array.prototype.forEach.call(mt.childNodes,function(n){if(n.nodeType===3){if(n.nodeValue.trim()){var r=document.createRange();r.selectNodeContents(n);var b=r.getBoundingClientRect();if(b.height>0)pieces.push({top:b.top,height:b.height,kind:'T'});}}else if(n.nodeType===1&&n.tagName!=='BR'){var b=n.getBoundingClientRect();if(b.height>0)pieces.push({top:b.top,height:b.height,kind:n.getAttribute&&n.getAttribute('data-dt-target')?'TGT':n.tagName});}});pieces.sort(function(a,b){return a.top-b.top;});var maxGap=0;for(var i=1;i<pieces.length;i++){var g=pieces[i].top-(pieces[i-1].top+pieces[i-1].height);if(g>maxGap)maxGap=g;}var rt=Array.prototype.slice.call(mt.querySelectorAll('rt'));var vr=rt.filter(function(x){return getComputedStyle(x).display!=='none';});return {height:Math.round(mtRect.height),targets:ts.length,firstTop:ts.length?Math.round(ts[0].getBoundingClientRect().top-mtTop):null,maxGap:Math.round(maxGap),visibleRt:vr.length,visible:vr.map(function(x){var ru=x.closest('ruby');return {rt:x.textContent,ruby:ru?ru.outerHTML.slice(0,140):'',parent:ru&&ru.parentElement?ru.parentElement.tagName:'',pText:ru&&ru.parentElement?String(ru.parentElement.textContent).slice(0,40):''};}),replaced:mt.hasAttribute('data-dt-replaced')||mt.querySelectorAll('[data-dt-replaced]').length,text:mt.innerText.slice(0,100),kana:/[\u3040-\u30ff]/.test(mt.innerText)};})()");
  check('真实仅译文：首段译文在原位置附近，没有巨大空白', !!onlyReady && only.firstTop !== null && only.firstTop < 160 && only.maxGap < 200, JSON.stringify({ firstTop: only.firstTop, maxGap: only.maxGap, height: only.height, text: only.text }));
  check('真实仅译文：没有可见假名 / 残留注音', only.visibleRt === 0 && !only.kana, JSON.stringify({ visibleRt: only.visibleRt, kana: only.kana, text: only.text }));
  await captureScreenshot(tab, path.join(outDir, tag + '-only.png'));

  await tabMsg(tab.tabId, { type: 'dt:setMode', mode: 'dual' });
  await settled(tab);
  const again = await pageEval(tab, "return document.querySelectorAll('.main_text [data-dt-target]').length");
  check('真实页面：模式切回双语没有重复译文', again === dual.targets, again + ' / ' + dual.targets);

  // 动态新增一个真实结构的段落（单个 <br> + 全角缩进），补翻后不能重复
  const dynamic = await pageEval(tab, "var mt=document.querySelector('.main_text');var b=document.createElement('br');b.id='rf-dyn-br';mt.appendChild(b);var t=document.createTextNode('\\n\u3000動的に追加した段落である。');b.parentNode.insertBefore(t,b.nextSibling);return mt.innerText.indexOf('動的に追加した段落')>=0");
  const dynOk = await until(() => pageEval(tab, "return document.querySelectorAll('.main_text [data-dt-target]').length > " + dual.targets), 30000);
  check('真实页面：动态新增段落会被补翻', !!dynamic && !!dynOk, JSON.stringify({ dynamic, dynOk }));
  if (dynOk) {
    await pageEval(tab, "var mt=document.querySelector('.main_text');var b=document.getElementById('rf-dyn-br');if(b){if(b.nextSibling&&b.nextSibling.nodeType===3)b.parentNode.removeChild(b.nextSibling);b.parentNode.removeChild(b);}return true");
  }

  await tabMsg(tab.tabId, { type: 'dt:toggle' });
  const restored = await pageEval(tab, "return (function(){var mt=document.querySelector('.main_text');return {html:mt.innerHTML,height:Math.round(mt.getBoundingClientRect().height)};})()");
  check('真实页面：关闭翻译后 DOM 逐字恢复', restored.html === before.html, restored.html === before.html ? '' : '长度 ' + restored.html.length + ' vs ' + before.html.length);
  await captureScreenshot(tab, path.join(outDir, tag + '-restored.png'));

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, tag + '-diagnostics.json'),
    JSON.stringify({ url, tag, before, collect, dual, hover, only, restored: { height: restored.height, htmlEqual: restored.html === before.html }, stats: { requests: stats.requests, texts: stats.texts, aligned: stats.aligned } }, null, 2)
  );
  console.log('  诊断与截图已保存：' + outDir);
}


async function popupChecks() {
  console.log('\n[弹窗]');
  await patchConfig({ medicalMode: false, glossary: [] });
  const { targetId } = await send('Target.createTarget', { url: 'chrome-extension://' + extId + '/popup/index.html' });
  const pop = await attach(targetId);
  await until(() => evaluate(pop, "!!document.getElementById('medicalMode')"));
  await sleep(400);
  const off = await evaluate(pop, "!document.getElementById('medicalMode').checked");
  check('弹窗：医学专业模式存在且默认关闭', off === true);

  await evaluate(pop, "document.getElementById('medicalMode').click(); true");
  const on = await until(async () => ((await readConfig()).medicalMode === true ? 'on' : null), 5000);
  check('弹窗：打开医学模式并写入全局配置', on === 'on');
  await evaluate(pop, "document.getElementById('medicalMode').click(); true");
  const offAgain = await until(async () => ((await readConfig()).medicalMode === false ? 'off' : null), 5000);
  check('弹窗：关闭医学模式并写入全局配置', offAgain === 'off');
  await send('Target.closeTarget', { targetId }, pop);
}

async function optionsChecks() {
  console.log('\n[设置页]');
  const { targetId } = await send('Target.createTarget', { url: 'chrome-extension://' + extId + '/options/index.html' });
  const o = await attach(targetId);
  await until(() => evaluate(o, "!!document.getElementById('provider') && document.getElementById('provider').options.length > 3"));
  await sleep(800);
  await evaluate(o, "(() => { const sel = document.getElementById('provider'); sel.value = 'custom:2'; sel.dispatchEvent(new Event('change', { bubbles: true })); return sel.value; })()");
  await sleep(300);
  await evaluate(o, "document.getElementById('deleteProvider').click(); true");
  await sleep(300);
  // 下拉框就是「当前服务商」：删完页面会切回 DeepSeek（没有 Key）。像用户一样选回原来的再保存，
  // 否则后面的检查都没有可用的 Key（字幕运行时没 Key 就不接管）
  await evaluate(o, "(() => { const sel = document.getElementById('provider'); sel.value = '__custom__'; sel.dispatchEvent(new Event('change', { bubbles: true })); return sel.value; })()");
  await sleep(300);
  await evaluate(o, "document.getElementById('save').click(); true");
  await sleep(1200);
  const afterDelete = await readConfig();
  check('删除后当前服务商仍是原来那个（有 Key）', afterDelete.currentProvider === '__custom__', afterDelete.currentProvider);
  check(
    '删除自定义服务商：槽位连同 Key 一起删掉',
    !afterDelete.providerConfig['custom:2'] && !JSON.stringify(afterDelete).includes('sk-two-secret') && !afterDelete.customProviders.some((p) => p.id === 'custom:2'),
    Object.keys(afterDelete.providerConfig).join(',')
  );

  const medDefault = await evaluate(o, "!!document.getElementById('medicalMode') && !document.getElementById('medicalMode').checked");
  check('设置页：医学专业模式存在且默认关闭', medDefault === true);
  const medClicked = await evaluate(o, "(function(){var m=document.getElementById('medicalMode');m.click();return {checked:m.checked,disabled:m.disabled};})()");
  await evaluate(o, "document.getElementById('save').click(); true");
  await sleep(1000);
  const medConfig = await readConfig();
  check('设置页：打开医学模式并保存', medConfig.medicalMode === true, JSON.stringify({ clicked: medClicked, config: medConfig.medicalMode, save: await evaluate(o, "document.getElementById('saveResult').textContent") }));
  await sleep(400);
  await evaluate(o, "(function(){var m=document.getElementById('medicalMode');m.checked=false;m.dispatchEvent(new Event('change',{bubbles:true}));return m.checked;})()");
  await evaluate(o, "document.getElementById('save').click(); true");
  await sleep(1000);
  check('设置页：关闭医学模式并保存', (await readConfig()).medicalMode === false, 'medicalMode=' + (await readConfig()).medicalMode);

  const qualityUi = await evaluate(o, `(function(){
    var select=document.getElementById('professionalQuality');
    var limit=document.getElementById('professionalMaxReviewRequests');
    var hint=document.getElementById('professionalStrictHint');
    return {value:select&&select.value,values:select&&Array.from(select.options).map(x=>x.value),limit:limit&&limit.value,hint:hint&&hint.textContent};
  })()`);
  check('设置页：专业质量默认标准，严格模式明确额外费用和审核边界', qualityUi.value === 'balanced' && qualityUi.values.join(',') === 'fast,balanced,strict' && /API/.test(qualityUi.hint) && /费用|cost/i.test(qualityUi.hint) && /专家|expert/i.test(qualityUi.hint), JSON.stringify(qualityUi));
  await evaluate(o, "document.getElementById('professionalQuality').value='strict';document.getElementById('professionalQuality').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('professionalMaxReviewRequests').value='2';document.getElementById('professionalMaxReviewRequests').dispatchEvent(new Event('input',{bubbles:true}));true");
  await until(() => evaluate(o, "!document.getElementById('save').disabled"));
  await evaluate(o, "document.getElementById('save').click();true");
  const strictConfig = await until(async () => { const cfg = await readConfig(); return cfg.professionalOptions?.quality === 'strict' && cfg.professionalOptions?.maxReviewRequests === 2 ? cfg : null; }, 5000);
  check('设置页：严格策略和有限复核次数可保存', strictConfig?.professionalOptions?.quality === 'strict' && strictConfig?.professionalOptions?.maxReviewRequests === 2 && strictConfig?.professionalProfile === 'general', JSON.stringify(strictConfig?.professionalOptions));
  await evaluate(o, "document.getElementById('professionalQuality').value='balanced';document.getElementById('professionalQuality').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('professionalMaxReviewRequests').value='1';document.getElementById('professionalMaxReviewRequests').dispatchEvent(new Event('input',{bubbles:true}));true");
  await until(() => evaluate(o, "!document.getElementById('save').disabled"));
  await evaluate(o, "document.getElementById('save').click();true");
  await sleep(800);

  const importFile = path.join(WORK, 'import.json');
  fs.writeFileSync(importFile, JSON.stringify({ app: 'rimefox', schema: 1, config: { targetLang: 'zh-CN', theme: 'underline', mode: 'dual', glossary: [{ source: 'Rimefox', target: '凛狐' }] } }));
  const { root } = await send('DOM.getDocument', {}, o);
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#importFile' }, o);
  await send('DOM.setFileInputFiles', { files: [importFile], nodeId }, o);
  const imported = await until(async () => {
    const cfg = await readConfig();
    return cfg.glossary && cfg.glossary.length ? cfg : null;
  }, 8000);
  check('导入配置：术语表一起导入', imported && imported.glossary[0].target === '凛狐', await evaluate(o, "document.getElementById('cfgResult').textContent"));
  check('导入后本机服务商的 Key 还在', imported && imported.providerConfig.__custom__ && imported.providerConfig.__custom__.apiKey === 'sk-test', imported && Object.keys(imported.providerConfig).join(','));
  await evaluate(o, "document.getElementById('refreshCache') && document.getElementById('refreshCache').click(); true");
  await sleep(800);
  const cacheText = await evaluate(o, "(document.getElementById('cacheStats') || {}).textContent || ''");
  check('缓存统计能读出', /\d+ 条/.test(cacheText) && !/读取失败/.test(cacheText), cacheText.slice(0, 120));
  await glossaryNotesChecks(o);
  // 后面的检查不要带着这张术语表跑
  await patchConfig({ glossary: [] });
}

async function glossaryNotesChecks(o) {
  console.log('\n[术语说明 / 设置界面]');
  const initial = '肿瘤研究中使用；\n日常答复按实际含义翻译。';
  await patchConfig({ glossary: [{ source: 'response', target: '治疗反应', category: '医学', note: initial }, { source: 'charge', target: '电荷', category: '物理' }] });
  const rowExpr = source => `Array.from(document.querySelectorAll('.glossary-row')).find(row=>row.querySelector('input').value===${JSON.stringify(source)})`;
  const inRow = (source, code) => evaluate(o, `(async()=>{const row=${rowExpr(source)};if(!row)throw Error('missing term');const textarea=row.querySelector('textarea');const details=row.querySelector('details');${code}})()`);
  await until(() => evaluate(o, "Array.from(document.querySelectorAll('.glossary-cat')).some(node=>node.textContent==='医学')"));
  await evaluate(o, "for(let i=0;i<3;i++){const closed=document.querySelector('.glossary-group-head[aria-expanded=false]');if(closed)closed.click();}true");
  await until(() => inRow('response', 'return textarea.value===' + JSON.stringify(initial)));
  const compact = await inRow('response', "return !details.open && !row.querySelector('.glossary-note-indicator').hidden && document.querySelector('.glossary-head').textContent.includes('首选译法')");
  check('说明：已有说明显示标识，默认折叠；首选译法和分类布局保留', compact === true);
  const empty = await inRow('charge', "return !details.open && row.querySelector('.glossary-note-indicator').hidden");
  check('说明：空词条保持折叠且无已填写标识', empty === true);
  const setNote = async (source, value) => {
    await inRow(source, `details.open=true;textarea.value=${JSON.stringify(value)};textarea.dispatchEvent(new Event('input',{bubbles:true}));return true;`);
    await until(() => evaluate(o, "!document.getElementById('save').disabled"));
  };
  const saveNote = async (source, expected) => {
    await evaluate(o, "document.getElementById('save').click();true");
    return until(async () => {
      const cfg = await readConfig();
      const item = cfg.glossary.find(one => one.source === source);
      return item && item.note === expected ? item : null;
    }, 8000);
  };
  const edited = '首选治疗反应；逗号, 引号 "response"。\n日常答复可使用其他准确译法。';
  await setNote('response', edited);
  check('说明：中文、标点、引号与换行可编辑保存', !!(await saveNote('response', edited)));
  await evaluate(o, 'location.reload();true');
  await until(() => inRow('response', 'return textarea.value===' + JSON.stringify(edited)));
  check('说明：重新加载设置页后文本完整', (await inRow('response', 'return textarea.value')) === edited);
  await setNote('response', '中'.repeat(501));
  await evaluate(o, "document.getElementById('save').click();true");
  await until(() => evaluate(o, "document.getElementById('saveResult').classList.contains('bad')"));
  const oversized = await inRow('response', "return {length:Array.from(textarea.value).length,invalid:textarea.getAttribute('aria-invalid'),open:details.open,feedback:row.querySelector('.glossary-note-count').textContent}");
  const stored = (await readConfig()).glossary.find(one => one.source === 'response');
  check('说明：超长保存被拒绝，草稿不截断、原配置不变且反馈可见', oversized.length === 501 && oversized.invalid === 'true' && oversized.open && /501 \/ 500/.test(oversized.feedback) && stored.note === edited, JSON.stringify(oversized));
  await setNote('response', '中'.repeat(500));
  check('说明：500 字符边界可保存', !!(await saveNote('response', '中'.repeat(500))));
  await setNote('response', '');
  const deleted = await saveNote('response', undefined);
  check('说明：删除说明后持久化对象不保留空 note', !!deleted && !Object.prototype.hasOwnProperty.call(deleted, 'note'));
  await setNote('response', edited);
  await saveNote('response', edited);
  let fileIndex = 0;
  async function importFile(selector, text, extension) {
    const file = path.join(WORK, 'notes-import-' + (++fileIndex) + '.' + extension);
    fs.writeFileSync(file, text);
    const { root } = await send('DOM.getDocument', {}, o);
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector }, o);
    await send('DOM.setFileInputFiles', { files: [file], nodeId }, o);
  }
  await importFile('#glossaryFile', 'source,target\nresponse,答复\n', 'csv');
  await until(() => inRow('response', "return row.querySelectorAll('input')[1].value==='答复'"));
  check('CSV：旧两列更新首选译法，保留已有分类与说明', (await inRow('response', 'return textarea.value')) === edited && (await inRow('response', "return row.querySelectorAll('input')[2].value")) === '医学');
  await saveNote('response', edited);
  await importFile('#glossaryFile', 'source,target,category,note\nresponse,答复,,\n', 'csv');
  await until(() => inRow('response', "return textarea.value===''") );
  check('CSV：明确的空说明可清空', !!(await saveNote('response', undefined)));
  await importFile('#glossaryFile', 'source,target,category,note\nresponse,治疗反应,医学,"' + edited.replace(/"/g, '""') + '"\n', 'csv');
  await until(() => inRow('response', 'return textarea.value===' + JSON.stringify(edited)));
  check('CSV：含逗号、引号及换行的四列说明完整导入', !!(await saveNote('response', edited)));
  const downloadPath = path.join(WORK, 'downloads');
  fs.mkdirSync(downloadPath, { recursive: true });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath });
  await evaluate(o, "document.getElementById('glossaryExport').click();true");
  const csvFile = await until(() => fs.readdirSync(downloadPath).find(name => /^rimefox-glossary-.*\.csv$/.test(name)));
  const csvText = csvFile ? fs.readFileSync(path.join(downloadPath, csvFile), 'utf8') : '';
  check('CSV：界面导出四列表头与完整转义说明', csvText.includes('source,target,category,note') && csvText.includes(edited.replace(/"/g, '""')));
  await evaluate(o, "document.getElementById('exportCfg').click();true");
  const jsonFile = await until(() => fs.readdirSync(downloadPath).find(name => /^rimefox-config-.*\.json$/.test(name)));
  const exported = jsonFile ? JSON.parse(fs.readFileSync(path.join(downloadPath, jsonFile), 'utf8')) : null;
  check('JSON：界面导出保留说明且默认不带 API Key', exported?.config?.glossary?.find(one => one.source === 'response')?.note === edited && !exported?.config?.providerConfig?.__custom__?.apiKey);
  await importFile('#importFile', JSON.stringify({ app: 'rimefox', schema: 1, config: { targetLang: 'zh-CN', mode: 'dual', theme: 'underline', glossary: [{ source: 'response', target: 'JSON首选译法' }] } }), 'json');
  const jsonImported = await until(async () => { const cfg = await readConfig(); return cfg.glossary.find(one => one.source === 'response' && one.target === 'JSON首选译法'); });
  check('JSON：旧条目未提供说明时保留原说明与 Key', jsonImported?.note === edited && (await readConfig()).providerConfig.__custom__.apiKey === 'sk-test');
  await inRow('response', "details.open=true;details.scrollIntoView({block:'center'});return true;");
  const screenshot = await send('Page.captureScreenshot', { format: 'png' }, o);
  fs.writeFileSync(path.join(WORK, 'glossary-notes-wide.png'), Buffer.from(screenshot.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 520, height: 900, deviceScaleFactor: 1, mobile: false }, o);
  const narrow = await inRow('response', "const box=textarea.getBoundingClientRect();const parent=row.getBoundingClientRect();return {width:box.width,inside:box.left>=parent.left&&box.right<=parent.right+1,overflow:document.documentElement.scrollWidth>innerWidth}");
  check('说明：窄屏 textarea 独占整行且不横向溢出', narrow.width > 250 && narrow.inside && !narrow.overflow, JSON.stringify(narrow));
  const narrowScreenshot = await send('Page.captureScreenshot', { format: 'png' }, o);
  fs.writeFileSync(path.join(WORK, 'glossary-notes-narrow.png'), Buffer.from(narrowScreenshot.data, 'base64'));
  await send('Emulation.clearDeviceMetricsOverride', {}, o);
  await patchConfig({ uiLang: 'en' });
  const english = await until(() => inRow('response', "return row.querySelector('summary').textContent.includes('Term note') && document.querySelector('.glossary-head').textContent.includes('Preferred translation')"));
  check('说明：英文界面的标签与说明提示可翻译', english === true);
  await patchConfig({ uiLang: 'zh' });
}

// ---------------- YouTube 真实页面 ----------------
// 静音播放、打开 CC，并切到英文字幕轨：YouTube 会按网络所在地区 / 界面语言自动选字幕（比如中文），
// 字幕本来就是目标语言（简体中文）时扩展按设计不接管，所以固定拿英文字幕翻成中文（最常见的用法）
async function playWithEnglishCaptions(s) {
  await evaluate(s, `(() => { const v = document.querySelector('.html5-video-player video'); v.muted = true; v.play().catch(() => {}); return true; })()`);
  await until(() => evaluate(s, "!!document.querySelector('.ytp-subtitles-button')"), 15000);
  await evaluate(s, `(() => {
    const b = document.querySelector('.ytp-subtitles-button');
    if (b && b.getAttribute('aria-pressed') !== 'true') b.click();
    document.getElementById('movie_player').setOption('captions', 'track', { languageCode: 'en' });
    return true;
  })()`);
  const track = () => evaluate(s, "((document.getElementById('movie_player').getOption('captions', 'track') || {}).languageCode || '')");
  return (await until(async () => ((await track()) === 'en' ? 'en' : ''), 10000)) || track();
}

// 需要能访问 YouTube，视频要有人工字幕。字幕地址带播放器生成的令牌，只能等播放器自己请求、由钩子转给扩展
// 等双语字幕叠层出现（第二行是假接口给的「译:…」）。中途遇到广告（播放器带 ad-showing）：
// 能跳过就点跳过，跳不过就等它播完，播完重新切到英文字幕；顺带记下播广告时叠层有没有显示出来
async function waitForBilingual(s, ms) {
  let sawAd = false;
  let adOverlay = false;
  let afterAd = false;
  let lastAd = null;
  const shown = await until(async () => {
    const st = await evaluate(s, `(() => {
      const p = document.getElementById('movie_player');
      const ad = !!p && p.classList.contains('ad-showing');
      const skip = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern');
      if (ad && skip) skip.click();
      const o = document.querySelector('.rimefox-subs');
      const on = !!o && o.style.display !== 'none';
      return { ad, on, orig: on && o.children[0] ? o.children[0].textContent : '', trans: on && o.children[1] ? o.children[1].textContent : '' };
    })()`);
    if (st.ad !== lastAd) {
      verbose(st.ad ? '广告开始' : '广告结束 / 正片');
      lastAd = st.ad;
    }
    if (st.ad) {
      sawAd = true;
      if (st.on) adOverlay = true;
      return null;
    }
    if (sawAd && !afterAd) {
      afterAd = true;
      await playWithEnglishCaptions(s);
    }
    return st.trans.indexOf('译:') === 0 ? st : null;
  }, ms, 500);
  return { shown, sawAd, adOverlay };
}

async function youtubeChecks(url) {
  console.log('\n[YouTube 字幕]');
  await patchConfig({ subtitleTranslate: true, targetLang: 'zh-CN', debug: VERBOSE });
  // 无头 Chrome 的 UA 带 HeadlessChrome，YouTube 可能不给正常播放器：换成普通 Chrome 的 UA
  const ua = version['User-Agent'].replace('HeadlessChrome', 'Chrome');
  const yt = await openTab(url, async (s) => {
    await send('Network.setUserAgentOverride', { userAgent: ua, acceptLanguage: 'en-US,en' }, s);
    await send('Network.enable', {}, s); // 看 YouTube 给的字幕回包是不是空的
    if (VERBOSE) {
      // 页面主环境的字幕钩子和内容脚本之间的每一条消息（字幕回包 / 重放请求）
      await send('Page.enable', {}, s);
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: "addEventListener('message', (e) => { const d = e.data; if (d && (d.source === 'rimefox-yt' || d.source === 'rimefox-ext')) console.log('[凛狐·e2e] 消息 ' + d.source + ' ' + d.type + (d.replay ? ' replay' : '') + (d.url ? ' v=' + new URL(d.url).searchParams.get('v') : '') + (d.body ? ' ' + d.body.length + ' 字' : '')); });"
      }, s);
    }
  });
  const player = await until(() => evaluate(yt.s, "!!document.querySelector('.html5-video-player video')"), 30000);
  check('打开视频页：播放器加载出来', player, url);
  if (!player) return;
  const sentBefore = stats.texts;
  const track = await playWithEnglishCaptions(yt.s);
  check('切到英文字幕轨', track === 'en', track || '没有英文字幕轨');
  // YouTube 偶尔给字幕请求回 200 + 空内容（text/html，几十字节；字幕地址的 PO 令牌没通过，无头浏览器时有发生）：
  // 原生字幕那次也是空的，扩展没东西可翻。这种情况刷新重试，最多 3 次；拿到过正常的 json 回包还没出双语字幕才算扩展的问题
  const vid = new URL(url).searchParams.get('v');
  let first = null;
  let emptyOnly = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const mark = captionResponses.length;
    first = await waitForBilingual(yt.s, 120000);
    if (first.shown) break;
    const got = captionResponses.slice(mark).filter((r) => r.v === vid);
    emptyOnly = got.length > 0 && got.every((r) => r.mime !== 'application/json' || r.bytes < 200);
    if (!emptyOnly) break;
    console.log('    （第 ' + attempt + ' 次打开 YouTube 回了空字幕，刷新重试）');
    await evaluate(yt.s, 'location.reload(); true');
    await sleep(1500);
    await until(() => evaluate(yt.s, "!!document.querySelector('.html5-video-player video')"), 30000);
    await playWithEnglishCaptions(yt.s);
  }
  const overlay = first.shown;
  check(
    '打开 CC：双语字幕叠层出现（原文 + 译文）',
    overlay && overlay.orig && overlay.trans === '译:' + overlay.orig,
    overlay ? overlay.orig + ' / ' + overlay.trans : emptyOnly ? '3 次打开 YouTube 都回了空字幕（不是扩展的问题，换个时间或加 --headed 重跑）' : '2 分钟内没有出现带译文的字幕'
  );
  const hidden = await evaluate(yt.s, "!!document.querySelector('.html5-video-player.rimefox-subs-on')");
  check('接管期间原生字幕被收起（不两套叠在一起）', hidden, hidden);
  const sentFirst = stats.texts - sentBefore;
  check('字幕按批送翻（第一次打开会请求）', sentFirst > 0, '送翻 ' + sentFirst + ' 条');
  if (!overlay) return;

  // 字幕译文进了缓存：在页面的内容脚本里把刚才显示的那句再送翻一次，后台应直接从缓存给、不发请求。
  // （不用刷新页面验证：刷新后常有跳不过的贴片广告，一等就是几分钟）
  await sleep(3200); // 等缓存落盘
  const before = stats.texts;
  const again = await contentEval(yt, 'window.__DT.send(' + JSON.stringify({ type: 'translate', texts: [overlay.orig], target: 'zh-CN', style: 'plain' }) + ')');
  check(
    '字幕译文进了缓存：同一句再送翻直接命中、不发请求',
    again && again.ok && again.cached === 1 && again.results[0] === overlay.trans && stats.texts === before,
    JSON.stringify({ cached: again && again.cached, result: again && again.results && again.results[0], newRequests: stats.texts - before })
  );
  const keys = await swEval('return Object.keys(await chrome.storage.session.get(null)).filter((k) => k.indexOf(\'dt.cache\') === 0);');
  check('字幕译文落盘到分段缓存', keys.includes('dt.cache.v1.s.index'), keys.join(','));

  // 刷新后常有贴片广告：播广告时不能把正片字幕叠在广告上（遇到广告才算覆盖到）
  await evaluate(yt.s, 'location.reload(); true');
  await sleep(1500);
  await until(() => evaluate(yt.s, "!!document.querySelector('.html5-video-player video')"), 30000);
  await playWithEnglishCaptions(yt.s);
  const second = await waitForBilingual(yt.s, 90000);
  const sawAd = first.sawAd || second.sawAd;
  check('播广告时没有把正片字幕叠在广告上', !(first.adOverlay || second.adOverlay), sawAd ? '中途播了广告' : '这次没遇到广告，没覆盖到');
  await patchConfig({ subtitleTranslate: false });
}



// ---------------- 0.10.2 真实 Bilibili 评论区验收 ----------------
async function liveBilibiliChecks(url) {
  console.log('\n[B站真实评论区]');
  // 真实 B 站评论区大多是中文；目标设成英文才能验证「中文评论 → 英文译文」，
  // 否则 looksLikeTarget 会正确地把中文评论当成已是目标语言跳过。
  await patchConfig({ targetLang: 'en', hoverCompare: true, lazy: false, dockEnabled: false });
  const tab = await openTab(url);
  if (!tab.tabId) {
    const bv = (String(url).match(/BV[0-9A-Za-z]+/) || [])[0] || '';
    tab.tabId = await swEval('const t = await chrome.tabs.query({}); return t.filter((x) => x.url && x.url.indexOf(' + JSON.stringify(bv) + ') >= 0).map((x) => x.id).pop();');
  }
  // 评论区在视频下方：B 站要等真实的 window scroll 才挂载 feed。
  await pageEval(tab, "var c=document.querySelector('bili-comments'); if(c){var y=c.getBoundingClientRect().top+window.scrollY-200;window.scrollTo(0,Math.max(700,y));} return true;");
  await sleep(2500);
  let loaded = null;
  for (let i = 0; i < 6 && !loaded; i += 1) {
    await pageEval(tab, "window.scrollBy(0, 600); return true;");
    await sleep(2000);
    loaded = await pageEval(
      tab,
      "var c=document.querySelector('bili-comments');var r=c&&c.shadowRoot;var f=r&&r.querySelector('#feed');return f?Array.from(f.children).filter(function(x){return /^BILI-COMMENT-THREAD-RENDERER$/i.test(x.tagName);}).length:0;"
    );
  }
  const structure = await pageEval(
    tab,
    "var c=document.querySelector('bili-comments');var r=c&&c.shadowRoot;var f=r&&r.querySelector('#feed');var t=f&&f.children[0];var cr=t&&t.shadowRoot&&t.shadowRoot.querySelector('bili-comment-renderer');var rich=cr&&cr.shadowRoot&&cr.shadowRoot.querySelector('bili-rich-text');return {comments:!!c,root:!!r,feed:!!f,threads:f?f.children.length:0,commentRoot:!!(cr&&cr.shadowRoot),rich:!!rich,richRoot:!!(rich&&rich.shadowRoot),contents:!!(rich&&rich.shadowRoot&&rich.shadowRoot.querySelector('#contents'))};"
  );
  check('真实 B站：bili-comments 使用开放 shadow root，thread / comment / rich-text 可访问', !!loaded && !!structure && structure.root && structure.feed && structure.commentRoot && structure.richRoot && structure.contents, JSON.stringify(structure));
  const targets = () => pageEval(tab, SHADOW_ALL_JS + "; return shadowAll('#contents [data-dt-target]').length;");
  await tabMsg(tab.tabId, { type: 'dt:toggle' });
  const ready = await until(() => targets().then((n) => n >= 1), 40000);
  await settled(tab);
  const first = await pageEval(tab, SHADOW_ALL_JS + "; var c=shadowAll('#contents').filter(function(x){var t=x.textContent.trim();return t.length>20&&t.indexOf('登录后查看')<0;})[0]; return c ? {text:c.textContent.replace(/\\s+/g,' ').slice(0,160),target:c.querySelector('[data-dt-target]')?c.querySelector('[data-dt-target]').textContent.slice(0,160):''} : null;");
  check('真实 B站：评论区正文写入译文', !!ready && !!first && !!first.target && first.target.length > 0, JSON.stringify(first));
  const meta = await pageEval(tab, SHADOW_ALL_JS + "; return shadowAll('.user,.time,.actions').filter(function(e){return e.querySelector('[data-dt-target]');}).length;");
  check('真实 B站：评论区昵称 / 时间 / 操作区没有译文', meta === 0, meta);
  const before = await targets();
  await pageEval(tab, "window.scrollTo(0, document.documentElement.scrollHeight); return true;");
  const grew = await until(() => targets().then((n) => n > before), 15000);
  check('真实 B站：向下滚动加载的新评论进入翻译队列', !!grew, before + ' -> ' + (await targets()));
  await tabMsg(tab.tabId, { type: 'dt:toggle' });
  await sleep(1200);
  const restored = await pageEval(tab, SHADOW_ALL_JS + "; return {targets:shadowAll('[data-dt-target]').length,replaced:shadowAll('[data-dt-replaced]').length,text:shadowAll('#contents')[0]?shadowAll('#contents')[0].textContent.slice(0,120):''};");
  check('真实 B站：关闭翻译后评论区原文恢复、无残留', restored.targets === 0 && restored.replaced === 0 && restored.text.length > 0, JSON.stringify(restored));
  const diag = await contentEval(tab, 'window.__DT.shadow.diagnostics()');
  check('真实 B站：observer 释放', !!diag && diag.observers === 0, JSON.stringify(diag));
}

// ---------------- 0.10.2 开放 Shadow DOM / Bilibili 评论区 ----------------
const SHADOW_ALL_JS = [
  'function shadowAll(sel) {',
  '  var out = []; var seen = new Set();',
  '  function visit(root) {',
  '    try { var list = root.querySelectorAll(sel); for (var i=0;i<list.length;i+=1) { if (!seen.has(list[i])) { seen.add(list[i]); out.push(list[i]); } } } catch (err) {}',
  '    var all = []; try { all = root.querySelectorAll("*"); } catch (err) { return; }',
  '    for (var j=0;j<all.length;j+=1) if (all[j].shadowRoot) visit(all[j].shadowRoot);',
  '  }',
  '  visit(document); return out;',
  '}'
].join('\n');
async function shadowChecks() {
  console.log('\n[Shadow DOM / Bilibili 评论]');
  await patchConfig({ targetLang: 'zh-CN', hoverCompare: true, lazy: false, dockEnabled: false });
  const tab = await openTab(ORIGIN + '/shadow-bili.html');
  const contentTargets = () =>
    pageEval(tab, SHADOW_ALL_JS + "; return shadowAll('#contents [data-dt-target]').length;");
  const contentTexts = () =>
    pageEval(tab, SHADOW_ALL_JS + "; return shadowAll('#contents').map(function(c){return {text:c.textContent,targets:c.querySelectorAll('[data-dt-target]').length,replaced:c.hasAttribute('data-dt-replaced')};});");
  await tabMsg(tab.tabId, { type: 'dt:toggle' });
  const ready = await until(() => contentTargets().then((n) => n >= 7), 30000);
  await settled(tab);
  check('B站夹具：普通标题 / 简介仍在翻译', await pageEval(tab, "return !!document.querySelector('#video-title [data-dt-target]') && !!document.querySelector('#video-desc [data-dt-target]')"));
  check('B站夹具：一级评论、楼中楼、含输入框评论、隐藏回复的正文都发现', ready, await contentTargets());
  const style = await pageEval(tab, SHADOW_ALL_JS + "; var t=shadowAll('#contents [data-dt-target]')[0]; if(!t) return null; var cs=getComputedStyle(t); var root=t.getRootNode(); var st=root.querySelector&&root.querySelector('[data-dt-shadow-style]'); return {display:cs.display, marginTop:cs.marginTop, whiteSpace:cs.whiteSpace, sheet:(root.adoptedStyleSheets||[]).length, style:!!st, len:st?st.textContent.length:0};");
  check('Shadow DOM 译文样式实际生效（display / margin / 样式表）', !!style && style.display === 'block' && style.marginTop !== '0px' && (style.sheet > 0 || style.style), JSON.stringify(style));
  const scanMs = await contentEval(tab, "(function(){var t0=performance.now();for(var i=0;i<3;i+=1){window.__DT.collectAll(function(){return false;});}return (performance.now()-t0)/3;})()");
  check('B站夹具：11 条评论的增量收集耗时可控', typeof scanMs === 'number' && scanMs < 400, scanMs.toFixed(1) + ' ms/次');
  const first = await pageEval(tab, SHADOW_ALL_JS + "; return shadowAll('#contents').slice(0,4).map(function(c){return c.textContent;});" );
  check('B站夹具：评论正文拿到译文', Array.isArray(first) && first.every((s) => s.indexOf('译:') >= 0), JSON.stringify(first));
  const meta = await pageEval(tab, SHADOW_ALL_JS + "; return shadowAll('.user,.time,.actions').map(function(e){return {text:e.textContent,targets:e.querySelectorAll('[data-dt-target]').length};});");
  check('B站夹具：昵称 / 时间 / 点赞 / 操作区不翻译', Array.isArray(meta) && meta.length >= 8 && meta.every((x) => x.targets === 0), JSON.stringify(meta.slice(0,5)));
  const hidden = await pageEval(tab, SHADOW_ALL_JS + "; var h=shadowAll('.hidden-reply')[0]; if(!h) return -1; var n=0; shadowAll('#contents').forEach(function(c){var cur=c; while(cur){if(cur===h){n+=c.querySelectorAll('[data-dt-target]').length;break;}var p=cur.parentNode; if(!p){var r=cur.getRootNode&&cur.getRootNode();p=r&&r.host?r.host:null;} cur=p;}}); return n;");
  check('B站夹具：未展开的隐藏回复不翻译', hidden === 0, hidden);
  const input = await pageEval(tab, SHADOW_ALL_JS + "; var t=shadowAll('#shadow-input')[0]; return t ? t.value : '';");
  check('B站夹具：评论输入框保持原值', input === 'shadow input draft', input);
  const closed = await pageEval(tab, "return window.__closedRoot ? window.__closedRoot.querySelectorAll('[data-dt-target]').length : -1;");
  check('B站夹具：closed shadow root 安全跳过', closed === 0, closed);
  const sentBefore = stats.texts;
  const added = await pageEval(tab, "window.biliAddThread('Dynamically inserted top-level comment after the initial scan.', 'Dynamically inserted nested reply after the initial scan.'); return true;");
  const grew = await until(() => contentTargets().then((n) => n >= 9), 20000);
  await settled(tab);
  const dynamicTexts = await pageEval(tab, SHADOW_ALL_JS + "; return shadowAll('#contents').map(function(c){return c.textContent;});");
  check('B站夹具：动态新增一级评论和楼中楼自动翻译', !!added && !!grew && dynamicTexts.some((s) => s.indexOf('Dynamically inserted top-level') >= 0 && s.indexOf('译:') >= 0), grew);
  check('B站夹具：动态只送新增内容', stats.texts > sentBefore, stats.texts + ' / ' + sentBefore);

  // 点击后异步加载的楼中楼：300ms 扫描时还没进 DOM，1.2s 的补扫接住。
  const beforeLate = await contentTargets();
  await pageEval(tab, "document.getElementById('late-reply').click(); return true;");
  const late = await until(() => contentTargets().then((n) => n >= beforeLate + 1), 15000);
  await settled(tab);
  check('B站夹具：点击后异步加载的楼中楼自动翻译', !!late, beforeLate + ' -> ' + (await contentTargets()));
  await pageEval(tab, "document.getElementById('show-hidden').click(); return true;");
  const shown = await until(() => pageEval(tab, SHADOW_ALL_JS + "; var h=shadowAll('.hidden-reply')[0]; if(!h) return false; var hit=null; shadowAll('#contents').forEach(function(c){var cur=c; while(cur){if(cur===h){hit=c;break;}var p=cur.parentNode; if(!p){var r=cur.getRootNode&&cur.getRootNode();p=r&&r.host?r.host:null;} cur=p;}}); return !!hit && hit.querySelectorAll('[data-dt-target]').length === 1;"), 15000);
  const showState = await pageEval(tab, SHADOW_ALL_JS + "; var h=shadowAll('.hidden-reply')[0]; if(!h) return null; var hit=null; shadowAll('#contents').forEach(function(c){var cur=c; while(cur){if(cur===h){hit=c;break;}var p=cur.parentNode; if(!p){var r=cur.getRootNode&&cur.getRootNode();p=r&&r.host?r.host:null;} cur=p;}}); return {display:getComputedStyle(h).display,rects:hit?hit.getClientRects().length:-1,text:hit?hit.textContent:'',targets:hit?hit.querySelectorAll('[data-dt-target]').length:-1};");
  check('B站夹具：展开隐藏回复后补翻', !!shown, JSON.stringify(showState));
  await pageEval(tab, "window.biliSort(); return true;");
  await settled(tab);
  const sorted = await contentTargets();
  check('B站夹具：排序重建后译文还在', sorted >= 10, sorted);
  const link = await pageEval(tab, SHADOW_ALL_JS + "; var a=shadowAll('#comment-link')[0]; return a ? {href:a.getAttribute('href'),connected:a.isConnected} : null;");
  check('B站夹具：评论里的链接还在', !!link && link.href === '#comment-link' && link.connected, JSON.stringify(link));

  // 悬停：content 里的文字节点可以直接解析到 TranslationUnit
  const hover = await contentEval(tab, "(function(){" + SHADOW_ALL_JS + "; var u=shadowAll('#contents [data-dt-target]')[0]; if(!u) return {error:'no-target'}; var c=u.parentNode; var tn=null; for(var i=0;i<c.childNodes.length;i+=1){if(c.childNodes[i].nodeType===3){tn=c.childNodes[i];break;}} if(!tn) return {error:'no-text'}; var unit=window.__DT.unitOfNode(tn); return {unit:!!unit, text:unit?unit.text.slice(0,20):''};})()");
  check('悬停：Shadow DOM 译文能解析到单元', !!(hover && hover.unit), JSON.stringify(hover));
  await pageEval(tab, SHADOW_ALL_JS + "; var u=shadowAll('#contents [data-dt-target]')[0]; if(u) u.scrollIntoView({block:'center'}); return true;");
  await sleep(300);
  const hoverAt = await pageEval(tab, SHADOW_ALL_JS + "; var u=shadowAll('#contents [data-dt-target]')[0]; if(!u) return null; var c=u.parentNode; for(var i=0;i<c.childNodes.length;i+=1){if(c.childNodes[i].nodeType===3&&c.childNodes[i].nodeValue.trim()){var r=document.createRange();r.setStart(c.childNodes[i],0);r.setEnd(c.childNodes[i],Math.min(3,c.childNodes[i].nodeValue.length));var b=r.getBoundingClientRect();return {x:b.left+2,y:b.top+b.height/2};}} return null;");
  let painted = null;
  if (hoverAt) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(hoverAt.x), y: Math.round(hoverAt.y), pointerType: 'mouse' }, tab.s);
    painted = await until(() => contentEval(tab, "(function(){var a=CSS.highlights.get('dt-hover-src');var b=CSS.highlights.get('dt-hover-target');var tip=document.querySelector('.dt-hover-tip');return {src:!!a,tgt:!!b,tip:!!(tip&&!tip.hidden)};})()"), 3000);
  }
  check('悬停：真实鼠标进入 Shadow DOM 正文能高亮 / 降级出气泡', !!painted && (painted.src || painted.tgt || painted.tip), JSON.stringify({ at: hoverAt, painted: painted }));
  // 仅译文：正文原地替换，链接 / 昵称 / 输入框不被清掉
  await tabMsg(tab.tabId, { type: 'dt:setMode', mode: 'translation' });
  const only = await until(() => pageEval(tab, SHADOW_ALL_JS + "; var c=shadowAll('#contents'); return c.length && c.every(function(x){return x.hasAttribute('data-dt-replaced') || x.querySelector('[data-dt-target]');});"), 20000);
  await settled(tab);
  const onlyLink = await pageEval(tab, SHADOW_ALL_JS + "; var a=shadowAll('#comment-link')[0]; return a ? {href:a.getAttribute('href'),connected:a.isConnected} : null;");
  const onlyInput = await pageEval(tab, SHADOW_ALL_JS + "; var t=shadowAll('#shadow-input')[0]; return t ? t.value : '';");
  check('仅译文：Shadow DOM 内正文原地替换', !!only);
  check('仅译文：链接和输入框仍保留', !!onlyLink && onlyLink.connected && onlyLink.href === '#comment-link' && onlyInput === 'shadow input draft', JSON.stringify({ link: onlyLink, input: onlyInput }));


  await tabMsg(tab.tabId, { type: 'dt:setMode', mode: 'dual' });
  await until(() => contentTargets().then((n) => n >= 10), 20000);
  await settled(tab);
  const diag = await contentEval(tab, 'window.__DT.shadow.diagnostics()');
  check('Observer：B站评论区只保留受控的 feed 边界', !!diag && diag.observers >= 1 && diag.observers <= 2, JSON.stringify(diag));

  await tabMsg(tab.tabId, { type: 'dt:toggle' });
  await sleep(700);
  const restored = await pageEval(tab, SHADOW_ALL_JS + "; return {targets:shadowAll('[data-dt-target]').length, replaced:shadowAll('[data-dt-replaced]').length, src:shadowAll('[data-dt-src]').length, texts:shadowAll('#contents').map(function(c){return c.textContent;})};");
  check('还原：Shadow DOM 译文 / 标记全部清掉，原文恢复', restored.targets === 0 && restored.replaced === 0 && restored.src === 0 && restored.texts.some((s) => s.indexOf('Top-level comment one') >= 0), JSON.stringify({ targets: restored.targets, replaced: restored.replaced, src: restored.src }));
  const cleanDiag = await contentEval(tab, 'window.__DT.shadow.diagnostics()');
  check('还原：Shadow DOM observer 全部释放', !!cleanDiag && cleanDiag.observers === 0, JSON.stringify(cleanDiag));

  // 切换视频：重建 bili-comments 后旧 observer 不残留
  const cachedBefore = stats.texts;
  await tabMsg(tab.tabId, { type: 'dt:toggle' });
  await until(() => contentTargets().then((n) => n >= 10), 20000);
  await settled(tab);
  check('缓存：重新打开评论区时相同评论文本不重复请求', stats.texts === cachedBefore, cachedBefore + ' -> ' + stats.texts);
  await pageEval(tab, "window.biliReplace(); return true;");
  const switched = await until(() => pageEval(tab, SHADOW_ALL_JS + "; return shadowAll('#contents [data-dt-target]').length >= 1 && shadowAll('#contents').some(function(c){return c.textContent.indexOf('fresh comment tree') >= 0 && c.textContent.indexOf('译:') >= 0;});"), 20000);
  await settled(tab);
  const switchDiag = await contentEval(tab, 'window.__DT.shadow.diagnostics()');
  check('切换视频：新评论树自动翻译，旧 observer 已清理', !!switched && !!switchDiag && switchDiag.observers <= 1, JSON.stringify(switchDiag));
  await tabMsg(tab.tabId, { type: 'dt:toggle' });

  // 通用 auto 模式：多层 open root + slot 去重 + closed 跳过
  console.log('\n[Shadow DOM / 通用夹具]');
  const auto = await openTab(ORIGIN + '/shadow-auto.html');
  await tabMsg(auto.tabId, { type: 'dt:toggle' });
  const autoReady = await until(() => pageEval(auto, SHADOW_ALL_JS + "; return shadowAll('[data-dt-target]').length >= 5;"), 20000);
  await settled(auto);
  const autoStats = await pageEval(auto, SHADOW_ALL_JS + "; return {all:shadowAll('[data-dt-target]').length, slot:shadowAll('#slot1 [data-dt-target]').length, inner:shadowAll('#inner-slot [data-dt-target]').length};");
  check('通用夹具：单层 / 多层开放 root 都能翻译', !!autoReady && autoStats.all >= 5, JSON.stringify(autoStats));
  check('通用夹具：slot 分发内容只翻译一次', autoStats.slot === 1 && autoStats.inner === 1, JSON.stringify(autoStats));
  check('通用夹具：closed shadow root 安全跳过', await pageEval(auto, "var c=document.getElementById('closed'); return !c.shadowRoot;") === true);
  await tabMsg(auto.tabId, { type: 'dt:toggle' });
  await sleep(500);
  const autoRestored = await pageEval(auto, SHADOW_ALL_JS + "; return {targets:shadowAll('[data-dt-target]').length, slot:document.getElementById('slot1').textContent};");
  check('通用夹具：还原后无残留', autoRestored.targets === 0 && autoRestored.slot.indexOf('Slotted light DOM') === 0, JSON.stringify(autoRestored));
  const autoDiag = await contentEval(auto, 'window.__DT.shadow.diagnostics()');
  check('通用夹具：还原后 observer 释放', !!autoDiag && autoDiag.observers === 0, JSON.stringify(autoDiag));

  // 普通网页：适配器不启用，collectAll 不调用 collectTargets / 不遍历 shadow root。
  const normal = await openTab(ORIGIN + '/page.html?shadow-normal');
  await tabMsg(normal.tabId, { type: 'dt:toggle' });
  await settled(normal);
  const normalMs = await contentEval(normal, "(function(){var t0=performance.now();for(var i=0;i<3;i+=1){window.__DT.collectAll(function(){return false;});}return (performance.now()-t0)/3;})()");
  const shadowOff = await contentEval(normal, 'window.__DT.shadow.active()');
  check('普通网页：不启用 Shadow DOM，收集无额外遍历', shadowOff === false && typeof normalMs === 'number' && normalMs < 50, JSON.stringify({ active: shadowOff, ms: normalMs }));
  await tabMsg(normal.tabId, { type: 'dt:toggle' });
}


// ---------------- 医学专业模式 ----------------
async function medicalChecks() {
  console.log('\n[医学专业模式]');
  await patchConfig({ targetLang: 'zh-CN', medicalMode: false, glossary: [] });
  const tab = await openTab(ORIGIN + '/medical.html');
  await tabMsg(tab.tabId, { type: 'dt:toggle' });
  await until(() => pageEval(tab, "return !!document.querySelector('#med [data-dt-target]')"), 20000);
  await settled(tab);
  const normalSystem = stats.lastSystem;
  const normalRequests = stats.requests;
  const normalSent = stats.sent.length;
  check('默认关闭：提示词不带医学规则', !String(normalSystem).includes('医学专业翻译要求'));

  await patchConfig({ medicalMode: true });
  const findMedSystem = () => {
    for (let i = stats.systems.length - 1; i >= 0; i -= 1) {
      const one = String(stats.systems[i] || '');
      if (one.includes('医学专业翻译要求') && one.includes('odds ratio → 比值比')) return one;
    }
    return null;
  };
  let medSystem = await until(findMedSystem, 8000);
  if (!medSystem) {
    await tabMsg(tab.tabId, { type: 'dt:retranslate' });
    medSystem = await until(findMedSystem, 20000);
  }
  await settled(tab);
  const medState = await contentEval(tab, "({enabled: __DT.state.enabled, medical: __DT.state.config && __DT.state.config.medicalMode, target: __DT.state.target})");
  check('开启医学模式：已翻译页面按新配置重建并注入医学规则', !!medSystem && medSystem.includes('odds ratio → 比值比'), JSON.stringify({ config: (await readConfig()).medicalMode, state: medState, sent: stats.sent.slice(normalSent), systems: stats.systems.map((s) => (String(s).includes('医学专业翻译要求') ? 'MED' : 'norm')), term: !!medSystem && medSystem.includes('odds ratio → 比值比') }));
  check('医学模式不增加请求：普通 / 专业各一次', stats.requests === normalRequests + 1, normalRequests + ' -> ' + stats.requests);

  const medRequests = stats.requests;
  await patchConfig({ medicalMode: false });
  await settled(tab);
  await sleep(600);
  check('关闭医学模式：普通缓存仍命中，不重复请求', stats.requests === medRequests, medRequests + ' -> ' + stats.requests);
  await tabMsg(tab.tabId, { type: 'dt:toggle' });
  await patchConfig({ medicalMode: false, glossary: [] });
}



async function inlineLinkChecks() {
  console.log('\n[行内链接边界]');
  await patchConfig({ targetLang: 'zh-CN', mode: 'translation', lazy: false, hoverCompare: false });
  const tab = await openTab(ORIGIN + '/inline-links.html');
  await tabMsg(tab.tabId, { type: 'dt:toggle' });
  await until(() => pageEval(tab, 'return document.querySelector("#link-start").textContent.indexOf("译:") >= 0'), 20000);
  await settled(tab);
  const info = await pageEval(tab, `
    var p = document.querySelector('#link-start');
    var a = p.querySelector('a');
    var target = p.querySelector('[data-dt-target]');
    var g = document.querySelector('#link-end');
    var ga = g.querySelector('a');
    var gt = g.querySelector('[data-dt-target]');
    var w = document.querySelector('#link-whole a');
    var y = document.querySelector('#link-youtube a');
    return {
      mention: a.textContent,
      mentionTargetInLink: !!target && !!target.closest('a'),
      generic: ga.textContent,
      genericTarget: !!gt,
      genericTargetInLink: !!gt && !!gt.closest('a'),
      whole: w.textContent,
      yt: y.textContent,
      ytTargetInLink: !!(document.querySelector('#link-youtube [data-dt-target]') && document.querySelector('#link-youtube [data-dt-target]').closest('a'))
    };
  `);
  check('行内链接·@ 提及：用户名链接文字不变，后面译文不在链接里', info.mention === '@alice' && !info.mentionTargetInLink && info.yt === '@a' && !info.ytTargetInLink, JSON.stringify(info));
  check('行内链接·普通链接：链接文字不被吞，仅译文原地替换且不退回双语', info.generic === 'this paper' && !info.genericTarget && !info.genericTargetInLink, JSON.stringify(info));
  check('行内链接·整段链接：允许原地翻译，链接仍可点', info.whole.indexOf('译:') === 0, JSON.stringify(info));
  await patchConfig({ mode: 'dual' });
  await until(() => pageEval(tab, 'return document.querySelectorAll("#link-mid [data-dt-target]").length === 1'), 20000);
  const dual = await pageEval(tab, `
    var p = document.querySelector('#link-mid');
    var a = p.querySelector('a');
    var t = p.querySelector('[data-dt-target]');
    return { text: a.textContent, targetInLink: !!t && !!t.closest('a') };
  `);
  check('行内链接·双语：原文链接不动，译文块不在链接里', dual.text === '@alice' && !dual.targetInLink, JSON.stringify(dual));
}

// ---------------- Science Advances 真实页面 ----------------
// Cloudflare 会挡无头模式；用 --headed --science-live 跑。用真实页面的正文段落验证引用识别，
// 不调用真实模型：构造一段带保留标记的译文，在页面里注入 / 还原。
async function scienceLiveChecks(url = 'https://www.science.org/doi/10.1126/sciadv.adx3472') {
  console.log('\n[Science 真实页面]');
  const tab = await openTab(url);
  await until(() => contentEval(tab, "!!window.__DT && !!document.querySelector('[role=paragraph] a[role=doc-biblioref]')"), 45000);
  const found = await contentEval(tab, `(function () {
    var p = Array.prototype.find.call(document.querySelectorAll('[role="paragraph"]'), function (el) {
      return el.querySelector('a[role="doc-biblioref"]');
    });
    if (!p) return { ok: false, why: '没有带 doc-biblioref 的段落' };
    var units = window.__DT.collect(p);
    var u = units[0];
    if (!u) return { ok: false, why: '没有收集到单元' };
    return {
      ok: true,
      text: u.text.slice(0, 120),
      keep: (u.keep || []).map(function (k) { return { text: k.text, cite: !!k.cite, href: k.el && k.el.getAttribute ? k.el.getAttribute('href') : '' }; }),
      wire: u.wire.slice(0, 300),
      anchors: p.querySelectorAll('a[role="doc-biblioref"]').length
    };
  })()`);
  check('Science 实页：引用链接被识别成保留区', found.ok && found.keep.length >= 2 && found.keep.every((k) => k.cite), JSON.stringify(found));
  check('Science 实页：编号进标记，锚点 / 属性不进送翻正文', found.ok && found.wire.indexOf('<k1>') >= 0 && !/core-collateral|doc-biblioref/.test(found.wire), found.ok ? found.wire : found.why);
  const injected = await contentEval(tab, `(function () {
    var p = Array.prototype.find.call(document.querySelectorAll('[role="paragraph"]'), function (el) { return el.querySelector('a[role="doc-biblioref"]'); });
    var u = window.__DT.collect(p)[0];
    var mode = window.__DT.state.mode;
    window.__DT.state.mode = 'translation';
    var before = p.innerHTML;
    var links = Array.prototype.slice.call(p.querySelectorAll('a[role="doc-biblioref"]'));
    var ok = window.__DT.inject(u, '水凝胶为研究细胞提供了特殊材料环境，可作为细胞外基质模拟物（<k1>1</k1>–<k2>3</k2>）。', 'zh-CN');
    var after = Array.prototype.slice.call(p.querySelectorAll('a[role="doc-biblioref"]'));
    var target = p.querySelector('[data-dt-target]');
    var result = {
      ok: ok,
      sourceIntact: links.length === after.length && links.every(function (a, i) { return a === after[i] && a.getAttribute('href') === links[i].getAttribute('href'); }),
      targetInsideLink: !!target && !!target.closest('a'),
      targetCount: p.querySelectorAll('[data-dt-target]').length
    };
    window.__DT.restore();
    window.__DT.state.mode = mode;
    result.restored = p.innerHTML === before;
    return result;
  })()`);
  // 真实首段有 9 组引用；演示译文只带 2 组标记时，按原句顺序恢复落点，不插入双语块。
  check('Science 实页：仅译文原地重建、保留原引用链接和点击目标，无双语回退且完整还原', injected.ok && injected.sourceIntact && !injected.targetInsideLink && injected.targetCount === 0 && injected.restored, JSON.stringify(injected));
}

// ---------------- 自检页 ----------------
// AGENTS.md 要求改 dom.js 前后「selftest/index.html 全部通过」。这里顺手跑一遍，
// 发版前不用再手动打开 chrome-extension://<id>/selftest/index.html
async function selftestChecks() {
  console.log('\n[自检页]');
  const { targetId } = await send('Target.createTarget', { url: 'chrome-extension://' + extId + '/selftest/index.html' });
  const s = await attach(targetId);
  // Runtime.evaluate 里不能直接写 return：整段包成 IIFE（2026-10 踩过：表达式非法，被 until 吞掉 90 秒）
  const summary = await until(
    () =>
      evaluate(
        s,
        "(() => { const n = document.getElementById('summary'); return n && n.textContent.indexOf('运行中') < 0 ? n.textContent.trim() : ''; })()"
      ),
    90000
  );
  const failed = await evaluate(
    s,
    "Array.from(document.querySelectorAll('#list li')).filter((li) => li.querySelector('.no')).map((li) => li.textContent.replace(/\\s+/g, ' ').slice(0, 180))"
  );
  check('自检页全部通过', !!summary && summary.indexOf('全部通过') >= 0, summary || '没等到结果');
  check('自检页没有失败项', Array.isArray(failed) && failed.length === 0, (failed || []).slice(0, 5).join(' | '));
  try {
    await send('Target.closeTarget', { targetId });
  } catch (err) {
    /* 已经关了 */
  }
}

// ---------------- 0.9.6 目标语言：日文 → 英文（悬停开 / 关） ----------------
async function languageChecks() {
  console.log('\n[目标语言：日文 → 英文]');
  await patchConfig({ targetLang: 'en', hoverCompare: true, dockEnabled: false, customPrompt: '' });
  const tab = await openTab(ORIGIN + '/aozora.html');
  await tabMsg(tab.tabId, { type: 'dt:toggle' });
  const ready = await until(() => pageEval(tab, "return document.querySelectorAll('#mt [data-dt-target]').length === 3"), 20000);
  await settled(tab);
  const textsOf = () =>
    pageEval(tab, "return Array.from(document.querySelectorAll('#mt [data-dt-target]')).map(function (n) { return n.textContent; })");
  const englishOnly = (list) =>
    Array.isArray(list) && list.length === 3 && list.every((s) => s && s.trim() && !/[\u3040-\u30ff\u3400-\u9fff]/.test(s));

  const alignedTexts = await textsOf();
  check('悬停开启（align）：日文正文译成英文，不再变成中文', ready && englishOnly(alignedTexts), JSON.stringify(alignedTexts));
  check(
    '悬停开启：align 提示词写明唯一目标语言 English (en)',
    String(stats.lastAlignedSystem).includes('唯一目标语言：English (en)') &&
      !String(stats.lastAlignedSystem).includes('这一组句子的译文'),
    String(stats.lastAlignedSystem).slice(0, 120)
  );
  const alignInfo = await contentEval(
    tab,
    "(function () { var tn = document.querySelectorAll('#mt [data-dt-target]')[1]; if (!tn || !tn.firstChild) return { align: false, sentences: -1 }; var u = window.__DT.unitOfNode(tn.firstChild); return { align: !!(u && u.align), sentences: u ? u.sentences.length : -1 }; })()"
  );
  check('悬停开启：结构化 parts 通过校验，句级对照可用', !!alignInfo && !!alignInfo.align, JSON.stringify(alignInfo));
  const hover = await contentEval(
    tab,
    "(function () { var tn = document.querySelectorAll('#mt [data-dt-target]')[1]; if (!tn || !tn.firstChild) return { error: 'no-target' }; var r = document.createRange(); r.setStart(tn.firstChild, 1); r.setEnd(tn.firstChild, Math.min(5, tn.firstChild.nodeValue.length)); var rect = r.getBoundingClientRect(); window.__DT.hover.updateAt(rect.left + 1, rect.top + 1, tn.firstChild); var src = CSS.highlights.get('dt-hover-src'); var tgt = CSS.highlights.get('dt-hover-target'); return { src: src ? Array.from(src).map(function (x) { return x.toString(); }).join('|') : '', tgt: tgt ? Array.from(tgt).map(function (x) { return x.toString(); }).join('|') : '' }; })()"
  );
  check('悬停开启：英文译文上仍能高亮对应原句', !!hover && !!hover.src && !!hover.tgt, JSON.stringify(hover));

  // 关掉悬停对照：先清缓存再重翻（缓存键不含 align，不清会直接命中上面那次的结果，普通提示词根本不会被调用）
  await contentEval(tab, 'window.__DT.send({ type: "cache:clear" })');
  await patchConfig({ hoverCompare: false });
  await tabMsg(tab.tabId, { type: 'dt:toggle' });
  await until(() => pageEval(tab, "return document.querySelectorAll('#mt [data-dt-target]').length === 0"), 10000);
  stats.aligned = 0;
  await tabMsg(tab.tabId, { type: 'dt:toggle' });
  const readyPlain = await until(() => pageEval(tab, "return document.querySelectorAll('#mt [data-dt-target]').length === 3"), 20000);
  await settled(tab);
  const plainTexts = await textsOf();
  check('悬停关闭（普通模式）：同样译成英文', readyPlain && englishOnly(plainTexts), JSON.stringify(plainTexts));
  check(
    '悬停关闭：普通提示词同样写明唯一目标语言 English (en)，且没有 parts',
    String(stats.lastSystem).includes('唯一目标语言：English (en)') && !String(stats.lastSystem).includes('"parts"'),
    String(stats.lastSystem).slice(0, 120)
  );

  // 切回中文：页面上不能继续留着旧英文译文
  await patchConfig({ targetLang: 'zh-CN', hoverCompare: true });
  const switched = await until(
    () =>
      pageEval(
        tab,
        "var list = Array.from(document.querySelectorAll('#mt [data-dt-target]')); return list.length === 3 && list.every(function (n) { return n.textContent.indexOf('译:') === 0; });"
      ),
    25000
  );
  const switchedTexts = await textsOf();
  check('切换目标语言：旧英文译文被中文译文替换', !!switched, JSON.stringify(switchedTexts));
  await tabMsg(tab.tabId, { type: 'dt:toggle' });
  await patchConfig({ targetLang: 'zh-CN', hoverCompare: true });
  await sleep(300);
}

// ---------------- 0.9.6 _locales：manifest 的 __MSG_*__ 在浏览器里解析成本地化文案 ----------------
async function localeChecks() {
  console.log('\n[_locales]');
  const manifest = JSON.parse(await swEval('return JSON.stringify(chrome.runtime.getManifest());'));
  const names = ['凛狐 · 双语对照翻译', 'Rimefox - Bilingual Translation'];
  const descriptions = [
    '用自己的 API 做整页双语对照翻译，动态内容自动补翻。',
    'Translate pages and selections with your own API key.'
  ];
  // UI 语言决定取 zh_CN 还是 en；两种文案都算通过，但绝不能是 __MSG_ 占位符
  check('manifest 名称按界面语言本地化（不是 __MSG_ 占位符）', names.includes(manifest.name), manifest.name);
  check('manifest 简介按界面语言本地化', descriptions.includes(manifest.description), manifest.description);
}

// ---------------- 0.9.6 悬浮球半隐藏：真实矩形 + 真实鼠标 ----------------
async function dockHideChecks() {
  console.log('\n[悬浮入口·半隐藏]');
  await patchConfig({ dockEnabled: true, dockAutoHide: true, dockSide: 'right', dockPos: null });
  const d = await openTab(ORIGIN + '/page.html?dockhide');
  await until(() => pageEval(d, "return !!document.getElementById('dt-dock')"));
  await sleep(900); // 半隐藏 / 展开的过渡都跑完
  const ballInfo = async () =>
    JSON.parse(
      await contentEval(
        d,
        '(function () { var root = window.__DT.dock.root(); var dockEl = root.querySelector(".dock"); var r = root.querySelector(".ball").getBoundingClientRect(); var vw = document.documentElement.clientWidth; return JSON.stringify({ left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), top: Math.round(r.top), height: Math.round(r.height), vw: vw, visible: Math.round(Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0))), transform: getComputedStyle(dockEl).transform, snapped: dockEl.hasAttribute("data-snapped") }); })()'
      )
    );

  const right = await ballInfo();
  check('右侧贴边半隐藏：至少露出半个小球', right.right > right.vw && right.visible >= right.width / 2 - 1, JSON.stringify(right));

  const hoverX = right.vw - Math.round(right.visible / 2);
  const hoverY = Math.round(right.top + right.height / 2);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverX, y: hoverY, pointerType: 'mouse' }, d.s);
  // 悬停展开有 120ms 延迟 + 320ms 过渡，headless 下帧调度还可能更慢：轮询到展开完成，别用固定 sleep
  let opened = null;
  const openedOk = await until(async () => {
    const m = await ballInfo();
    if (m.transform === 'none') {
      opened = m;
      return true;
    }
    return false;
  }, 6000);
  if (!opened) opened = await ballInfo();
  check('鼠标移入可见半球：Dock 完整展开', !!openedOk && opened.left >= 0 && opened.right <= opened.vw - 1, JSON.stringify(opened));

  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(opened.vw / 2), y: 150, pointerType: 'mouse' }, d.s);
  let closed = null;
  const closedOk = await until(async () => {
    const m = await ballInfo();
    // 等过渡走完：既不是展开（transform none），也不在中间位置，而是稳定在半颗球
    if (m.transform !== 'none' && m.visible >= m.width / 2 - 1 && m.visible <= m.width / 2 + 2) {
      closed = m;
      return true;
    }
    return false;
  }, 6000);
  if (!closed) closed = await ballInfo();
  check('鼠标移开：重新半隐藏', !!closedOk && closed.right > closed.vw && closed.visible >= closed.width / 2 - 1, JSON.stringify(closed));

  await patchConfig({ dockSide: 'left', dockPos: null });
  await sleep(900);
  const left = await ballInfo();
  check('左侧贴边半隐藏：至少露出半个小球', left.left < 0 && left.visible >= left.width / 2 - 1, JSON.stringify(left));

  // 从半隐藏的小球起拖到页面中间：起拖 / 松手都不能瞬移，松手后自由悬浮
  const sx = Math.round(Math.min(left.right, left.vw) / 2);
  const sy = Math.round(left.top + left.height / 2);
  const tx = Math.round(left.vw / 2);
  const ty = Math.round(left.top + 60);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1, pointerType: 'mouse' }, d.s);
  for (let i = 1; i <= 8; i += 1) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sx + ((tx - sx) * i) / 8, y: sy + ((ty - sy) * i) / 8, button: 'left', pointerType: 'mouse' }, d.s);
    await sleep(30);
  }
  const duringDrag = await ballInfo();
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left', clickCount: 1, pointerType: 'mouse' }, d.s);
  await sleep(900);
  const dropped = await ballInfo();
  check(
    '从半隐藏小球起拖：起拖 / 松手都不跳位，松手后自由悬浮',
    Math.abs(dropped.left - duringDrag.left) <= 3 &&
      dropped.transform === 'none' &&
      !dropped.snapped &&
      dropped.left > 80 &&
      dropped.right < dropped.vw - 80,
    JSON.stringify({ before: duringDrag, after: dropped })
  );

  await patchConfig({ dockAutoHide: false, dockSide: 'right', dockPos: null });
  await sleep(900);
  const off = await ballInfo();
  check('关闭自动隐藏：完整显示', off.right <= off.vw && off.left >= 0, JSON.stringify(off));

  await patchConfig({ dockAutoHide: true, dockSide: 'right', dockPos: null });
  await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 560, deviceScaleFactor: 1, mobile: false }, d.s);
  await sleep(900);
  const narrow = await ballInfo();
  check('窄视口贴边：仍至少露出半个小球', narrow.right > narrow.vw && narrow.visible >= narrow.width / 2 - 1, JSON.stringify(narrow));
  await send('Emulation.clearDeviceMetricsOverride', {}, d.s);
  await sleep(400);

  await patchConfig({ dockEnabled: false, dockPos: null, dockAutoHide: true });
  await sleep(300);
}

let crashed = null;
// ---------------- 输入框翻译 ----------------
// 真实按键（CDP）走一遍：textarea / 只翻选区 / Ctrl+Z / 受控输入框 / contenteditable / 密码框 / 不写缓存
async function inputChecks() {
  console.log('\n[输入框翻译]');
  const tab = await openTab(ORIGIN + '/input.html');
  const pressAltI = async () => {
    const base = { modifiers: 1, key: 'i', code: 'KeyI', windowsVirtualKeyCode: 73, nativeVirtualKeyCode: 73 };
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base }, tab.s);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, tab.s);
  };
  const valueOf = (id) => pageEval(tab, 'return document.getElementById(' + JSON.stringify(id) + ').value');
  const waitValue = (id, prefix) =>
    until(
      () =>
        pageEval(
          tab,
          'const v = document.getElementById(' + JSON.stringify(id) + ').value; return v.indexOf(' + JSON.stringify(prefix) + ') === 0 ? v : "";'
        ),
      20000
    );
  const setBox = (id, value, start, end) =>
    pageEval(
      tab,
      'const el = document.getElementById(' + JSON.stringify(id) + '); el.value = ' + JSON.stringify(value) +
        '; el.focus(); el.setSelectionRange(' + start + ', ' + end + '); return true;'
    );

  // 输入框的目标语言跟随页面（<html lang="en"> → en），假接口对英文目标回英文标记；
  // 不再假设译文一定带「译:」前缀（0.9.6 起假接口按目标语言回包）。
  const EN = 'EN translation 1';
  // 1) textarea 整个框：Alt+I 翻完原地写回；目标语言跟随页面（<html lang="en"> → 提示词里是 English）
  await pageEval(tab, "document.getElementById('ta').focus(); return true");
  await pressAltI();
  const whole = await waitValue('ta', 'EN translation');
  check('textarea：按 Alt+I 翻整个框并原地写回', whole === EN, whole || '没有写回');
  check(
    '目标语言跟随页面：<html lang="en"> → 提示词里是 English',
    /English/.test(stats.lastSystem),
    (stats.lastSystem.match(/目标语言（[^）]*）/) || [''])[0]
  );

  // 2) 撤销：写入走 execCommand，Ctrl+Z 能回到原文
  const undone = await pageEval(tab, "document.getElementById('ta').focus(); document.execCommand('undo'); return document.getElementById('ta').value;");
  check('撤销：Ctrl+Z 回到原文', undone === 'Hello draft line', undone);

  // 3) 有选区只翻选区
  await setBox('ta', 'One two three', 4, 7);
  await pressAltI();
  const onlySel = await waitValue('ta', 'One EN translation');
  check('有选区只翻选区，别的文字不动', onlySel === 'One ' + EN + ' three', onlySel || '没有写回');

  // 4) 不写缓存：同一段重置后再翻，还是要发一次新请求（输入框里是草稿）
  await setBox('ta', 'Cache me not', 12, 12);
  await pressAltI();
  await waitValue('ta', 'EN translation');
  const afterFirst = stats.texts;
  await setBox('ta', 'Cache me not', 12, 12);
  await pressAltI();
  await waitValue('ta', 'EN translation');
  check('输入框翻译不进缓存：同一段再翻仍是一次新请求', stats.texts > afterFirst, '第一次后 ' + afterFirst + ' → 第二次后 ' + stats.texts);

  // 5) 模拟 React 受控输入框：必须收到 input 事件，state 跟着变
  await pageEval(tab, "document.getElementById('rx').focus(); return true");
  await pressAltI();
  const controlled = await until(
    () =>
      pageEval(
        tab,
        "const el = document.getElementById('rx'); return el.getAttribute('data-state') === " + JSON.stringify('EN translation 1') + " ? el.value : '';"
      ),
    20000
  );
  check('受控输入框：收到 input 事件，state 跟着变', controlled === EN, controlled || '受控输入框没收到改动');

  // 6) contenteditable 富文本：整段选中后按快捷键
  await pageEval(
    tab,
    "const ce = document.getElementById('ce'); ce.focus(); const r = document.createRange(); r.selectNodeContents(ce); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true;"
  );
  await pressAltI();
  const rich = await until(
    () => pageEval(tab, "const el = document.getElementById('ce'); return el.textContent.indexOf('EN translation') === 0 ? el.textContent : '';"),
    20000
  );
  check('contenteditable：整段替换成译文', rich === EN, rich || '富文本没被替换');

  // 7) 密码框一律不碰
  await pageEval(tab, "document.getElementById('pw').focus(); return true");
  await pressAltI();
  await sleep(800);
  const pw = await valueOf('pw');
  check('密码框不翻译', pw === 'secret', pw);

  // Hold a real background response until the page has changed. No timing race or
  // slow paid API is needed to exercise the production input writer.
  const holdInput = async () => {
    await contentEval(tab, `(() => {
      const dt = window.__DT;
      const original = dt.send;
      const state = window.__rimefoxInputPending = {};
      dt.send = function (msg) {
        if (msg.type !== 'translate') return original.apply(this, arguments);
        dt.send = original;
        return original.apply(this, arguments).then(response => new Promise(resolve => {
          state.release = () => resolve(response);
        }));
      };
      state.done = dt.inputTranslate();
      return true;
    })()`);
    if (!await until(() => contentEval(tab, '!!window.__rimefoxInputPending.release'))) throw new Error('输入框竞态检查没有拿到后台响应');
  };
  const finishInput = () => contentEval(tab, '(window.__rimefoxInputPending.release(), window.__rimefoxInputPending.done)');
  const selectRich = (start, end) => pageEval(tab, `
    const el = document.getElementById('ce'); el.focus();
    const range = document.createRange(); range.setStart(el.firstChild, ${start}); range.setEnd(el.firstChild, ${end});
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); return true;
  `);

  await setBox('ta', 'Old draft', 0, 0);
  await holdInput();
  await pageEval(tab, "const el=document.getElementById('ta'); el.select(); document.execCommand('insertText', false, 'New draft'); return el.value;");
  const edited = await finishInput();
  check('等待译文时继续输入：取消旧结果，保留新草稿', edited === false && (await valueOf('ta')) === 'New draft', await valueOf('ta'));

  await pageEval(tab, "document.getElementById('ce').textContent='Hello world'; return true;");
  await selectRich(0, 5);
  await holdInput();
  await selectRich(6, 11);
  const moved = await finishInput();
  const movedText = await pageEval(tab, "return document.getElementById('ce').textContent;");
  check('等待译文时移动富文本选区：仍只替换最初选中的原文', moved === true && movedText === EN + ' world', movedText);

  await pageEval(tab, "document.getElementById('ce').textContent='Hello world'; return true;");
  await selectRich(0, 5);
  await holdInput();
  await pageEval(tab, "document.getElementById('ce').textContent='New rich draft'; return true;");
  const richEdited = await finishInput();
  check('等待译文时编辑富文本：取消旧结果，保留新正文', richEdited === false && (await pageEval(tab, "return document.getElementById('ce').textContent;")) === 'New rich draft');

  await pageEval(tab, "document.getElementById('ce').textContent='Hello world'; return true;");
  await selectRich(0, 5);
  await holdInput();
  await pageEval(tab, "const el=document.getElementById('ce'); el.replaceChildren(document.createTextNode('Hello world')); return true;");
  const replacedNodes = await finishInput();
  check('富文本被站点重建：即使文字相同，也不向旧选区写回', replacedNodes === false && (await pageEval(tab, "return document.getElementById('ce').textContent;")) === 'Hello world');

  await setBox('ta', 'Focus draft', 0, 0);
  await holdInput();
  await pageEval(tab, "document.getElementById('tx').focus(); return true;");
  const lostFocus = await finishInput();
  check('等待译文时切换输入框：不抢焦点、不改任何草稿', lostFocus === false && (await valueOf('ta')) === 'Focus draft' && (await valueOf('tx')) === 'Another draft' && (await pageEval(tab, 'return document.activeElement.id;')) === 'tx');

  await setBox('ta', 'Composition draft', 0, 0);
  await holdInput();
  await pageEval(tab, "document.getElementById('ta').dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true})); return true;");
  const ime = await finishInput();
  await pageEval(tab, "document.getElementById('ta').dispatchEvent(new CompositionEvent('compositionend', {bubbles:true})); return true;");
  check('译文返回时正在输入法组词：不打断当前输入', ime === false && (await valueOf('ta')) === 'Composition draft');
}

// ---------------- 0.9.3 悬浮入口拖拽 ----------------
async function dockChecks() {
  console.log('\n[悬浮入口拖拽]');
  await patchConfig({ dockEnabled: true, dockAutoHide: false, dockSide: 'right', dockPos: null });
  const d = await openTab(ORIGIN + '/page.html?dock');
  await until(() => pageEval(d, "return !!document.getElementById('dt-dock')"));
  await sleep(400);
  const rectOf = () =>
    pageEval(d, `const h = document.getElementById('dt-dock'); const r = h.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), vw: innerWidth, side: h.getAttribute('data-side') }`);
  async function dragTo(tx, ty) {
    const r = await rectOf();
    const sx = r.left + r.width / 2;
    const sy = r.top + r.height - 20; // 小球在 dock 底部
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1, pointerType: 'mouse' }, d.s);
    for (let i = 1; i <= 6; i += 1) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sx + ((tx - sx) * i) / 6, y: sy + ((ty - sy) * i) / 6, button: 'left', pointerType: 'mouse' }, d.s);
      await sleep(30);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left', clickCount: 1, pointerType: 'mouse' }, d.s);
    await sleep(400);
  }
  await dragTo(24, 320);
  const r1 = await rectOf();
  check('拖到左边缘松手：吸附到左边、side 翻转', r1.left === 0 && r1.side === 'left', JSON.stringify(r1));
  await evaluate(d.s, 'location.reload(); true');
  await until(() => pageEval(d, "return !!document.getElementById('dt-dock')"));
  await sleep(400);
  const r2 = await rectOf();
  check('位置写进配置：刷新页面后仍贴左边', r2.left === 0 && r2.side === 'left', JSON.stringify(r2));
  await dragTo(Math.round(r2.vw / 2), 240);
  const r3 = await rectOf();
  check('页面中间松手：自由悬浮、不贴任何边', r3.left > 80 && r3.left < r3.vw - 80, JSON.stringify(r3));

  // 小球在 pointerdown 就捕获指针（拖拽起手不能等第一次 pointermove：指针一先滑进
  // iframe，顶层文档收不到那次移动，拖拽永远起不来）。捕获会把随后的 click 改投到
  // 捕获元素，这里守住 0.9.3 踩过的坑：点按小球（不移动）仍然切换翻译。
  const ballAt = JSON.parse(
    await contentEval(
      d,
      '(function () { var r = window.__DT.dock.root().querySelector(".ball").getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()'
    )
  );
  const clickAt = async ({ x, y }) => {
    const at = { x, y, button: 'left', clickCount: 1, pointerType: 'mouse' };
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at }, d.s);
    await sleep(40);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at }, d.s);
    await sleep(300);
  };
  const clickBall = () => clickAt(ballAt);
  const enabledBefore = await contentEval(d, 'window.__DT.control.status().enabled');
  await clickBall();
  const enabledOn = await contentEval(d, 'window.__DT.control.status().enabled');
  await clickBall();
  const enabledOff = await contentEval(d, 'window.__DT.control.status().enabled');
  check(
    '点按小球仍然切换翻译（拖拽捕获不抢 click）',
    enabledBefore === false && enabledOn === true && enabledOff === false,
    JSON.stringify({ enabledBefore, enabledOn, enabledOff })
  );

  // 面板按钮（服务商）：真实 click 仍然能打开 / 收起菜单（0.9.3 捕获回归的另一个入口）
  await contentEval(d, '(window.__DT.dock.setOpen(true), true)');
  await sleep(350);
  const providerAt = JSON.parse(
    await contentEval(
      d,
      '(function () { var r = window.__DT.dock.root().querySelector("[data-act=provider]").getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()'
    )
  );
  await clickAt(providerAt);
  const menuOpened = await contentEval(d, 'window.__DT.dock.menu() ? !window.__DT.dock.menu().hidden : false');
  await clickAt(providerAt);
  const menuClosed = await contentEval(d, 'window.__DT.dock.menu() ? window.__DT.dock.menu().hidden : false');
  check('面板按钮（服务商菜单）仍可点开 / 收起', menuOpened === true && menuClosed === true, JSON.stringify({ menuOpened, menuClosed }));
  await contentEval(d, '(window.__DT.dock.setOpen(false), true)');

  await patchConfig({ dockEnabled: false, dockPos: null });
  await sleep(300);
}



async function dualLiveChecks(url) {
  console.log('\n[双语字体基线] ' + DUAL_LABEL);
  await patchConfig({ targetLang: 'zh-CN', mode: 'dual', lazy: false, hoverCompare: false, dockEnabled: false, translateOnLoad: false });
  const t = await openTab(url);
  await until(() => pageEval(t, "return document.querySelectorAll('.article-body__content-text').length >= 5"), 30000);
  await sleep(1000);
  await tabMsg(t.tabId, { type: 'dt:toggle' });
  await until(() => pageEval(t, "return !!document.querySelector('.article-body__content-text .dt-target')"), 30000);
  await settled(t);
  const info = await pageEval(t, "return (function(){var p=document.querySelector('.article-body__content-text');var target=p.querySelector('.dt-target');var pc=getComputedStyle(p);var tc=target?getComputedStyle(target):null;return {family:tc&&tc.fontFamily,sourceFamily:pc.fontFamily,weight:tc&&tc.fontWeight,sourceWeight:pc.fontWeight,size:tc&&tc.fontSize,sourceSize:pc.fontSize,line:tc&&tc.lineHeight,sourceLine:pc.lineHeight,fonts:p.querySelectorAll('.dt-font').length,targets:document.querySelectorAll('.dt-target').length};})()");
  const outDir = path.join(process.cwd(), 'docs', 'verification', '2026-10-23-chosun-font-ab');
  const clip = await pageEval(t, "return (function(){var p=document.querySelector('.article-body__content-text');var r=p.getBoundingClientRect();return {x:0,y:Math.max(0,Math.floor(r.top+window.scrollY)-12),width:Math.min(window.innerWidth,860),height:620,scale:1};})()");
  const file = path.join(outDir, 'chosun-dual-' + DUAL_LABEL + '.png');
  await captureScreenshot(t, file, clip);
  check('双语基线：' + DUAL_LABEL + ' 保留原站字体、字重、字号、行高', !!info.family && info.family === info.sourceFamily && info.weight === info.sourceWeight && info.size === info.sourceSize && info.line === info.sourceLine && info.fonts === 0, JSON.stringify(info));
  check('双语基线：' + DUAL_LABEL + ' 截图生成', fs.existsSync(file) && fs.statSync(file).size > 1000, path.basename(file));
  await tabMsg(t.tabId, { type: 'dt:toggle' });
  await patchConfig({ mode: 'dual', dockEnabled: false });
}

async function chosunLiveChecks(url) {
  console.log('\n[朝鲜日报真实页面样式]');
  stats.chosunLive = true;
  await patchConfig({ targetLang: 'zh-CN', mode: 'translation', lazy: false, hoverCompare: false, dockEnabled: false, translateOnLoad: false });
  const t = await openTab(url);
  await until(() => contentEval(t, '!!(window.__DT && window.__DT.styleBoundaryAware)'), 20000);
  await until(() => pageEval(t, "return document.querySelectorAll('.article-body__content-text').length >= 5"), 30000);
  await sleep(1000);
  const shotDir = path.join(process.cwd(), 'docs', 'verification', '2026-10-23-chosun-font-ab');
  const shotClip = await pageEval(t, "return (function(){var p=document.querySelector('.article-body__content-text');var r=p.getBoundingClientRect();return {x:0,y:Math.max(0,Math.floor(r.top+window.scrollY)-12),width:Math.min(window.innerWidth,860),height:620,scale:1};})()");
  await captureScreenshot(t, path.join(shotDir, 'chosun-01-korean-source.png'), shotClip);
  const before = await pageEval(t, "return Array.from(document.querySelectorAll('.article-body__content-text')).map((p)=>{var c=getComputedStyle(p);return {cls:p.className,weight:parseInt(c.fontWeight,10),family:c.fontFamily,text:p.textContent.slice(0,40)};});");
  await tabMsg(t.tabId, { type: 'dt:toggle' });
  await until(() => pageEval(t, "return !!document.querySelector('.article-body__content-text[data-dt-replaced]')"), 30000);
  await settled(t);
  const after = await pageEval(t, "return Array.from(document.querySelectorAll('.article-body__content-text')).map((p)=>{var w=document.createTreeWalker(p,NodeFilter.SHOW_TEXT);var nodes=[];for(var n=w.nextNode();n;n=w.nextNode()){if(n.nodeValue.trim()){var pe=n.parentElement||p;nodes.push({text:n.nodeValue.slice(0,24),weight:parseInt(getComputedStyle(pe).fontWeight,10),family:getComputedStyle(pe).fontFamily,tag:pe.tagName,cls:pe.className});}}return {cls:p.className,replaced:p.hasAttribute('data-dt-replaced'),nodes:nodes};});");
  const bad = [];
  const boldFamily = (f) => /bold|black|heavy|semibold|demi/i.test(String(f || ''));
  for (let i = 0; i < Math.min(before.length, after.length); i += 1) {
    if (!after[i] || !after[i].replaced) continue;
    const sourceBold = before[i].weight >= 600 || boldFamily(before[i].family);
    const afterBold = after[i].nodes.some((n) => n.weight >= 600 || boldFamily(n.family));
    if (!sourceBold && afterBold) bad.push({ index: i, before: before[i], after: after[i] });
  }
  check('真实朝鲜日报：正文段落翻译后不出现新的粗体字重或粗体字族', before.length > 0 && after.length === before.length && bad.length === 0, JSON.stringify({ count: before.length, bad: bad.slice(0, 4) }));
  const fontShift = after[0] && after[0].nodes[0] ? after[0].nodes[0] : null;
  check('真实朝鲜日报：中文译文实际使用目标语言字体栈', !!fontShift && /PingFang SC|Microsoft YaHei|Noto Sans CJK SC/.test(fontShift.family) && !/chosun|myeongjo/i.test(fontShift.family), JSON.stringify(fontShift));
  await captureScreenshot(t, path.join(shotDir, 'chosun-02-chinese-adapted.png'), shotClip);
  const inspect = await contentEval(t, "window.__DT.inspectTextStyle('韩国电力', 3)");
  check('真实朝鲜日报：诊断器可读取正文 computed 样式', inspect && inspect.matches && inspect.matches.length > 0 && inspect.matches[0].style, JSON.stringify(inspect && { matched: inspect.matches.length, first: inspect.matches[0] && inspect.matches[0].style }));
  await tabMsg(t.tabId, { type: 'dt:toggle' });
  await until(() => pageEval(t, "return !document.querySelector('.dt-font, [data-dt-replaced], [data-dt-target]')"), 10000);
  await sleep(400);
  await captureScreenshot(t, path.join(shotDir, 'chosun-03-restored.png'), shotClip);
  const restored = await pageEval(t, "return (function(){var p=document.querySelector('.article-body__content-text');var c=p?getComputedStyle(p):null;return {fonts:document.querySelectorAll('.dt-font').length,replaced:document.querySelectorAll('[data-dt-replaced]').length,targets:document.querySelectorAll('[data-dt-target]').length,family:c&&c.fontFamily};})()");
  check('真实朝鲜日报：关闭翻译后字体壳移除、韩文字体恢复', restored.fonts === 0 && restored.replaced === 0 && restored.targets === 0 && /chosun|myeongjo/i.test(restored.family), JSON.stringify(restored));
  const shots = ['chosun-01-korean-source.png', 'chosun-02-chinese-adapted.png', 'chosun-03-restored.png'].map((one) => path.join(shotDir, one));
  check('真实朝鲜日报：字体 A/B 截图已生成（原文 / 中文适配 / 关闭还原）', shots.every((one) => fs.existsSync(one) && fs.statSync(one).size > 1000), JSON.stringify(shots.map((one) => path.basename(one))));

  await patchConfig({ mode: 'dual' });
  await tabMsg(t.tabId, { type: 'dt:toggle' });
  await until(() => pageEval(t, "return !!document.querySelector('.article-body__content-text .dt-target')"), 20000);
  await settled(t);
  const dual = await pageEval(t, "return (function(){var p=document.querySelector('.article-body__content-text');var target=p.querySelector('.dt-target');var pc=getComputedStyle(p);var tc=target?getComputedStyle(target):null;return {family:tc&&tc.fontFamily,sourceFamily:pc.fontFamily,size:tc&&tc.fontSize,sourceSize:pc.fontSize,line:tc&&tc.lineHeight,sourceLine:pc.lineHeight,fonts:p.querySelectorAll('.dt-font').length,targets:document.querySelectorAll('.dt-target').length};})()");
  check('真实朝鲜日报双语：保留原站字体和自适应字号 / 行高，不套仅译文字体壳', dual.fonts === 0 && /chosun|myeongjo/i.test(dual.family) && dual.family === dual.sourceFamily && dual.size === dual.sourceSize && dual.line === dual.sourceLine, JSON.stringify(dual));
  const dualShot = path.join(shotDir, 'chosun-04-dual.png');
  await captureScreenshot(t, dualShot, shotClip);
  check('真实朝鲜日报：双语截图已生成', fs.existsSync(dualShot) && fs.statSync(dualShot).size > 1000, path.basename(dualShot));
  await tabMsg(t.tabId, { type: 'dt:toggle' });
  const dualRestored = await pageEval(t, "return {targets:document.querySelectorAll('[data-dt-target]').length,replaced:document.querySelectorAll('[data-dt-replaced]').length};");
  check('真实朝鲜日报双语：关闭后无译文节点残留', dualRestored.targets === 0 && dualRestored.replaced === 0, JSON.stringify(dualRestored));
  await patchConfig({ targetLang: 'zh-CN', mode: 'translation', dockEnabled: false });
}

try {
  if (DUAL_LIVE) {
    await dualLiveChecks(DUAL_LIVE);
  } else if (CHOSUN_LIVE) {
    await chosunLiveChecks(CHOSUN_LIVE);
  } else if (SCIENCE_LIVE) {
    await scienceLiveChecks();
  } else if (SELFTEST_ONLY) {
    await selftestChecks();
  } else if (GLOSSARY_ONLY) {
    await optionsChecks();
  } else if (MEDICAL_ONLY) {
    await popupChecks();
    await medicalChecks();
  } else if (SHADOW_ONLY) {
    await shadowChecks();
  } else if (BILIBILI_LIVE) {
    await liveBilibiliChecks(BILIBILI_LIVE);
  } else if (LIVE_AOZORA) {
    await liveAozoraChecks(LIVE_AOZORA);
  } else if (!flag('--youtube-only')) {
    await articleChecks();
    await paragraphChecks();
    await citationChecks();
    await scienceLiveChecks(ORIGIN + '/science-cite.html');
    await inlineLinkChecks();
    await scienceMixedChecks();
    await pmcChecks();
    await chinagpChecks();
    await koreanBoldChecks();
    await directionChecks();
    await languageChecks();
    await localeChecks();
    await dockChecks();
    await dockHideChecks();
    await hoverLocalChecks();
    await optionsChecks();
    await selftestChecks();
    await inputChecks();
    await popupChecks();
    await medicalChecks();
    await shadowChecks();
  }
  if (YOUTUBE) await youtubeChecks(YOUTUBE);
} catch (err) {
  crashed = err;
  check('检查脚本本身跑完', false, err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err));
}

console.log('\n[异常]');
check('扩展页面 / 测试页 / service worker 没有抛出未捕获异常', exceptions.length === 0, exceptions.slice(0, 5).join(' | '));

console.log('\n假接口：请求 ' + stats.requests + ' 次、送翻 ' + stats.texts + ' 条、带 reasoning_effort 被拒 ' + stats.withEffort + ' 次');
const failed = results.filter((r) => !r.ok);
console.log((results.length - failed.length) + ' / ' + results.length + ' 通过');
fs.writeFileSync(path.join(WORK, 'result.json'), JSON.stringify({ browser: version.Browser, results, stats: { ...stats, sent: stats.sent.length }, exceptions }, null, 2));
console.log('结果：' + path.join(WORK, 'result.json'));

try {
  await send('Browser.close');
} catch (err) {
  /* 已经关了 */
}
browser.kill();
server.close();
if (!flag('--keep')) {
  await sleep(500);
  fs.rmSync(profile, { recursive: true, force: true });
}
process.exit(failed.length || crashed ? 1 : 0);
