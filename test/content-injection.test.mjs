// 注入清单一致性：ensureInjected 的文件列表必须和 manifest.json 的 content_scripts[0] 完全一致。
// 历史教训：ensureInjected 漏了 units.js / input.js，页面已经在跑、后台补注入时
// hover.js 取不到 DT.units，直接抛 Uncaught TypeError。
// 运行：node test/content-injection.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    fail += 1;
    console.log('  ✗ ' + name + '\n      ' + (err && err.message));
  }
}

console.log('\n[内容脚本注入清单]');

const expected = manifest.content_scripts[0].js;
const start = source.indexOf('async function ensureInjected');
assert.ok(start >= 0, 'background.js 里找不到 ensureInjected');
const end = source.indexOf('return true;', start);
const chunk = source.slice(start, end);
// ensureInjected 里有两个 files 数组：先 insertCSS，后 executeScript；取最后一个
const matches = [...chunk.matchAll(/files:\s*\[([\s\S]*?)\]/g)];
const match = matches[matches.length - 1];
const actual = match ? [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];

t('ensureInjected 与 manifest 使用同一份文件、同一顺序', () => {
  assert.deepEqual(actual, expected);
});

t('依赖顺序：units 在 dom 之前，input 在 hover / pip / dock 之前', () => {
  assert.ok(actual.indexOf('content/units.js') >= 0, '缺少 units.js');
  assert.ok(actual.indexOf('content/input.js') >= 0, '缺少 input.js');
  assert.ok(actual.indexOf('content/units.js') < actual.indexOf('content/dom.js'));
  assert.ok(actual.indexOf('content/input.js') < actual.indexOf('content/hover.js'));
});

t('清单里的每个文件都存在', () => {
  expected.forEach((file) => {
    assert.ok(fs.existsSync(path.join(root, file)), '缺少文件：' + file);
  });
});

t('hover.js 在 DT.units 缺失时直接退出，不再抛 Uncaught TypeError', () => {
  const sandbox = { window: { __DT: {} } };
  vm.runInNewContext(
    fs.readFileSync(path.join(root, 'content/hover.js'), 'utf8'),
    sandbox,
    { filename: 'content/hover.js' }
  );
  // 这里只要不抛异常即可；没有 units 时不应注册半成品 DT.hover
  assert.equal(sandbox.window.__DT.hover, undefined);
});

console.log('');
if (fail) {
  console.log('✗ ' + fail + ' 条失败，' + pass + ' 条通过');
  process.exit(1);
}
console.log('✓ ' + pass + ' 条全部通过');
