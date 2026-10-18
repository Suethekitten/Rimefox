#!/usr/bin/env node
// Node 18+, no npm packages or external zip executable required.
import { readFile, readdir, lstat, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
const core = await readFile(resolve(root, 'content/core.js'), 'utf8');
if (core.match(/DT\.VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1] !== manifest.version) throw Error('manifest / DT.VERSION mismatch');
if (!/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) throw Error('Invalid version');
const entries = [];
// 注意：文档类只排除 .md 本身，不能写成 PRIVACY.*——那会把 lib/privacy.js 一起排掉。
const excluded = /^(?:\.git|\.github|test|selftest|docs|tools|node_modules|package\.(?:json|ps1|bat)|README\.md|HANDOFF\.md|AGENTS\.md|PRIVACY\.md|CHANGELOG\.md|SECURITY\.md|THIRD-PARTY-NOTICES\.md|\.DS_Store)$/i;
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
for (const name of ['manifest.json', 'background.js', 'lib', 'content', 'options', 'popup', 'icons']) await collect(name);
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
function crc32(data) {
  let c = 0xffffffff;
  for (const b of data) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); }
  return (c ^ 0xffffffff) >>> 0;
}
// Standard ZIP32, DEFLATE, UTF-8 filenames, fixed timestamp for reproducibility.
const local = [], central = [];
let offset = 0;
for (const { name, data } of entries) {
  const filename = Buffer.from(name), compressed = deflateRawSync(data), crc = crc32(data);
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
const destination = resolve(root, `dist/Rimefox-v${manifest.version}-store.zip`);
await mkdir(dirname(destination), { recursive: true });
const temporary = `${destination}.${process.pid}.tmp`;
try { await writeFile(temporary, Buffer.concat([...local, directory, end]), { flag: 'wx' }); await rename(temporary, destination); }
finally { await rm(temporary, { force: true }); }
console.log(destination);
for (const e of entries) console.log(`${e.data.length.toString().padStart(8)}  ${e.name}`);
console.log(`${entries.length} files; manifest.json is at the ZIP root.`);
