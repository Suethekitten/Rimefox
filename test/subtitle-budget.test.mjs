// 字幕付费预算单测：纯函数，不依赖浏览器 / 网络。
// 运行：node test/subtitle-budget.test.mjs
import assert from 'node:assert/strict';

import {
  SUBTITLE_BUDGET,
  SUBTITLE_BUDGET_ALL_TABS,
  createBudgetState,
  budgetCheck,
  budgetReserve,
  budgetSettle,
  budgetRelease,
  budgetSnapshot
} from '../lib/subtitle-budget.js';

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

console.log('\n[subtitle budget]');

const RULE = {
  windowMs: 1000,
  windowRequests: 4,
  windowChars: 40,
  tabRequests: 10,
  tabChars: 100,
  globalRequests: 100,
  globalChars: 1000
};

t('预留后回填：实际 1 次就把多占的 1 次退回来', function () {
  const s = createBudgetState(0, null);
  const entry = budgetReserve(s, 100, { requests: 2, chars: 5 }, RULE);
  assert.ok(entry);
  assert.equal(s.requests, 2);
  assert.equal(s.chars, 5);
  budgetSettle(s, entry, 1, 100);
  assert.equal(s.requests, 1, '一次成功请求只算 1 次 HTTP');
  assert.equal(s.chars, 5, '字符数在发送前就按整批记，不回填');
});

t('实际超过预留时照实补记，不会漏记', function () {
  const s = createBudgetState(0, null);
  const entry = budgetReserve(s, 100, { requests: 1, chars: 1 }, RULE);
  budgetSettle(s, entry, 3, 100);
  assert.equal(s.requests, 3);
});

t('发送前预算不够：返回 null，且不写账', function () {
  const s = createBudgetState(0, null);
  assert.ok(budgetReserve(s, 100, { requests: 4, chars: 1 }, RULE));
  assert.equal(budgetReserve(s, 100, { requests: 1, chars: 1 }, RULE), null);
  assert.equal(s.requests, 4);
});

t('窗口过去后恢复；总量到顶后窗口刷新也不恢复', function () {
  const s = createBudgetState(0, null);
  for (let i = 0; i < 4; i += 1) assert.ok(budgetReserve(s, i, { requests: 1, chars: 1 }, RULE));
  assert.equal(budgetReserve(s, 10, { requests: 1, chars: 1 }, RULE), null);
  assert.ok(budgetReserve(s, 1002, { requests: 1, chars: 1 }, RULE)); // 窗口外，总额还没到 10
  const full = createBudgetState(0, null);
  for (let i = 0; i < 10; i += 1) assert.ok(budgetReserve(full, i * 2000, { requests: 1, chars: 1 }, RULE));
  assert.equal(budgetReserve(full, 100000, { requests: 1, chars: 1 }, RULE), null);
});

t('字符上限与次数上限同时生效（按“当前 + 本次”判断，不会顶穿）', function () {
  const s = createBudgetState(0, null);
  assert.ok(budgetReserve(s, 0, { requests: 1, chars: 39 }, RULE));
  assert.ok(budgetReserve(s, 1, { requests: 1, chars: 1 }, RULE), '39 + 1 = 40 刚好到顶');
  assert.equal(budgetReserve(s, 2, { requests: 1, chars: 1 }, RULE), null, '40 + 1 超字符上限');
  const byCount = createBudgetState(0, null);
  for (let i = 0; i < 4; i += 1) assert.ok(budgetReserve(byCount, i, { requests: 1, chars: 1 }, RULE));
  assert.equal(budgetReserve(byCount, 5, { requests: 1, chars: 0 }, RULE), null, '窗口 4 次已满');
});

t('整笔撤销：跨标签页额度不够时退回本标签页的预留', function () {
  const s = createBudgetState(0, null);
  const entry = budgetReserve(s, 0, { requests: 2, chars: 7 }, RULE);
  budgetRelease(s, entry);
  assert.equal(s.requests, 0);
  assert.equal(s.chars, 0);
  assert.equal(s.win.length, 0);
});

t('持久化往返：总量和窗口都恢复，损坏数据不放额度', function () {
  const s = createBudgetState(0, null);
  for (let i = 0; i < 3; i += 1) budgetReserve(s, i, { requests: 1, chars: 2 }, RULE);
  const saved = budgetSnapshot(s);
  const back = createBudgetState(500, saved);
  assert.equal(back.requests, 3);
  assert.equal(back.chars, 6);
  assert.equal(back.win.length, 3);
  assert.equal(budgetCheck(back, 500, RULE), true);
  const broken = createBudgetState(0, { requests: -1, chars: 'x', win: [{ t: 'a' }, null] });
  assert.equal(broken.requests, 0);
  assert.equal(broken.chars, 0);
  assert.equal(broken.win.length, 0);
});

t('默认阈值是保守估计（窗口 90 次 HTTP / 9 万字符）', function () {
  assert.equal(SUBTITLE_BUDGET.windowRequests, 90);
  assert.equal(SUBTITLE_BUDGET.windowChars, 90000);
  assert.equal(SUBTITLE_BUDGET.windowMs, 5 * 60 * 1000);
  assert.ok(SUBTITLE_BUDGET_ALL_TABS.windowRequests > SUBTITLE_BUDGET.windowRequests);
  assert.ok(SUBTITLE_BUDGET_ALL_TABS.tabRequests > SUBTITLE_BUDGET.tabRequests);
});

console.log('\n' + pass + ' 通过 / ' + (pass + fail) + ' 总数');
if (fail) process.exit(1);
