// 字幕付费预算：滑窗 + 单标签页总量 + 跨标签页总量。
//
// 为什么放在后台：内容脚本跑在网页进程里，页面脚本能向同一个 window 发消息，也能改 DOM，
// 所以“这条字幕元数据是不是播放器自己的”在内容侧无法可靠证明；费用边界只能由后台按标签页记账，
// 且账本不能随伪造的 cid / id_str / cacheScope 重置。
//
// 计数口径：每次**实际 HTTP 发送前**预留一次（provider 一次 chat 可能发 2 次：思考参数回退），
// 发送完按实际次数回填。批量大小另按原文字符数记一笔，因为请求次数不等于费用。
// 没有真实用量基线，下面的阈值是保守估计（见 HANDOFF §5.4「费用边界」），不是“正常用量的 10 倍”。
//
// 纯函数：不读 chrome.*，可被 node 直接 import 做单测（test/subtitle-budget.test.mjs）。

export const SUBTITLE_BUDGET = {
  windowMs: 5 * 60 * 1000, // 5 分钟滑窗
  windowRequests: 90,      // 窗口内最多 90 次实际 HTTP
  windowChars: 90000,      // 窗口内最多 9 万字原文
  tabRequests: 2400,       // 单标签页本次会话
  tabChars: 2000000        // 单标签页 200 万字原文
};

// 跨标签页额度另算：同一套字段，但窗口放宽到 4 个标签页的量级。
export const SUBTITLE_BUDGET_ALL_TABS = {
  windowMs: SUBTITLE_BUDGET.windowMs,
  windowRequests: 360,
  windowChars: 360000,
  tabRequests: 6000,
  tabChars: 5000000
};

const MAX_WIN_ENTRIES = 600;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function createBudgetState(now, saved) {
  const drained = Array.isArray(saved && saved.win)
    ? saved.win
      .filter((one) => one && Number.isFinite(Number(one.t)) && Number.isFinite(Number(one.r)))
      .slice(-MAX_WIN_ENTRIES)
      .map((one) => ({ t: Number(one.t), r: num(one.r, 0), c: num(one.c, 0) }))
    : [];
  return {
    at: num(saved && saved.at, now || 0),
    requests: Math.floor(num(saved && saved.requests, 0)),
    chars: Math.floor(num(saved && saved.chars, 0)),
    win: drained
  };
}

function windowTotals(state, now, rule) {
  const cutoff = now - rule.windowMs;
  if (state.win.length && state.win[0].t <= cutoff) {
    state.win = state.win.filter((one) => one.t > cutoff);
  }
  let requests = 0;
  let chars = 0;
  state.win.forEach((one) => { requests += one.r; chars += one.c; });
  return { requests, chars };
}

// 只判断，不改状态。
export function budgetCheck(state, now, rule) {
  const r = rule || SUBTITLE_BUDGET;
  if (!state) return false;
  const win = windowTotals(state, now, r);
  return state.requests < r.tabRequests &&
    state.chars < r.tabChars &&
    win.requests < r.windowRequests &&
    win.chars < r.windowChars;
}

// 预留：返回凭证（发送完交给 budgetSettle）；额度不够返回 null，调用方必须停止发送。
// 判断按“当前用量 + 本次要占的量”算，避免最后一笔把上限顶穿。
export function budgetReserve(state, now, cost, rule) {
  const r = rule || SUBTITLE_BUDGET;
  if (!state) return null;
  const need = {
    r: Math.max(1, Math.ceil(num(cost && cost.requests, 1))),
    c: Math.max(0, Math.ceil(num(cost && cost.chars, 0)))
  };
  const win = windowTotals(state, now, r);
  if (state.requests + need.r > r.tabRequests ||
    state.chars + need.c > r.tabChars ||
    win.requests + need.r > r.windowRequests ||
    win.chars + need.c > r.windowChars) {
    return null;
  }
  const entry = { t: now, r: need.r, c: need.c };
  state.win.push(entry);
  state.requests += need.r;
  state.chars += need.c;
  state.at = now;
  return entry;
}

// 回填：实际发送次数 ≤ 预留时退回差额；超过预留就照实补记（宁可多记，不漏记）。
export function budgetSettle(state, entry, actualRequests, now) {
  if (!state || !entry) return;
  const actual = Math.max(0, Math.ceil(num(actualRequests, 0)));
  const delta = entry.r - actual;
  entry.r = actual;
  state.requests = Math.max(0, state.requests - delta);
  state.at = now || state.at;
}

// 整笔撤销：跨标签页额度不够、需要退回刚预留的那笔时用。
export function budgetRelease(state, entry) {
  if (!state || !entry) return;
  const i = state.win.indexOf(entry);
  if (i >= 0) state.win.splice(i, 1);
  state.requests = Math.max(0, state.requests - entry.r);
  state.chars = Math.max(0, state.chars - entry.c);
}

// 持久化只写这些字段（窗口也写，service worker 被回收后限额不会从零开始）。
export function budgetSnapshot(state) {
  if (!state) return { requests: 0, chars: 0, at: 0, win: [] };
  return {
    requests: state.requests,
    chars: state.chars,
    at: state.at,
    win: state.win.map((one) => ({ t: one.t, r: one.r, c: one.c }))
  };
}
