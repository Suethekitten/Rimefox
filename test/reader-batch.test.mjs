import assert from 'node:assert/strict';
import test from 'node:test';
import { batchOf } from '../lib/reader/translate.js';

const unit = (n, chars, protocol = '') => ({ text: 'p' + n + ' ' + 'x'.repeat(chars), inlineProtocol: protocol });

test('EPUB batches pack paragraphs in order instead of one request per paragraph (QA G5)', () => {
  const units = Array.from({ length: 46 }, (_, i) => unit(i, 150 + (i % 5) * 40));
  const groups = batchOf(units);
  assert.deepEqual(groups.flatMap((g) => g.items), units);
  assert.ok(groups.length <= 12, 'groups: ' + groups.length);
  groups.forEach((g) => assert.ok(g.items.length <= 8));
  groups.slice(0, -1).forEach((g) => assert.ok(g.items.length > 1));
});

test('protocols are batched separately and each keeps its own open group', () => {
  const units = [unit(1, 50), unit(2, 50, 'inline-v1'), unit(3, 50), unit(4, 50, 'inline-v1')];
  const groups = batchOf(units);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.items.length), [2, 2]);
});

test('a single oversize paragraph gets its own batch', () => {
  const groups = batchOf([unit(1, 100), unit(2, 2000), unit(3, 100)]);
  assert.deepEqual(groups.map((g) => g.items.length), [1, 1, 1]);
});
