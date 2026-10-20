#!/usr/bin/env node
// 安装包：运行时文件 + 许可文件（LICENSE / THIRD-PARTY-NOTICES.md / licenses/），商店包和 GitHub Release 共用这一份白名单。
//   node tools/package-store.mjs            → dist/Rimefox-v<版本>-store.zip，manifest.json 在 ZIP 根目录（商店要求）
//   node tools/package-store.mjs --release  → dist/Rimefox-v<版本>.zip，同样的文件放在 Rimefox/ 文件夹里
//                                            （用户覆盖解压同一个文件夹升级，扩展 ID 与设置不变）
// 0.8.5 以前 Release 包是 rsync 整仓再排除几项，商店截图、测试、开发文档都进了用户下载的 zip。
// Node 18+, no npm packages or external zip executable required.
import { readFile, readdir, lstat, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = process.argv.slice(2).includes('--release');
const prefix = release ? 'Rimefox/' : '';
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
const core = await readFile(resolve(root, 'content/core.js'), 'utf8');
if (core.match(/DT\.VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1] !== manifest.version) throw Error('manifest / DT.VERSION mismatch');
if (!/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) throw Error('Invalid version');
const entries = [];
// 注意：文档类只排除 .md 本身，不能写成 PRIVACY.*——那会把 lib/privacy.js 一起排掉。
const excluded = /^(?:\.git|\.github|test|selftest|docs|tools|node_modules|package\.(?:json|ps1|bat)|README\.md|HANDOFF\.md|AGENTS\.md|PRIVACY\.md|CHANGELOG\.md|SECURITY\.md|\.DS_Store)$/i;
async function collect(name) {
  const stat = await lstat(resolve(root, name));
  if (stat.isSymbolicLink()) throw Error(`Symlinks are not allowed: ${name}`);
  const base = name.split('/').at(-1);
  if (excluded.test(base) || base.startsWith('.') ||
      /^(?:Thumbs\.db|desktop\.ini|__MACOSX|coverage|dist|build)$/i.test(base) ||
      /(?:\.(?:log|map|tmp|bak|psd|zip|pem|key)|~)$/i.test(base) ||
      (name.startsWith('icons/') && /^(?:source\.|preview-|icon512\.)/i.test(base))) return;
  if (stat.isDirectory()) {
    for (const child of (await readdir(resolve(root, name))).sort()) await collect(`${name}/${child}`);
  } else if (stat.isFile()) entries.push({ name, data: await readFile(resolve(root, name)) });
  else throw Error(`Unsupported file: ${name}`);
}
for (const name of [
  'manifest.json', 'background.js', 'lib', 'content', 'options', 'popup', 'welcome', 'icons',
  'LICENSE', 'THIRD-PARTY-NOTICES.md', 'licenses'
]) await collect(name);
// _locales 是按浏览器界面语言分开的 manifest 文案；没有就不收（0.9.5 及以前没有）。
if (await lstat(resolve(root, '_locales')).then(() => true, () => false)) await collect('_locales');
// 商店按 _locales/*/messages.json 识别“包支持哪些语言”；漏收这个目录，Edge 就只会看到一种语言。
// manifest 用 __MSG_xxx__ 引用的文案必须在每种语言的 messages.json 里都有（缺 key 时浏览器会把
// 占位符原样显示出来），默认语言的 messages.json 也必须在包里。
const localeMessages = entries.filter((e) => /^_locales\/[^/]+\/messages\.json$/.test(e.name));
const messageKeys = [manifest.name, manifest.short_name, manifest.description]
  .map((value) => {
    const hit = /^__MSG_(.+)__$/.exec(String(value == null ? '' : value));
    return hit ? hit[1] : null;
  })
  .filter(Boolean);
if (localeMessages.length && !manifest.default_locale) throw Error('_locales exists but manifest.default_locale is missing');
if (messageKeys.length && !manifest.default_locale) throw Error('manifest uses __MSG_*__ but default_locale is missing');
if (manifest.default_locale) {
  const defaultMessages = `_locales/${manifest.default_locale}/messages.json`;
  if (!entries.some((e) => e.name === defaultMessages)) throw Error(`Missing default locale messages: ${defaultMessages}`);
}
for (const e of localeMessages) {
  let messages;
  try {
    messages = JSON.parse(e.data.toString('utf8'));
  } catch (err) {
    throw Error(`Invalid locale messages JSON: ${e.name}`);
  }
  for (const key of messageKeys) {
    if (!messages[key] || typeof messages[key].message !== 'string' || !messages[key].message.trim()) {
      throw Error(`Missing "${key}" message: ${e.name}`);
    }
  }
}
for (const size of [16, 32, 48, 128]) {
  const icon = entries.find(e => e.name === manifest.icons?.[size]);
  if (!icon || icon.data.length < 24 || icon.data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || icon.data.readUInt32BE(16) !== size || icon.data.readUInt32BE(20) !== size) throw Error(`Missing or invalid ${size}px PNG icon`);
}
// Fail if a manifest runtime reference would be absent from the allowlisted ZIP.
const refs = [manifest.background.service_worker, manifest.action.default_popup, manifest.options_ui.page,
  ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
  ...manifest.content_scripts.flatMap(s => [...(s.js || []), ...(s.css || [])]),
  ...manifest.web_accessible_resources.flatMap(r => r.resources)];
for (const ref of refs) if (!entries.some(e => e.name === ref)) throw Error(`Missing runtime reference: ${ref}`);
// 欢迎页由 background 用 runtime.getURL 打开，不在 manifest 引用里；单独校验三个入口文件，
// 避免以后改名 / 漏收目录时商店包缺页。
for (const name of ['welcome/index.html', 'welcome/welcome.css', 'welcome/welcome.js']) {
  if (!entries.some((e) => e.name === name)) throw Error(`Missing welcome asset: ${name}`);
}
// MIT 等许可证要求版权与许可声明随副本分发：商店 ZIP 也是一次分发，缺一个就拒绝出包。
for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.md', 'licenses/oneaifw-MIT.txt']) {
  if (!entries.some((e) => e.name === name)) throw Error(`Missing legal file: ${name}`);
}
function crc32(data) {
  let c = 0xffffffff;
  for (const b of data) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); }
  return (c ^ 0xffffffff) >>> 0;
}
// Standard ZIP32, DEFLATE, UTF-8 filenames, fixed timestamp for reproducibility.
const local = [], central = [];
let offset = 0;
for (const { name, data } of entries) {
  const filename = Buffer.from(prefix + name), compressed = deflateRawSync(data), crc = crc32(data);
  if (filename.length > 65535 || compressed.length >= 0xffffffff || data.length >= 0xffffffff || offset >= 0xffffffff) throw Error('ZIP64 is not supported');
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6);
  h.writeUInt16LE(8, 8); h.writeUInt16LE(33, 12); h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(compressed.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(filename.length, 26);
  local.push(h, filename, compressed);
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); h.copy(c, 6, 4, 30);
  c.writeUInt32LE(offset, 42); central.push(c, filename);
  offset += h.length + filename.length + compressed.length;
}
const directory = Buffer.concat(central), end = Buffer.alloc(22);
if (entries.length >= 65535 || offset + directory.length >= 0xffffffff) throw Error('ZIP32 limit exceeded');
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
const destination = resolve(root, release ? `dist/Rimefox-v${manifest.version}.zip` : `dist/Rimefox-v${manifest.version}-store.zip`);
await mkdir(dirname(destination), { recursive: true });
const temporary = `${destination}.${process.pid}.tmp`;
try { await writeFile(temporary, Buffer.concat([...local, directory, end]), { flag: 'wx' }); await rename(temporary, destination); }
finally { await rm(temporary, { force: true }); }
console.log(destination);
for (const e of entries) console.log(`${e.data.length.toString().padStart(8)}  ${prefix}${e.name}`);
console.log(`${entries.length} files; runtime files + LICENSE / THIRD-PARTY-NOTICES.md / licenses/; ` +
  (release ? 'inside the Rimefox/ folder (GitHub Release).' : 'manifest.json is at the ZIP root.'));
