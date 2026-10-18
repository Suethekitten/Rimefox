/* 首帧主题预判（classic script，必须放在 <head> 里同步执行）。
   设置页 / 弹窗的主题存在配置里，读配置是异步的：如果用户选了「深色」而系统是浅色，
   页面会先按 prefers-color-scheme 画一帧白底再跳成深色。这里用 localStorage 里
   上一次的取值先顶上，等 lib/config.js 读回真配置后由 applyUiTheme 覆盖。
   localStorage 只是缓存，丢了最多闪一帧，不影响正确性。 */
(function () {
  try {
    var value = localStorage.getItem('dt.uiTheme');
    if (value !== 'light' && value !== 'dark') return;
    document.documentElement.dataset.theme = value;
    document.documentElement.style.colorScheme = value;
  } catch (err) {
    /* 存储被禁用：交给 @media (prefers-color-scheme) */
  }
})();
