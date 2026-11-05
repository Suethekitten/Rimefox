// 设置页「高级 → 页面诊断」：对选定网页的主框架发 dt:diagnose，结果复制到剪贴板。
// 原先在弹窗底部，0.16.5 之后只放设置页（弹窗工具坞不再占位）。报告字段见 HANDOFF §7.2。
import { KEYS } from '../lib/config.js';
import { t } from '../lib/i18n.js';

const $ = (id) => document.getElementById(id);
const WEB_RE = /^(https?|file):/i;

function sendToTab(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(res);
    });
  });
}

export function createPageDiagnostics() {
  const select = $('diagTab');
  const button = $('diagRun');
  const result = $('diagResult');
  if (!select || !button) return { refresh() {} };

  async function refresh() {
    const keep = select.value;
    let tabs = [];
    try {
      tabs = (await chrome.tabs.query({})).filter((tab) => WEB_RE.test(tab.url || ''));
    } catch (err) { tabs = []; }
    // 最近用过的网页排在前面（lastAccessed 较新的浏览器才有，没有就保持浏览器顺序）
    tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    select.textContent = '';
    for (const tab of tabs) {
      const option = document.createElement('option');
      option.value = String(tab.id);
      let host = '';
      try { host = new URL(tab.url).host; } catch (err) { host = ''; }
      const title = (tab.title || host || tab.url || '').slice(0, 60);
      option.textContent = host && title !== host ? title + ' · ' + host : title;
      select.appendChild(option);
    }
    if (!tabs.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = t('没有已打开的网页');
      select.appendChild(option);
    }
    if (keep && Array.from(select.options).some((o) => o.value === keep)) select.value = keep;
    button.disabled = !tabs.length;
  }

  async function run() {
    const tabId = Number(select.value);
    if (!tabId) return;
    result.classList.remove('ok', 'bad');
    result.textContent = t('正在生成诊断信息…');
    let report;
    try {
      try {
        report = await sendToTab(tabId, { type: 'dt:diagnose' });
      } catch (err) {
        // 页面在扩展安装 / 更新前就打开了：先补注入再试一次
        const res = await chrome.runtime.sendMessage({ type: 'ensure', tabId });
        if (!res || !res.ok) throw new Error(t('该网页还没加载凛狐，刷新网页后再试。'));
        report = await sendToTab(tabId, { type: 'dt:diagnose' });
      }
    } catch (err) {
      result.classList.add('bad');
      result.textContent = t('诊断失败：') + err.message;
      return;
    }
    const text = JSON.stringify(report, null, 1);
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch (err) {
      copied = false;
    }
    const s = report && report.summary ? report.summary : { units: 0, skipped: 0 };
    result.classList.add(copied ? 'ok' : 'bad');
    result.textContent =
      t(copied
        ? '诊断信息已复制到剪贴板，直接粘贴给我。'
        : '复制失败：在网页上按 ' + KEYS.console + ' 打开控制台，把左上角的「top」切换成本扩展，再执行 copy(JSON.stringify(__DT_LAST_DIAG)) 然后粘贴给我。') +
      ' ' + t('翻译单元 ' + s.units + ' 个 · 被跳过 ' + s.skipped + ' 个');
  }

  button.addEventListener('click', run);
  select.addEventListener('focus', () => { refresh(); });
  window.addEventListener('focus', () => { refresh(); });
  refresh();
  return { refresh };
}
