// 网页里的外观：把后台按网址算好的 page 对象（见 background.js 的 pageAppearance）写到 <html> 上。
//   --dt-accent         强调色：译文下划线、悬停高亮、气泡跟着变（默认值时不写，维持原来的蓝色）
//   data-dt-typo + 变量  译文排版：字号、行高、段距、首行缩进
//   #dt-custom-css      译文自定义 CSS：后台已清洗成纯声明，这里包进 .dt-target 作用域
//   data-dt-scheme      页面明暗：深色网页上换一套译文颜色
//   data-dt-night       网页夜间模式（Beta）：反色规则在 inject.css
// 站点规则交给 dom.js（DT.setSiteRule）。只有 data-dt-ui 的元素是我们自己加的。
(function () {
  'use strict';

  var DT = window.__DT;
  if (!DT || DT.__appearanceReady) return;
  DT.__appearanceReady = true;

  var html = document.documentElement;
  var pageDarkAdapt = true;

  function setVar(name, value) {
    if (value) html.style.setProperty(name, value);
    else html.style.removeProperty(name);
  }

  function applyCustomCss(css) {
    var id = 'dt-custom-css';
    var style = document.getElementById(id);
    if (!css) {
      if (style) style.remove();
      return;
    }
    if (!style) {
      style = document.createElement('style');
      style.id = id;
      style.setAttribute('data-dt-ui', '1');
      (document.head || html).appendChild(style);
    }
    // 后台已经清洗过（不含 { } @ < url() 等）；这里只负责包进作用域
    style.textContent = 'html[data-dt="on"] .dt-target{' + css + '}';
  }

  // ---------------- 页面明暗 ----------------
  function parseRgb(value) {
    var m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)/.exec(String(value || ''));
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  }

  // 相对亮度 0~1（sRGB）
  DT.luminance = function (rgb) {
    function ch(v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * ch(rgb.r) + 0.7152 * ch(rgb.g) + 0.0722 * ch(rgb.b);
  };

  // 页面实际的背景色：body → html，透明就往上找；都透明按浏览器默认（深色配色方案下是深色）
  DT.pageScheme = function () {
    var nodes = [document.body, html];
    for (var i = 0; i < nodes.length; i += 1) {
      if (!nodes[i]) continue;
      var rgb = parseRgb(getComputedStyle(nodes[i]).backgroundColor);
      if (rgb && rgb.a > 0.5) return DT.luminance(rgb) < 0.18 ? 'dark' : 'light';
    }
    var scheme = getComputedStyle(html).colorScheme || '';
    return /dark/.test(scheme) && !/light/.test(scheme) ? 'dark' : 'light';
  };

  function detectScheme() {
    if (!pageDarkAdapt || html.getAttribute('data-dt-night') === 'on') {
      html.removeAttribute('data-dt-scheme');
      return;
    }
    html.setAttribute('data-dt-scheme', DT.pageScheme());
  }
  DT.detectScheme = detectScheme;

  function apply(cfg) {
    var page = (cfg && cfg.page) || {};
    setVar('--dt-accent', page.accent || '');
    var typo = page.typo;
    ['--dt-font-scale', '--dt-line-height', '--dt-gap', '--dt-indent'].forEach(function (name) {
      setVar(name, typo ? typo[name] : '');
    });
    if (typo) html.setAttribute('data-dt-typo', 'on');
    else html.removeAttribute('data-dt-typo');
    applyCustomCss(page.customCss || '');
    if (page.night) html.setAttribute('data-dt-night', 'on');
    else html.removeAttribute('data-dt-night');
    if (DT.setSiteRule) DT.setSiteRule(page.site || null);
    pageDarkAdapt = cfg.pageDarkAdapt !== false;
    detectScheme();
  }

  DT.onConfig(apply);

  // 站点常在加载后才切深色主题（读本地设置 / 跟随系统）：过一会儿再看一次；系统明暗变了也重算
  setTimeout(detectScheme, 2000);
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', detectScheme);
  } catch (err) {
    /* 老浏览器 */
  }
})();
