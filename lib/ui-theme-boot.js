/* 首帧主题预判（classic script，必须放在 <head> 里同步执行）。
   设置页 / 弹窗的主题存在配置里，读配置是异步的：如果用户选了「深色」而系统是浅色，
   页面会先按 prefers-color-scheme 画一帧白底再跳成深色。这里用 localStorage 里
   上一次的取值先顶上，等 lib/config.js 读回真配置后由 applyUiTheme / applyUiAppearance 覆盖。
   强调色、减少透明、关闭阴影同理（lib/ui-appearance.js 写入 dt.uiLook）。
   localStorage 只是缓存，丢了最多闪一帧，不影响正确性。 */
(function () {
  var root = document.documentElement;
  try {
    var value = localStorage.getItem('dt.uiTheme');
    if (value === 'light' || value === 'dark') {
      root.dataset.theme = value;
      root.style.colorScheme = value;
    }
  } catch (err) {
    /* 存储被禁用：交给 @media (prefers-color-scheme) */
  }
  try {
    var look = JSON.parse(localStorage.getItem('dt.uiLook') || '{}');
    if (look && /^#[0-9a-f]{6}$/i.test(look.accent || '')) {
      root.dataset.accent = 'custom';
      root.style.setProperty('--accent-user', look.accent);
    }
    if (look && look.rt) root.setAttribute('data-reduce-transparency', '');
    if (look && look.ns) root.setAttribute('data-no-shadow', '');
  } catch (err) {
    /* 缓存坏了就等配置 */
  }
})();
