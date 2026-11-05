// Original column is a read-only clone; only #bookContent enters the translation queue.
export function setParallelView(enabled) {
  const columns = document.getElementById('documentColumns');
  const original = document.getElementById('sourceContent');
  const content = document.getElementById('bookContent');
  columns.classList.toggle('parallel-view', !!enabled);
  original.hidden = !enabled;
  original.textContent = '';
  if (enabled) {
    for (const child of content.childNodes) original.appendChild(child.cloneNode(true));
    for (const el of original.querySelectorAll('[id]')) el.removeAttribute('id');
    content.setAttribute('aria-label', '译文');
  } else content.removeAttribute('aria-label');
}
