// 术语表设置卡片：两列表格 + 导入导出 + 示例
// 编辑直接改 currentCfg.glossary（保存时由 mergeConfig 统一清洗）

import { $, setResult } from './ui.js';
import { normalizeGlossary, parseGlossaryCsv, toGlossaryCsv } from '../lib/glossary.js';
import { STARTER } from '../lib/glossary-sample.js';

// 文件名用的时间戳：不带冒号和加号（Windows 不允许，会被替换成下划线，看起来像乱码）
function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  );
}

export function createGlossaryEditor(opts) {
  const wrap = $('glossaryList');
  const note = $('glossaryResult');
  const fileInput = $('glossaryFile');

  function current() {
    const cfg = opts.getConfig();
    if (!cfg) return [];
    if (!Array.isArray(cfg.glossary)) cfg.glossary = [];
    return cfg.glossary;
  }

  function changed() {
    if (opts.onChanged) opts.onChanged();
  }

  function message(text, kind) {
    setResult(note, text, kind);
  }

  const DEFAULT_CAT = '未分类';
  const openCats = new Set();
  let renderedOnce = false;

  function categoryOf(item) {
    return String((item && item.category) || '').trim() || DEFAULT_CAT;
  }

  function resetOpen(list) {
    openCats.clear();
    if ((list || []).length <= 10) {
      (list || []).forEach((one) => openCats.add(categoryOf(one)));
    }
    renderedOnce = true;
  }

  function rowOf(item) {
    const row = document.createElement('div');
    row.className = 'glossary-row';

    const src = document.createElement('input');
    src.type = 'text';
    src.className = 'glossary-input';
    src.placeholder = '原文，如 Battle Pass';
    src.value = item.source || '';
    src.addEventListener('input', () => {
      item.source = src.value;
      changed();
    });

    const dst = document.createElement('input');
    dst.type = 'text';
    dst.className = 'glossary-input';
    dst.placeholder = '译法，如 战令';
    dst.value = item.target || '';
    dst.addEventListener('input', () => {
      item.target = dst.value;
      changed();
    });

    const cat = document.createElement('input');
    cat.type = 'text';
    cat.className = 'glossary-input glossary-category';
    cat.placeholder = DEFAULT_CAT;
    cat.value = item.category || '';
    cat.addEventListener('input', () => {
      item.category = cat.value.trim();
      changed();
    });
    // 失焦时再重排：输入过程中不要因为换了分类把当前行从眼前挪走
    cat.addEventListener('change', () => {
      item.category = cat.value.trim();
      if (item.category) openCats.add(item.category);
      render();
      changed();
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn danger glossary-del';
    del.textContent = '删除';
    del.addEventListener('click', () => {
      const list = current();
      const at = list.indexOf(item);
      if (at >= 0) list.splice(at, 1);
      render();
      message('已删除 1 条（点「保存」后生效）', 'ok');
      changed();
    });

    row.append(src, dst, cat, del);
    return row;
  }

  function headRow() {
    const head = document.createElement('div');
    head.className = 'glossary-head';
    ['原文', '译法', '分类', ''].forEach((text) => {
      const cell = document.createElement('span');
      cell.textContent = text;
      head.appendChild(cell);
    });
    return head;
  }

  function render() {
    wrap.innerHTML = '';
    const list = current();
    if (!list.length) {
      renderedOnce = false;
      openCats.clear();
      const empty = document.createElement('div');
      empty.className = 'glossary-empty';
      empty.textContent = '还没有术语。可以「添加一行」手动加，或「导入示例」用现成的 109 条。';
      wrap.appendChild(empty);
      if (window.__rimefoxI18nRefresh) window.__rimefoxI18nRefresh();
      return;
    }
    if (!renderedOnce) resetOpen(list);

    const groups = new Map();
    list.forEach((item) => {
      const cat = categoryOf(item);
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(item);
    });

    wrap.appendChild(headRow());
    const keys = Array.from(groups.keys());
    keys.forEach((cat) => {
      const items = groups.get(cat);
      const group = document.createElement('div');
      group.className = 'glossary-group';
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'glossary-group-head';
      const open = openCats.has(cat);
      const arrow = document.createElement('span');
      arrow.textContent = open ? '▾ ' : '▸ ';
      const label = document.createElement('span');
      label.textContent = cat;
      const count = document.createElement('span');
      count.textContent = '（' + items.length + '）';
      head.append(arrow, label, count);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      head.addEventListener('click', () => {
        if (openCats.has(cat)) openCats.delete(cat);
        else openCats.add(cat);
        render();
      });
      group.appendChild(head);
      if (open) {
        const body = document.createElement('div');
        body.className = 'glossary-group-body';
        items.forEach((item) => body.appendChild(rowOf(item)));
        group.appendChild(body);
      }
      wrap.appendChild(group);
    });

    const allOpen = keys.every((cat) => openCats.has(cat));
    if (keys.length > 1 || list.length > 10) {
      const all = document.createElement('button');
      all.type = 'button';
      all.className = 'btn glossary-more';
      all.textContent = allOpen ? '收起全部' : '展开全部';
      all.addEventListener('click', () => {
        if (allOpen) openCats.clear();
        else keys.forEach((cat) => openCats.add(cat));
        render();
        if (allOpen) showCard();
      });
      wrap.appendChild(all);
    }
    if (window.__rimefoxI18nRefresh) window.__rimefoxI18nRefresh();
  }

  // 合并导入：同一原文以导入的为准，其余追加；两列 CSV 不会冲掉已有分类
  function merge(entries) {
    const byKey = new Map();
    current().forEach((one) => {
      const s = String(one.source || '').trim();
      if (s) byKey.set(s.toLowerCase(), { source: one.source, target: one.target, category: one.category });
    });
    let added = 0;
    entries.forEach((one) => {
      const s = String(one.source || '').trim();
      if (!s) return;
      const key = s.toLowerCase();
      if (!byKey.has(key)) added += 1;
      const old = byKey.get(key);
      const cat = String((one && one.category) || '').trim();
      byKey.set(key, {
        source: one.source,
        target: one.target,
        category: cat || (old && old.category) || ''
      });
    });
    const cfg = opts.getConfig();
    cfg.glossary = normalizeGlossary(Array.from(byKey.values()));
    resetOpen(cfg.glossary);
    render();
    message('已导入 ' + entries.length + ' 条（新增 ' + added + ' 条，点「保存」后生效）', 'ok');
    changed();
  }

  $('glossaryAdd').addEventListener('click', () => {
    current().push({ source: '', target: '', category: DEFAULT_CAT });
    openCats.add(DEFAULT_CAT);
    render();
    const rows = wrap.querySelectorAll('.glossary-row');
    const last = rows[rows.length - 1];
    if (last) {
      const input = last.querySelector('.glossary-input');
      if (input) input.focus();
    }
    changed();
  });

  // 「导入示例」是开关：第二次点击收起（回到导入前），不需要再点保存 / 放弃
  let sampleBefore = null; // 导入前的快照（对象数组）
  let sampleAfterKey = ''; // 导入后的内容指纹，用来判断用户有没有改过

  function keyOf(list) {
    return JSON.stringify(normalizeGlossary(list).map((one) => [one.source, one.target, one.category || '']));
  }

  // 列表骤然变短（收起 / 清空）时页面高度会缩掉一大截，滚动位置不变就会“跳”到下面几节；
  // 收起后把卡片滚回来，视线还停在这张卡上
  function showCard() {
    const card = wrap.closest('.card');
    if (card && card.scrollIntoView) card.scrollIntoView({ block: 'start' });
  }

  $('glossarySample').addEventListener('click', () => {
    const list = current();

    // 还没动过：收起，回到导入前
    if (sampleAfterKey && keyOf(list) === sampleAfterKey) {
      const cfg = opts.getConfig();
      if (cfg) cfg.glossary = normalizeGlossary(sampleBefore || []);
      sampleBefore = null;
      sampleAfterKey = '';
      resetOpen(cfg ? cfg.glossary : []);
      render();
      showCard();
      message('已收起示例（回到导入前，点「保存」后生效）', 'ok');
      changed();
      return;
    }

    // 第一次，或导入后被改过：重新导入一份
    const before = normalizeGlossary(list);
    merge(STARTER);
    sampleBefore = before;
    sampleAfterKey = keyOf(current());
    message('已导入示例 ' + current().length + ' 条（分类已分好，再点一次「导入示例」可收起）', 'ok');
  });

  $('glossaryClear').addEventListener('click', () => {
    const cfg = opts.getConfig();
    if (cfg) cfg.glossary = [];
    render();
    showCard();
    message('已清空（点「保存」后生效）', 'ok');
    changed();
  });

  $('glossaryImport').addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = ''; // 允许再次选择同一个文件
    if (!file) return;
    try {
      const text = await file.text();
      const entries = parseGlossaryCsv(text);
      if (!entries.length) {
        message('这个 CSV 里没有可用的原文 / 译法两列（第三列分类可选）。', 'bad');
        return;
      }
      merge(entries);
    } catch (err) {
      message('读取失败：' + (err && err.message), 'bad');
    }
  });

  $('glossaryExport').addEventListener('click', () => {
    const list = normalizeGlossary(current());
    if (!list.length) {
      message('术语表是空的，没有可导出的内容。', 'bad');
      return;
    }
    // 前面加 BOM：Excel 直接双击打开时中文不会乱码（导入端会自动去掉 BOM）
    const blob = new Blob(['\uFEFF' + toGlossaryCsv(list)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rimefox-glossary-' + fileStamp() + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    message('已导出 ' + list.length + ' 条（含分类）。', 'ok');
  });

  return { render };
}
