// 术语表设置卡片：两列表格 + 导入导出 + 示例
// 编辑直接改 currentCfg.glossary（保存时由 mergeConfig 统一清洗）

import { $, setResult } from './ui.js';
import { normalizeGlossary, parseGlossaryCsv, toGlossaryCsv } from '../lib/glossary.js';
import { STARTER } from '../lib/glossary-sample.js';
import { localIso } from '../lib/config.js';

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

  function rowOf(item, index) {
    const row = document.createElement('div');
    row.className = 'glossary-row';

    const src = document.createElement('input');
    src.type = 'text';
    src.className = 'glossary-input';
    src.placeholder = '原文，如 Battle Pass';
    src.value = item.source || '';
    src.addEventListener('input', () => {
      item.source = src.value;
    });

    const dst = document.createElement('input');
    dst.type = 'text';
    dst.className = 'glossary-input';
    dst.placeholder = '译法，如 战令';
    dst.value = item.target || '';
    dst.addEventListener('input', () => {
      item.target = dst.value;
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn danger glossary-del';
    del.textContent = '删除';
    del.addEventListener('click', () => {
      current().splice(index, 1);
      render();
      message('已删除 1 条（点「保存」后生效）', 'ok');
      changed();
    });

    row.append(src, dst, del);
    return row;
  }

  // 条数多时先折叠：导入示例有 109 条，全展开会把设置页拉得很长
  const COLLAPSED_ROWS = 30;
  let expanded = false;

  function render() {
    wrap.innerHTML = '';
    const list = current();
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'glossary-empty';
      empty.textContent = '还没有术语。可以「添加一行」手动加，或「导入示例」用现成的 109 条。';
      wrap.appendChild(empty);
      return;
    }
    const shown = expanded ? list : list.slice(0, COLLAPSED_ROWS);
    shown.forEach((item, index) => wrap.appendChild(rowOf(item, index)));

    if (list.length > COLLAPSED_ROWS) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'btn glossary-more';
      more.textContent = expanded ? '收起' : '展开全部 ' + list.length + ' 条';
      more.addEventListener('click', () => {
        expanded = !expanded;
        render();
      });
      wrap.appendChild(more);
    }
  }

  // 合并导入：同一原文以导入的为准，其余追加
  function merge(entries) {
    const byKey = new Map();
    current().forEach((one) => {
      const s = String(one.source || '').trim();
      if (s) byKey.set(s.toLowerCase(), { source: one.source, target: one.target });
    });
    let added = 0;
    entries.forEach((one) => {
      const s = String(one.source || '').trim();
      if (!s) return;
      const key = s.toLowerCase();
      if (!byKey.has(key)) added += 1;
      byKey.set(key, { source: one.source, target: one.target });
    });
    const cfg = opts.getConfig();
    cfg.glossary = normalizeGlossary(Array.from(byKey.values()));
    expanded = false;
    render();
    message('已导入 ' + entries.length + ' 条（新增 ' + added + ' 条，点「保存」后生效）', 'ok');
    changed();
  }

  $('glossaryAdd').addEventListener('click', () => {
    current().push({ source: '', target: '' });
    render();
    const inputs = wrap.querySelectorAll('.glossary-input');
    if (inputs.length) inputs[inputs.length - 2].focus();
    changed();
  });

  $('glossarySample').addEventListener('click', () => {
    merge(STARTER);
  });

  $('glossaryClear').addEventListener('click', () => {
    const cfg = opts.getConfig();
    if (cfg) cfg.glossary = [];
    render();
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
        message('这个 CSV 里没有可用的两列（原文, 译法）。', 'bad');
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
    const blob = new Blob([toGlossaryCsv(list)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rimefox-glossary-' + localIso() + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    message('已导出 ' + list.length + ' 条。', 'ok');
  });

  return { render };
}
