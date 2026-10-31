// EPUB reader static contract checks. Runtime parser/sanitizer/UI are covered by
// test/reader-smoke.html and tools/e2e-reader.mjs (real Chrome).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { READER_LIMITS } from '../lib/reader/store.js';
import { READER_ALLOWED_TAGS, READER_DROP_TAGS } from '../lib/reader/sanitize.js';
import { EPUB_LIMITS, EpubError } from '../lib/reader/epub.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

assert.ok(READER_LIMITS.maxBookBytes > 0 && READER_LIMITS.maxBookBytes <= 100 * 1024 * 1024);
assert.ok(READER_LIMITS.maxLibraryBytes >= READER_LIMITS.maxBookBytes);
assert.ok(EPUB_LIMITS.maxEntryBytes > 0 && EPUB_LIMITS.maxCompressionRatio > 1);
assert.ok(READER_ALLOWED_TAGS.includes('p') && READER_ALLOWED_TAGS.includes('b') && READER_ALLOWED_TAGS.includes('a'));
assert.ok(READER_DROP_TAGS.includes('script') && READER_DROP_TAGS.includes('iframe') && READER_DROP_TAGS.includes('form'));
assert.equal(new EpubError('drm_protected', 'x').code, 'drm_protected');

assert.deepEqual(manifest.permissions, ['storage', 'activeTab', 'scripting', 'contextMenus']);
assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
assert.equal(manifest.optional_permissions, undefined);
for (const file of ['reader/index.html', 'reader/reader.css', 'reader/reader.js', 'lib/reader/epub.js', 'lib/reader/sanitize.js', 'lib/reader/store.js', 'lib/reader/translate.js', 'lib/vendor/fflate.browser.mjs', 'docs/READER-ARCHITECTURE.md']) {
  assert.ok(fs.existsSync(path.join(ROOT, file)), 'missing ' + file);
}
const doc = read('docs/READER-ARCHITECTURE.md');
assert.ok(read('popup/index.html').includes('id="openReader"'), 'popup reader entry missing');
assert.ok(read('reader/index.html').includes('id="bookContent"') && read('reader/index.html').includes('id="footnotePanel"'), 'reader page structure missing');
assert.ok(read('reader/index.html').includes('id="letterSpacing"') && read('reader/index.html').includes('id="paragraphSpacing"') && read('reader/index.html').includes('id="fullscreenToggle"'), 'reader typography/fullscreen controls missing');
assert.ok(read('reader/index.html').includes('id="userFontInput"') && read('reader/index.html').includes('id="targetSelect"'), 'reader user-font/target controls missing');
for (const token of ['BookDocument', 'PdfDocument', 'noCache: true', 'rimefox-reader', 'drm_protected']) {
  assert.ok(doc.includes(token), 'architecture doc missing ' + token);
}
const source = read('lib/reader/epub.js');
for (const token of ['unzipSync', 'maxCompressionRatio', 'drm_protected', 'unsupported_layout', 'safeName']) {
  assert.ok(source.includes(token), 'epub parser missing ' + token);
}
console.log('Reader contract: OK');
