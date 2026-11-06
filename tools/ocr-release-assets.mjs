// OCR component assets that ship with a Release tag.
//
// lib/ocr/feature.js pins each platform's download URL, SHA-256 and sizes. A platform whose URL points at the
// tag being released either has its ZIP (and .sha256) committed in release-assets/ocr/ — then this script verifies
// it and the Release workflow attaches it automatically — or it has not, and the Release stays a draft until a
// maintainer uploads the asset by hand (the original Windows flow, see native/ocr-host/README.md).
//
// Verification: committed ZIP = pinned SHA-256 / sizes = its .sha256 file; every entry matches the package's
// SHA256SUMS; preview.json names the right platform and version; and the package's sourceDigest equals the
// digest of the component inputs in this checkout (content only — CI checkouts are shallow, so the commit id is
// not compared). Any mismatch throws, so neither the unit test nor the Release can pass with a stale ZIP.
//
//   node tools/ocr-release-assets.mjs v0.17.2   → prints JSON { attach: [paths], draft: bool, platforms: [...] }
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unzipSync } from '../lib/vendor/fflate.browser.mjs';
import { componentProvenance } from './ocr-package-inputs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ASSET_DIR = 'release-assets/ocr';
const sha = (data) => createHash('sha256').update(data).digest('hex');

export function verifyComponentZip(root, platform, entry, file) {
  const zip = fs.readFileSync(file);
  const name = path.basename(file);
  if (sha(zip) !== entry.sha256) throw new Error(`${name}: SHA-256 differs from lib/ocr/feature.js`);
  if (zip.length !== entry.downloadBytes) throw new Error(`${name}: size differs from downloadBytes`);
  const sidecar = fs.readFileSync(file + '.sha256', 'utf8').trim();
  if (sidecar !== entry.sha256 + '  ' + name) throw new Error(`${name}.sha256 does not match the ZIP`);
  const entries = unzipSync(new Uint8Array(zip));
  const total = Object.values(entries).reduce((sum, bytes) => sum + bytes.length, 0);
  if (total !== entry.diskBytes) throw new Error(`${name}: unpacked size differs from diskBytes`);
  const listed = new Set();
  for (const line of new TextDecoder().decode(entries.SHA256SUMS).trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  (.+)$/i.exec(line);
    if (!match || !entries[match[2]] || sha(entries[match[2]]) !== match[1].toLowerCase()) throw new Error(`${name}: invalid package checksum line`);
    listed.add(match[2]);
  }
  if (Object.keys(entries).some((n) => n !== 'SHA256SUMS' && !listed.has(n))) throw new Error(`${name}: unchecked package entry`);
  const preview = JSON.parse(new TextDecoder().decode(entries['preview.json']));
  if (preview.platform !== platform) throw new Error(`${name}: preview.json platform is ${preview.platform}`);
  if (!name.includes('-' + preview.version + '-')) throw new Error(`${name}: file name does not carry component version ${preview.version}`);
  if (preview.dirtyWorktree) throw new Error(`${name}: built from a dirty worktree`);
  const inputs = componentProvenance(root, platform);
  if (preview.sourceDigest !== inputs.sourceDigest) throw new Error(`${name}: built from different component inputs than this checkout`);
  return { platform, file, name, sha256: entry.sha256, version: preview.version };
}

export async function releaseAssets(root, tag) {
  const { OCR_COMPONENT_RELEASES } = await import(pathToFileURL(path.join(root, 'lib/ocr/feature.js')).href + '?t=' + Date.now());
  const prefix = `https://github.com/Suethekitten/Rimefox/releases/download/${tag}/`;
  const platforms = [];
  const attach = [];
  let draft = false;
  for (const [platform, entry] of Object.entries(OCR_COMPONENT_RELEASES)) {
    if (!entry?.connector?.startsWith(prefix)) continue;
    const name = entry.connector.slice(prefix.length);
    const file = path.join(root, ASSET_DIR, name);
    if (!fs.existsSync(file)) { draft = true; platforms.push({ platform, name, committed: false }); continue; }
    const verified = verifyComponentZip(root, platform, entry, file);
    attach.push(file, file + '.sha256');
    platforms.push({ ...verified, committed: true });
  }
  return { tag, attach, draft, platforms };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const tag = process.argv[2];
  if (!/^v\d+\.\d+\.\d+$/.test(tag || '')) throw new Error('Usage: node tools/ocr-release-assets.mjs vX.Y.Z');
  console.log(JSON.stringify(await releaseAssets(ROOT, tag), null, 2));
}
