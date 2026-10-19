// 服务商下拉与自定义服务商的列表操作（从 options.js 拆出来）
// 这里只做"列表 / 名称 / 取槽位"这些纯操作，事件处理仍然留在 options.js。

import { PROVIDERS, CUSTOM_PROVIDER_ID, providerById } from '../lib/providers.js';
import { slotFor } from '../lib/config.js';
import { fillSelect } from './ui.js';

export const NEW_CUSTOM_ID = '__new_custom__';
export const SEP_ID = '__sep__';

export function isCustomProvider(id) {
  return id === CUSTOM_PROVIDER_ID || /^custom:/.test(String(id || ''));
}

// 下拉内容：官方模板 → 分隔线 → 已保存的自定义服务商 → 新建
export function fillProviderSelect(select, cfg) {
  const items = PROVIDERS.map((p) => ({ value: p.id, label: p.name }));
  const customs = (cfg && cfg.customProviders) || [];
  if (customs.length) {
    items.push({ value: SEP_ID, label: '────────────', disabled: true });
    customs.forEach((p) => items.push({ value: p.id, label: p.name || '自定义' }));
  }
  items.push({ value: NEW_CUSTOM_ID, label: '＋ 新建自定义服务商' });
  fillSelect(select, items);
}

// 自定义服务商才显示「名称 / 删除」
export function updateProviderNameUI(els, cfg, current) {
  const custom = isCustomProvider(current);
  els.nameField.hidden = !custom;
  if (!custom) return;
  const entry = ((cfg && cfg.customProviders) || []).find((p) => p.id === current);
  els.nameInput.value = (entry && entry.name) || '';
}

// 新建一个自定义服务商槽位（第一个沿用老 id，后面依次 custom:2、custom:3…）
export function createCustomProvider(cfg) {
  const list = ((cfg && cfg.customProviders) || []).slice();
  const has = (id) => list.some((p) => p.id === id);

  let id = CUSTOM_PROVIDER_ID;
  if (has(id)) {
    let n = 2;
    while (has('custom:' + n)) n += 1;
    id = 'custom:' + n;
  }

  list.push({ id, name: '自定义 ' + (list.length + 1) });
  cfg.customProviders = list;
  return id;
}

export function updateKeyLink(link, provider) {
  if (provider && provider.keyUrl) {
    link.href = provider.keyUrl;
    link.hidden = false;
  } else {
    link.hidden = true;
    link.removeAttribute('href');
  }
}

// 把当前表单存回内存中的配置（切换服务商时不丢未保存的编辑）
export function stashCurrentProvider(cfg, current, form) {
  if (!cfg) return;
  cfg.providerConfig = cfg.providerConfig || {};
  cfg.providerConfig[current] = {
    engine: (form && form.engine) || 'openai',
    baseUrl: ((form && form.baseUrl) || '').trim(),
    apiKey: ((form && form.apiKey) || '').trim(),
    model: ((form && form.model) || '').trim()
  };
}

// 取某个服务商的槽位（没保存过就用模板默认值）
export function providerSlot(cfg, id) {
  return slotFor(cfg || {}, id);
}

export function providerInfo(id) {
  return providerById(id);
}

// 服务商快捷胶囊：照着下拉框的选项渲染（官方模板 + 自定义 + 新建），点一下 = 在下拉框里选它，
// 切换逻辑仍然只走下拉框的 change 事件。hasKey(id) 决定右上角的绿点（填过 Key 的服务商）。
// 选项没变时只更新状态，不重建按钮（避免打断键盘焦点）。
export function renderProviderPills(container, select, hasKey) {
  if (!container || !select) return;
  const options = Array.from(select.options).filter((opt) => opt.value !== SEP_ID);
  const signature = options.map((opt) => opt.value + '\u0001' + opt.textContent).join('\u0002');
  if (container.dataset.sig !== signature) {
    container.dataset.sig = signature;
    container.textContent = '';
    options.forEach((opt) => {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'provider-pill' + (opt.value === NEW_CUSTOM_ID ? ' is-new' : '');
      pill.dataset.id = opt.value;
      const label = document.createElement('span');
      label.className = 'provider-pill-name';
      label.textContent = opt.textContent;
      pill.appendChild(label);
      pill.title = opt.textContent;
      pill.addEventListener('click', () => {
        if (select.value === opt.value && opt.value !== NEW_CUSTOM_ID) return;
        select.value = opt.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      container.appendChild(pill);
    });
  }
  Array.from(container.children).forEach((pill) => {
    const id = pill.dataset.id;
    const current = id === select.value;
    pill.classList.toggle('is-current', current);
    pill.setAttribute('aria-pressed', current ? 'true' : 'false');
    pill.classList.toggle('has-key', id !== NEW_CUSTOM_ID && !!hasKey(id));
  });
}
