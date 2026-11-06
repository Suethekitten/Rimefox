// Committed OCR component assets must match the download metadata the extension ships with.
// Runs in every unit job, so a stale or altered ZIP fails before a Release can attach it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OCR_COMPONENT_RELEASES } from '../lib/ocr/feature.js';
import { releaseAssets, verifyComponentZip, ASSET_DIR } from '../tools/ocr-release-assets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const committed = fs.existsSync(path.join(root, ASSET_DIR))
  ? fs.readdirSync(path.join(root, ASSET_DIR)).filter((n) => n.endsWith('.zip')) : [];

test('every committed OCR component ZIP is pinned in lib/ocr/feature.js and verifies against this checkout', () => {
  for (const name of committed) {
    const pinned = Object.entries(OCR_COMPONENT_RELEASES).find(([, e]) => e.connector.endsWith('/' + name));
    assert.ok(pinned, name + ' is committed but no platform download points at it');
    const result = verifyComponentZip(root, pinned[0], pinned[1], path.join(root, ASSET_DIR, name));
    assert.equal(result.sha256, pinned[1].sha256);
  }
});

test('the release tag of a committed asset attaches it automatically and needs no draft', async () => {
  for (const [platform, entry] of Object.entries(OCR_COMPONENT_RELEASES)) {
    const tag = /\/releases\/download\/(v\d+\.\d+\.\d+)\//.exec(entry.connector)?.[1];
    const name = entry.connector.split('/').pop();
    if (!tag || !committed.includes(name)) continue;
    const plan = await releaseAssets(root, tag);
    assert.equal(plan.draft, false, platform + ' asset is committed, so the release need not wait for a manual upload');
    assert.ok(plan.attach.some((f) => f.endsWith(name)) && plan.attach.some((f) => f.endsWith(name + '.sha256')));
  }
});

test('a tampered ZIP or checksum file is rejected', () => {
  const name = committed[0];
  if (!name) return;
  const [platform, entry] = Object.entries(OCR_COMPONENT_RELEASES).find(([, e]) => e.connector.endsWith('/' + name));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rimefox-asset-test-'));
  try {
    const copy = path.join(work, name);
    const bytes = fs.readFileSync(path.join(root, ASSET_DIR, name));
    bytes[bytes.length - 30] ^= 0xff;
    fs.writeFileSync(copy, bytes);
    fs.copyFileSync(path.join(root, ASSET_DIR, name + '.sha256'), copy + '.sha256');
    assert.throws(() => verifyComponentZip(root, platform, entry, copy), /SHA-256 differs/);
    fs.copyFileSync(path.join(root, ASSET_DIR, name), copy);
    fs.writeFileSync(copy + '.sha256', '0'.repeat(64) + '  ' + name + '\n');
    assert.throws(() => verifyComponentZip(root, platform, entry, copy), /\.sha256 does not match/);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
