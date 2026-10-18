#!/usr/bin/env node
// 脱敏模块性能基准（不参与打包）。
// 运行：node tools/bench-privacy.mjs
import { maskTexts, restoreTexts } from '../lib/privacy.js';

const OPTIONS = { email: true, phone: true, idCard: true, bankCard: true, userName: true };

const patterns = [
  (i) => '请联系 user' + i + '@example.com 了解详情。',
  (i) => '手机号 187' + String(10000000 + i).slice(0, 8) + '，工作日联系。',
  (i) => '身份证 11010519491231002X 已核验，订单 ' + (100000 + i) + '。',
  (i) => '卡号 4242 4242 4242 4242，金额 199 元。',
  (i) => 'Call +1 415-555-' + String(1000 + (i % 9000)) + ' for support.',
  (i) => '这是一段没有敏感信息的普通段落，用来测试扫描开销 ' + i + '。',
  (i) => 'This paragraph has no PII either; it is here to measure scanning cost ' + i + '.'
];

const texts = [];
for (let i = 0; i < 1440; i += 1) texts.push(patterns[i % patterns.length](i));
const chars = texts.reduce((sum, one) => sum + one.length, 0);

function run() {
  const started = process.hrtime.bigint();
  const masked = maskTexts(texts, OPTIONS);
  const afterMask = process.hrtime.bigint();
  const restored = restoreTexts(masked.rows, masked.rows.map((one) => one.masked), masked.values);
  const afterRestore = process.hrtime.bigint();
  if (restored.some((one) => !one.ok)) throw new Error('restore failed in bench');
  return {
    maskMs: Number(afterMask - started) / 1e6,
    restoreMs: Number(afterRestore - afterMask) / 1e6,
    placeholders: masked.values.size
  };
}

run(); // warm-up
const rounds = 25;
let mask = 0;
let restore = 0;
for (let i = 0; i < rounds; i += 1) {
  const one = run();
  mask += one.maskMs;
  restore += one.restoreMs;
}

const avgMask = mask / rounds;
const avgRestore = restore / rounds;
const total = avgMask + avgRestore;
console.log('段落数: ' + texts.length + '，字符数: ' + chars + '，占位符数: ' + run().placeholders);
console.log('单轮脱敏: ' + avgMask.toFixed(2) + ' ms');
console.log('单轮恢复: ' + avgRestore.toFixed(2) + ' ms');
console.log('单轮合计: ' + total.toFixed(2) + ' ms（约 ' + ((total * 1000) / chars).toFixed(2) + ' µs/字符）');
console.log('按 12 条一批估算: 约 ' + ((total / Math.ceil(texts.length / 12)) * 1000).toFixed(0) + ' µs/批，相对网络往返可忽略。');
