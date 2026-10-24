// 设置页共用的小工具：DOM 查找、下拉填充、提示文字

export const $ = (id) => document.getElementById(id);

export function fillSelect(select, items) {
  select.innerHTML = '';
  items.forEach((item) => {
    const opt = document.createElement('option');
    opt.value = item.value;
    opt.textContent = item.label;
    if (item.title) opt.title = item.title;
    if (item.skipI18n) opt.setAttribute('data-i18n-skip', '1');
    if (item.disabled) opt.disabled = true;
    select.appendChild(opt);
  });
}

// 只增删 ok / bad，不覆盖元素原有的 class。
// 文字清空时退回 HTML 里写的默认说明（data-default，init 时记下）
export function setResult(node, text, kind) {
  node.textContent = text || node.dataset.default || '';
  node.classList.remove('ok', 'bad');
  if (kind) node.classList.add(kind);
}
