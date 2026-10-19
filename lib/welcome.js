// 首次安装引导的纯逻辑：只有 install 才自动打开欢迎页；更新、浏览器重启都不打开。
// 单独放一层是为了能脱离 chrome API 做 Node 单测（test/welcome.test.mjs）。

export const WELCOME_PAGE = 'welcome/index.html';
export const WELCOME_STEPS = 4;

// details 来自 chrome.runtime.onInstalled：reason 可能是 install / update /
// chrome_update / shared_module_update。只有全新安装才自动打开。
export function shouldOpenWelcome(details) {
  return !!details && details.reason === 'install';
}

export function hasSavedUiLang(stored) {
  const saved = stored && stored.uiLang;
  return saved === 'zh' || saved === 'en';
}

// 欢迎页语言：用户明确保存过 uiLang 就跟随；新安装还没有偏好时按浏览器语言，
// 中文环境用中文，其余用英文（界面目前只支持 zh / en 两种）。
export function pickWelcomeLang(stored, browserLang) {
  if (hasSavedUiLang(stored)) return stored.uiLang;
  return /^zh(?:-|$)/i.test(String(browserLang || '')) ? 'zh' : 'en';
}

// 用 chrome.runtime.getURL 打开扩展内置页面；不传 runtime 时给纯相对路径，
// 方便单测和 file:// 预览。
export function welcomePageUrl(runtime) {
  const api = runtime || (typeof chrome !== 'undefined' ? chrome.runtime : null);
  if (!api || typeof api.getURL !== 'function') return WELCOME_PAGE;
  try {
    return api.getURL(WELCOME_PAGE);
  } catch (err) {
    return WELCOME_PAGE;
  }
}

// 手动重开（设置页 / 弹窗）和首次安装都走这里。只创建标签页，不写任何配置，
// 所以手动打开不会清空配置，也不会重新触发首次安装逻辑。
export function openWelcomePage(scope) {
  const api = scope || (typeof chrome !== 'undefined' ? chrome : null);
  if (!api || !api.tabs || typeof api.tabs.create !== 'function') return Promise.resolve(null);
  try {
    return Promise.resolve(api.tabs.create({ url: welcomePageUrl(api.runtime) }));
  } catch (err) {
    return Promise.reject(err);
  }
}
