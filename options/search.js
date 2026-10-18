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
  }

  input.addEventListener('input', filter);
  // Esc 清空搜索
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && input.value) {
      input.value = '';
      filter();
    }
  });
  return { filter };
}
