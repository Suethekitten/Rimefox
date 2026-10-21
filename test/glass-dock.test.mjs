// 液态玻璃工具坞单测：槽位几何 + 位移滤镜字符串（纯函数，不碰 DOM）。
// 运行：node test/glass-dock.test.mjs
import assert from 'node:assert/strict';

import { clamp, slotPosition, rubberBand, nearestSlot, slotAt, navTop } from '../lib/liquid-glass/geometry.js';
import { displacementFilter } from '../lib/liquid-glass/filter.js';

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

console.log('\n[槽位几何]');

t('5 个槽位时透镜左边缘逐个槽位平移', () => {
  const step = 62;
  assert.equal(slotPosition(0, step, step), 0);
  assert.equal(slotPosition(1, step, step), 62);
  assert.equal(slotPosition(4, step, step), 248);
});

t('透镜比槽位窄时仍然居中', () => {
  const step = 62;
  assert.equal(slotPosition(1, step, 50), 68);
  assert.equal(slotPosition(4, step, 50), 254);
});

t('竖向导航条目上边缘 = 内边距 + 序号 × 步长', () => {
  assert.equal(navTop(0, 35, 6), 6);
  assert.equal(navTop(3, 35, 6), 111);
});

t('橡皮筋在两端逐渐变黏，不会硬顶', () => {
  const min = 0;
  const max = 248;
  const span = 15.5;
  const left = rubberBand(-40, min, max, span);
  const right = rubberBand(300, min, max, span);
  assert.ok(left < 0 && left > -40, '左端应被拉回一点');
  assert.ok(right > max && right < 300, '右端应被拉回一点');
  assert.equal(rubberBand(100, min, max, span), 100);
});

t('最近槽位：距离相同按拖动方向取前/后', () => {
  const slots = [0, 1, 2, 3, 4];
  const step = 62;
  // 0 与 1 的槽位中心（31 / 93）正中间是 62：距离相同，按方向定向
  assert.equal(nearestSlot(slots, 62, step, 1), 1);
  assert.equal(nearestSlot(slots, 62, step, -1), 0);
  assert.equal(nearestSlot(slots, 100, step, 0), 1);
});

t('指针横坐标换算槽位并夹在两端', () => {
  assert.equal(slotAt(5, 0, 0, 310, 5), 0);
  assert.equal(slotAt(311, 0, 0, 310, 5), -1);
  assert.equal(slotAt(309, 0, 0, 310, 5), 4);
  assert.equal(slotAt(10, 0, 5, 310, 5), 0);
  assert.equal(slotAt(10, 0, 5, 0, 5), -1);
});

t('clamp', () => {
  assert.equal(clamp(-3, 0, 1), 0);
  assert.equal(clamp(3, 0, 1), 1);
  assert.equal(clamp(0.5, 0, 1), 0.5);
});

console.log('\n[位移滤镜]');

function decode(url) {
  return decodeURIComponent(url.slice(url.indexOf(',') + 1, url.lastIndexOf('#')));
}

t('三通道色散按 2cab / 1cab / 0 依次错开', () => {
  const url = displacementFilter({ width: 80, height: 40, radius: 20, depth: 4, strength: 100, chromaticAberration: 13 });
  assert.ok(url.startsWith('data:image/svg+xml;utf8,'));
  assert.ok(url.endsWith('#displace'));
  const svg = decode(url);
  assert.ok(svg.includes('scale="126"'), 'R 通道 = strength + 2cab');
  assert.ok(svg.includes('scale="113"'), 'G 通道 = strength + 1cab');
  assert.ok(svg.includes('scale="100"'), 'B 通道 = strength');
  assert.ok(svg.includes('id="displace"'));
  assert.ok(svg.includes('feDisplacementMap'));
  assert.ok(svg.includes('feImage'));
});

t('没有色散时三个通道同强度', () => {
  const svg = decode(displacementFilter({ width: 20, height: 20, radius: 10, depth: 2, strength: 8 }));
  assert.equal((svg.match(/scale="8"/g) || []).length, 3);
});

t('位移贴图尺寸和圆角写进 SVG', () => {
  const svg = decode(displacementFilter({ width: 62, height: 44, radius: 22, depth: 3, strength: 14, chromaticAberration: 1.2 }));
  assert.ok(svg.includes('viewBox="0 0 62 44"'));
  // 位移贴图本身是嵌套的 data URL，外层的圆角是百分号编码的
  assert.ok(svg.includes('rx%3D%2222%22'));
  assert.ok(svg.includes('scale="16.4"'));
});

console.log('');
if (fail) {
  console.log('✗ ' + fail + ' 条失败，' + pass + ' 条通过');
  process.exit(1);
}
console.log('✓ ' + pass + ' 条全部通过');
