import { t } from '../lib/i18n.js';
import { isFormulaOnly } from '../lib/reader/pdf-text.js';
import { placePdfLayout } from './pdf-layout.js';

const $ = (id) => document.getElementById(id);

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function translatable(block) {
  return !block.noTranslate && !!block.text.trim() && !isFormulaOnly(block.tocTitle ?? block.text);
}

export function mergePdfEdits(blocks, texts, saved) {
  return blocks.map((block, i) => {
    const edit = saved[i];
    return translatable(block) && edit?.source === block.text ? edit.text : texts[i] || '';
  });
}

export function readPdfPageRange(input, pageCount) {
  const match = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(input.trim());
  if (!match) return null;
  const first = Number(match[1]);
  const last = Number(match[2] || match[1]);
  return first >= 1 && last >= first && last <= pageCount ? { first, last } : null;
}

// Calculated at the same width for layout checking and print. 275 mm leaves
// room for rounding within the printable area of an A4 sheet.
function printWidth({ width, height }) {
  return Math.floor(Math.min(190, 275 * width / height) * 96 / 25.4);
}

async function appendFacsimile(sheet, doc, page, texts, signal, urls) {
  const width = printWidth(page.viewport);
  const view = element('div', '', 'pdf-layout-view pdf-print-layout');
  view.style.width = width + 'px';
  view.style.aspectRatio = page.viewport.width + ' / ' + page.viewport.height;
  sheet.append(view);
  const canvas = document.createElement('canvas');
  try {
    await doc.render(page.pageNo, canvas, width * 2 / page.viewport.width, { signal });
    if (signal.aborted) return 0;
    const { skips } = placePdfLayout(view, canvas, page, texts);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (signal.aborted) return 0;
    if (!blob) throw new Error(t('无法生成 PDF 页面图像。'));
    const image = element('img');
    image.alt = '';
    const url = URL.createObjectURL(blob);
    urls.add(url);
    image.src = url;
    view.prepend(image);
    await image.decode();
    return skips.position + skips.background + skips.fit;
  } finally {
    doc.releaseCanvas(canvas);
  }
}

function appendText(sheet, page, texts) {
  sheet.append(element('h2', t('原 PDF 页码') + ' ' + page.pageNo, 'pdf-print-page-number'));
  for (let i = 0; i < page.blocks.length; i += 1) {
    const para = element('p', texts[i] || page.blocks[i].text);
    para.dir = 'auto';
    sheet.append(para);
  }
}

export function initPdfWorkspace(contextForPage) {
  const editDialog = $('pdfEditDialog');
  const editFields = $('pdfEditFields');
  const editStatus = $('pdfEditStatus');
  const editSave = $('pdfEditSave');
  const exportDialog = $('pdfExportDialog');
  const exportStatus = $('pdfExportStatus');
  const review = $('pdfExportReview');
  const prepare = $('pdfExportPrepare');
  const print = $('pdfExportPrint');
  const output = $('pdfPrintOutput');
  const rangeInput = $('pdfExportRange');
  const translate = $('pdfExportTranslate');
  const urls = new Set();
  let job;
  let ready;
  let editPage;
  let exportContext;

  function clearPrint() {
    job?.abort();
    job = null;
    ready = null;
    print.hidden = true;
    output.replaceChildren();
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
    review.replaceChildren();
  }

  function reset() {
    exportContext = null;
    editPage = null;
    if (editDialog.open) editDialog.close();
    if (exportDialog.open) exportDialog.close();
    clearPrint();
  }

  function closeEdit() {
    editPage = null;
    editDialog.close();
  }

  async function openEdit(index) {
    const context = contextForPage(index);
    if (!context) return;
    const session = { context, rows: null };
    editPage = session;
    $('pdfEditPage').textContent = t('原 PDF 页码') + ' ' + context.index + ' / ' + context.doc.numPages;
    editSave.disabled = true;
    editFields.replaceChildren();
    editStatus.textContent = t('正在读取本页译文…');
    editDialog.showModal();
    try {
      const { page, texts, saved } = await context.read(context.index);
      if (editPage !== session || !context.current()) return;
      const values = mergePdfEdits(page.blocks, texts, saved);
      session.texts = texts;
      session.rows = [];
      for (let i = 0; i < page.blocks.length; i += 1) {
        const block = page.blocks[i];
        if (!translatable(block)) continue;
        const row = element('section', '', 'pdf-edit-row');
        const label = element('label', t('段落译文') + ' ' + (i + 1));
        const source = element('p', block.text, 'pdf-edit-source');
        source.dir = 'auto';
        const input = element('textarea');
        input.dir = 'auto';
        input.rows = 3;
        input.value = values[i];
        label.append(input);
        row.append(source, label);
        const initial = values[i];
        const hadEdit = saved[i]?.source === block.text;
        const record = { i, input, initial, block, hadEdit, restored: false };
        session.rows.push(record);
        if (hadEdit) {
          const restore = element('button', t('恢复机器译文'), 'reader-button');
          restore.type = 'button';
          restore.onclick = () => {
            input.value = texts[i] || '';
            record.restored = true;
          };
          input.addEventListener('input', () => { record.restored = false; });
          row.append(restore);
        }
        editFields.append(row);
      }
      editStatus.textContent = session.rows.length ? '' : t('本页没有可编辑的文字。');
      editSave.disabled = !session.rows.length;
    } catch (err) {
      if (editPage === session) editStatus.textContent = t('无法读取本页译文。') + ' ' + err.message;
    }
  }

  $('pdfEditOpen').onclick = () => openEdit();
  $('pdfEditClose').onclick = closeEdit;
  editDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (!editPage?.saving) closeEdit();
  });
  editSave.onclick = async () => {
    const session = editPage;
    if (!session?.rows || session.saving || !session.context.current()) return;
    const changes = [];
    for (const row of session.rows) {
      const value = row.input.value.trim();
      if (row.restored || (!value && row.hadEdit)) changes.push([row.i, null]);
      else if (value && value !== row.initial.trim()) changes.push([row.i, { source: row.block.text, text: value }]);
    }
    if (!changes.length) { closeEdit(); return; }
    session.saving = true;
    $('pdfEditClose').disabled = editSave.disabled = true;
    for (const control of editFields.querySelectorAll('textarea, button')) control.disabled = true;
    try {
      await session.context.save(changes, session.texts);
      if (editPage === session) closeEdit();
    } catch (err) {
      if (editPage === session) editStatus.textContent = t('译文未保存。') + ' ' + err.message;
    } finally {
      if (editPage === session) {
        session.saving = false;
        for (const control of editFields.querySelectorAll('textarea, button')) control.disabled = false;
      }
      $('pdfEditClose').disabled = editSave.disabled = false;
    }
  };

  function closeExport() {
    exportContext = null;
    exportDialog.close();
    clearPrint();
  }

  $('pdfExportOpen').onclick = () => {
    exportContext = contextForPage();
    if (!exportContext) return;
    clearPrint();
    rangeInput.value = String(exportContext.index);
    $('pdfExportAll').textContent = t('全部页') + ' (1–' + exportContext.doc.numPages + ')';
    exportStatus.textContent = '';
    translate.checked = false;
    translate.disabled = !exportContext.canTranslate;
    prepare.disabled = false;
    exportDialog.showModal();
  };
  $('pdfExportAll').onclick = () => {
    rangeInput.value = '1-' + exportContext.doc.numPages;
    clearPrint();
    exportStatus.textContent = '';
  };
  $('pdfExportClose').onclick = closeExport;
  exportDialog.addEventListener('cancel', (event) => { event.preventDefault(); closeExport(); });
  for (const input of [rangeInput, translate, $('pdfExportFormat')]) {
    input.addEventListener('input', () => { clearPrint(); exportStatus.textContent = ''; });
  }

  prepare.onclick = async () => {
    const context = exportContext;
    if (!context?.current()) return;
    const range = readPdfPageRange(rangeInput.value, context.doc.numPages);
    if (!range) {
      exportStatus.textContent = t('请输入有效页码或连续范围，例如 2-5。');
      rangeInput.focus();
      return;
    }
    clearPrint();
    const controller = new AbortController();
    job = controller;
    const { signal } = controller;
    const format = $('pdfExportFormat').value;
    const fill = translate.checked;
    prepare.disabled = true;
    const controls = [rangeInput, $('pdfExportAll'), $('pdfExportFormat'), translate];
    for (const control of controls) control.disabled = true;
    const missingPages = [];
    let translated = 0;
    try {
      for (let i = range.first; i <= range.last; i += 1) {
        exportStatus.textContent = t('正在准备 PDF 页') + ' ' + i + ' / ' + range.last;
        const { page, texts, saved, error } = await context.read(i, fill, signal);
        if (signal.aborted || !context.current()) return;
        const values = mergePdfEdits(page.blocks, texts, saved);
        const missing = page.blocks.filter((block, index) => translatable(block) && !values[index]).length;
        const textCount = values.filter(Boolean).length;
        const facsimile = format === 'layout' || !page.blocks.length;
        const sheet = element('section', '', facsimile ? 'pdf-print-sheet' : 'pdf-print-text');
        output.append(sheet);
        if (!facsimile) appendText(sheet, page, values);
        const skipped = facsimile ? await appendFacsimile(sheet, context.doc, page, values, signal, urls) : 0;
        if (signal.aborted || !context.current()) return;
        translated += textCount - skipped;
        if (missing || skipped || !page.blocks.length) missingPages.push({ index: i, missing, skipped, noText: !page.blocks.length });
        if (error && fill) {
          exportStatus.textContent = t('翻译请求失败。可关闭补译选项，用已有译文重新准备。') + ' ' + error.message;
          return;
        }
      }
      for (const item of missingPages) {
        const labels = [];
        if (item.missing) labels.push(t('无译文') + ' × ' + item.missing);
        if (item.skipped) labels.push(t('无法放入版式') + ' × ' + item.skipped);
        if (item.noText) labels.push(t('无可提取文字，保留原页图像'));
        const line = element('li', t('原 PDF 页码') + ' ' + item.index + ' · ' + labels.join(' · '));
        if (!item.noText) {
          const edit = element('button', t('编辑本页译文'), 'reader-button');
          edit.type = 'button';
          edit.onclick = () => { closeExport(); openEdit(item.index); };
          line.append(edit);
        }
        review.append(line);
      }
      exportStatus.textContent = translated
        ? (missingPages.length ? t('以下内容将保留原文。请核对后继续。') : t('已准备好。请在打印窗口选择「另存为 PDF」。'))
        : t('所选范围没有可导出的译文，请先生成或编辑译文。');
      if (translated) {
        ready = context;
        print.hidden = false;
      }
    } catch (err) {
      if (!signal.aborted) exportStatus.textContent = t('无法准备 PDF。') + ' ' + err.message;
    } finally {
      if (job === controller) {
        job = null;
        prepare.disabled = false;
        for (const control of controls) control.disabled = false;
        translate.disabled = !context.canTranslate;
        if (!ready) {
          output.replaceChildren();
          for (const url of urls) URL.revokeObjectURL(url);
          urls.clear();
        }
      }
    }
  };

  print.onclick = () => {
    if (!ready?.current()) return;
    exportDialog.close();
    document.body.classList.add('pdf-printing');
    const title = document.title;
    document.title = ready.title;
    try { window.print(); }
    finally {
      document.title = title;
      document.body.classList.remove('pdf-printing');
      if (ready) exportDialog.showModal();
    }
  };

  return { reset };
}
