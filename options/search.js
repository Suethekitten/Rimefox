// 设置搜索：按当前界面语言里显示的标题 / 说明过滤，命中的行留下，没有命中的卡片和分区收起。
// 收在「高级参数」折叠区里的命中项会自动展开（清空搜索时再收回去）。
export function bindSettingsSearch({ input, main, empty }) {
  const sections = Array.from(main.querySelectorAll('.section'));

  function includes(el, q) {
    return !!el && el.textContent.toLowerCase().indexOf(q) >= 0;
  }

  function filter() {
    const q = input.value.trim().toLowerCase();
    let any = false;
    sections.forEach((sec) => {
      const headHit = q && includes(sec.querySelector('.section-head'), q);
      let secVisible = false;
      sec.querySelectorAll('.card').forEach((card) => {
        const cardHit = headHit || (q && (includes(card.querySelector('.card-title'), q) || includes(card.querySelector(':scope > .card-desc'), q)));
        const rows = card.querySelectorAll('.row');
        let rowVisible = false;
        rows.forEach((row) => {
          const hit = !q || cardHit || includes(row, q);
          row.classList.toggle('search-hidden', !hit);
          if (hit) rowVisible = true;
        });
        // 没有「行」的卡片（提示词、术语表、自定义 CSS）按整张卡片的文字算
        const visible = !q || cardHit || rowVisible || (!rows.length && includes(card, q));
        card.classList.toggle('search-hidden', !visible);
        card.querySelectorAll('details.more').forEach((box) => {
          if (q && box.querySelector('.row:not(.search-hidden)') && !box.open) {
            box.open = true;
            box.dataset.autoOpen = '1';
          } else if (!q && box.dataset.autoOpen) {
            box.open = false;
            delete box.dataset.autoOpen;
          }
        });
        if (visible) secVisible = true;
      });
      sec.classList.toggle('search-hidden', !secVisible);
      if (secVisible) any = true;
    });
    empty.hidden = !q || any;
    paintHits(q);
  }

  // 命中的文字用荧光笔高亮（CSS Custom Highlight API：给 Range 上色，不改页面结构）
  function paintHits(q) {
    if (typeof Highlight !== 'function' || !window.CSS || !CSS.highlights) return;
    if (!q) {
      CSS.highlights.delete(HIT);
      return;
    }
    const ranges = [];
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const el = node.parentElement;
        if (!el || el.closest('.search-hidden, select, option, textarea, script, style')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while ((node = walker.nextNode()) && ranges.length < 300) {
      const text = node.nodeValue.toLowerCase();
      let at = text.indexOf(q);
      while (at >= 0 && ranges.length < 300) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + q.length);
        ranges.push(range);
        at = text.indexOf(q, at + q.length);
      }
    }
    if (ranges.length) CSS.highlights.set(HIT, new Highlight(...ranges));
    else CSS.highlights.delete(HIT);
  }

  input.addEventListener('input', filter);
  // Esc 清空搜索并离开搜索框
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (input.value) {
      input.value = '';
      filter();
    } else {
      input.blur();
    }
  });
  // 按 / 直接聚焦搜索框（正在输入框里打字时不抢）
  document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
    const el = event.target;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    event.preventDefault();
    input.focus();
    input.select();
  });
  return { filter };
}

const HIT = 'rimefox-settings-search';
