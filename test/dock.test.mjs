// 悬浮入口位置（0.9.3）：DT.dockPlace / DT.dockDefault 纯函数 —— 吸附、悬浮、夹回、窄屏、坏值。
// 运行：node test/dock.test.mjs
import assert from 'node:assert/strict';
import loose from 'node:assert'; // 跨 vm realm 的对象原型不同，结构比较用宽松版
import fs from 'node:fs';
import vm from 'node:vm';

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

const src = fs.readFileSync(new URL('../content/core.js', import.meta.url), 'utf8');
const win = {};
function fakeEl() {
  return { style: {}, setAttribute() {}, appendChild() {}, remove() {} };
}
vm.runInContext(
  src,
  vm.createContext({
    window: win,
    document: { createElement: fakeEl, createElementNS: fakeEl, documentElement: fakeEl(), body: null },
    navigator: { userAgent: 'node-test', platform: 'node', userAgentData: null },
    console,
    setTimeout,
    clearTimeout
  })
);
const DT = win.__DT;

console.log('\n[悬浮入口位置纯函数]');

t('core.js 暴露 dockPlace / dockDefault', () => {
  assert.equal(typeof DT.dockPlace, 'function');
  assert.equal(typeof DT.dockDefault, 'function');
});

const view = { vw: 1280, vh: 800, w: 52, h: 240 };

t('离左边近松手 → 吸附到左边（x=0，side=left）', () => {
  loose.deepEqual(DT.dockPlace({ x: 30, y: 200 }, view), { x: 0, y: 200, side: 'left', snapped: 'left' });
});

t('离右边近松手 → 贴右边缘（x=vw-w，side=right）', () => {
  loose.deepEqual(DT.dockPlace({ x: 1280 - 52 - 40, y: 200 }, view), { x: 1228, y: 200, side: 'right', snapped: 'right' });
});

t('页面中间松手 → 自由悬浮不吸附，side 按左右半区定', () => {
  loose.deepEqual(DT.dockPlace({ x: 700, y: 300 }, view), { x: 700, y: 300, side: 'right', snapped: null });
  const left = DT.dockPlace({ x: 300, y: 300 }, view);
  assert.equal(left.side, 'left');
  assert.equal(left.snapped, null);
});

t('竖直越界夹回视口内（上 8 / 下 vh-h-8）', () => {
  assert.equal(DT.dockPlace({ x: 700, y: -500 }, view).y, 8);
  assert.equal(DT.dockPlace({ x: 700, y: 99999 }, view).y, 800 - 240 - 8);
});

t('NaN / 缺字段 → 落到左上安全位，不抛异常', () => {
  const got = DT.dockPlace({ x: NaN, y: undefined }, view);
  loose.deepEqual(got, { x: 8, y: 8, side: 'left', snapped: null });
});

t('窄屏吸附区自动收窄：左 / 中 / 右三种落点互不抢', () => {
  const narrow = { vw: 200, vh: 600, w: 52, h: 240 }; // room=132 < 144 → snap=66
  assert.equal(DT.dockPlace({ x: 60, y: 100 }, narrow).snapped, 'left');
  assert.equal(DT.dockPlace({ x: 88, y: 100 }, narrow).snapped, 'right');
  assert.equal(DT.dockPlace({ x: 74, y: 100 }, narrow).snapped, null);
});

t('默认位置：贴 dockSide 的边，竖直在 58% 高度居中（与旧 CSS 一致）', () => {
  loose.deepEqual(DT.dockDefault('right', view), { x: 1228, y: 344 });
  assert.equal(DT.dockDefault('left', view).x, 0);
  assert.equal(DT.dockDefault('left', view).y, 344);
});

t('矮屏默认位置也夹回视口内', () => {
  const short = { vw: 1280, vh: 300, w: 52, h: 240 };
  assert.equal(DT.dockDefault('right', short).y, 300 - 240 - 8);
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;