// 可搜索的模型选择器（从 options.js 拆出来）
// 只负责：列表渲染、过滤、键盘、开合、提示文字；不碰配置，也不发请求。
// 外部用法：
//   const picker = createModelPicker({ input, toggle, panel, search, list, hint, isSlow });
//   picker.setItems(ids);   // 拉到模型列表后调用
//   picker.updateHint();    // 输入框内容变化后调用
//   picker.close();         // 切换服务商时收起

import { setResult } from './ui.js';

export function createModelPicker(opts) {
  const { input, toggle, panel, search, list, hint, isSlow } = opts;
  let items = [];
  let index = -1;

  function visible(query) {
    const q = String(query || '').trim().toLowerCase();
    const hit = q ? items.filter((id) => id.toLowerCase().indexOf(q) >= 0) : items;
    return hit.slice(0, 100); // 列表可能几百条，只渲染前 100
  }

  function render() {
    const shown = visible(search.value);
    list.innerHTML = '';
    index = -1;

    if (!shown.length) {
      const empty = document.createElement('div');
      empty.className = 'picker-empty';
      empty.textContent = items.length ? '没有匹配的模型' : '还没有拉取到模型列表';
      list.appendChild(empty);
      return;
    }

    const current = input.value.trim();
    shown.forEach((id) => {
      const row = document.createElement('div');
      row.className = 'picker-item' + (id === current ? ' is-current' : '');
      row.dataset.id = id;
      row.textContent = id;
      if (isSlow && isSlow(id)) {
        const tag = document.createElement('span');
        tag.className = 'picker-tag';
        tag.textContent = '慢';
        row.appendChild(tag);
      }
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        choose(id);
      });
      list.appendChild(row);
    });
  }

  function open() {
    if (!items.length) {
      setResult(hint, '先点「获取模型列表」把可用模型拉下来。', 'bad');
      return;
    }
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    search.value = '';
    render();
    search.focus();
  }

  function close() {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    index = -1;
  }

  function choose(id) {
    input.value = id;
    close();
    updateHint();
  }

  function move(step) {
    const rows = Array.from(list.querySelectorAll('.picker-item'));
    if (!rows.length) return;
    index = (index + step + rows.length) % rows.length;
    rows.forEach((row, i) => row.classList.toggle('is-active', i === index));
    rows[index].scrollIntoView({ block: 'nearest' });
  }

  // 输入框是唯一的真值：提示"填的模型不在列表里"
  function updateHint() {
    const current = input.value.trim();
    if (!items.length) {
      setResult(hint, '填好 API 地址和 Key 后会自动获取可用模型；也可以直接手填模型名。');
      return;
    }
    if (current && items.indexOf(current) < 0) {
      setResult(
        hint,
        '已获取 ' + items.length + ' 个模型，但「' + current + '」不在列表里，请确认拼写或点「选择」挑一个。',
        'bad'
      );
      return;
    }
    setResult(hint, '已获取 ' + items.length + ' 个模型。点「选择」挑一个，或直接手填；别忘了保存。', 'ok');
  }

  toggle.addEventListener('click', () => {
    if (panel.hidden) open();
    else close();
  });

  search.addEventListener('input', render);

  search.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const rows = Array.from(list.querySelectorAll('.picker-item'));
      const hit = rows[index] || rows[0];
      if (hit && hit.dataset.id) choose(hit.dataset.id);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });

  document.addEventListener('mousedown', (event) => {
    if (panel.hidden) return;
    if (panel.contains(event.target) || toggle.contains(event.target)) return;
    close();
  });

  input.addEventListener('input', updateHint);

  return {
    setItems(ids) {
      items = ids || [];
      if (!panel.hidden) render();
      updateHint();
    },
    updateHint,
    open,
    close,
    isOpen() {
      return !panel.hidden;
    }
  };
}
