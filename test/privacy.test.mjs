// 本地脱敏 / 恢复单测（纯函数，不依赖浏览器与网络）。
// 运行：node test/privacy.test.mjs
import assert from 'node:assert/strict';

import {
  detect,
  maskText,
  maskTexts,
  restoreText,
  restoreTexts,
  createSession,
  optionsFromConfig,
  TYPES
} from '../lib/privacy.js';

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

const ALL = { email: true, phone: true, idCard: true, bankCard: true, userName: true };

function maskOne(text, options) {
  const session = createSession();
  const row = maskText(text, options || ALL, session);
  assert.equal(row.ok, true, 'mask should succeed');
  return { row, values: session.values };
}

function roundTrip(text, options) {
  const { row, values } = maskOne(text, options);
  const back = restoreText(row.masked, row.tokens, values);
  assert.equal(back.ok, true, back.reason);
  assert.equal(back.text, text);
  return row;
}

// ---------------- 识别 ----------------
console.log('\n[识别]');

t('邮箱', () => {
  const spans = detect('联系 test.user+alias@example.com 谢谢', ALL);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].type, TYPES.EMAIL);
  assert.equal(spans[0].value, 'test.user+alias@example.com');
});

t('中文手机号 / 中国座机 / 国际号码', () => {
  assert.equal(detect('手机 18744325579', ALL)[0].type, TYPES.PHONE);
  assert.equal(detect('座机 010-12345678', ALL)[0].type, TYPES.PHONE);
  assert.equal(detect('US +1 415-555-2671', ALL)[0].type, TYPES.PHONE);
  assert.equal(detect('括号 (415) 555-2671', ALL)[0].value, '(415) 555-2671');
});

t('身份证：校验位正确才识别', () => {
  assert.equal(detect('身份证 11010519491231002X', ALL)[0].type, TYPES.ID_CARD);
  assert.equal(detect('身份证 110105194912310021', ALL).length, 0);
});

t('银行卡：Luhn 通过才识别', () => {
  assert.equal(detect('卡号 4242 4242 4242 4242', ALL)[0].type, TYPES.BANK_CARD);
  assert.equal(detect('卡号 4111 1111 1111 1111', ALL)[0].type, TYPES.BANK_CARD);
  // 上游夹具里的 1234 5678 9012 3456 不满足 Luhn：没有标签时不按银行卡处理
  assert.equal(detect('编号 1234 5678 9012 3456', ALL).length, 0);
});

t('带标签的银行账号（无 Luhn）也能识别', () => {
  const spans = detect('银行账号：1234 5678 9012 3456', ALL);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].type, TYPES.BANK_ACCOUNT);
});

t('中文姓名：标签 / 自我介绍', () => {
  assert.equal(detect('姓名：张伟', ALL)[0].value, '张伟');
  assert.equal(detect('联系人：李小明', ALL)[0].value, '李小明');
  assert.equal(detect('收货人：司马光', ALL)[0].value, '司马光');
  assert.equal(detect('我叫王芳，你好', ALL)[0].value, '王芳');
});

t('中文姓名：非姓氏开头不误判', () => {
  assert.equal(detect('联系人：客服中心', ALL).length, 0);
  assert.equal(detect('我是中国人', ALL).length, 0);
});

t('姓名默认关闭', () => {
  assert.equal(detect('姓名：张伟', {}).length, 0);
  const opts = { email: true, phone: true, idCard: true, bankCard: true };
  assert.equal(detect('姓名：张伟', opts).length, 0);
});

t('日期 / 时间 / 订单号 / 版本号 / ISBN 不当成电话', () => {
  [
    '2024-01-15',
    '2024/01/15',
    '12:34:56',
    '版本 1.2.3.4',
    '订单号 1234567890123',
    'IP 192.168.1.1',
    '发布于 2024-01-15 12:34',
    'ISBN 978-7-111-12345-6'
  ].forEach((text) => {
    assert.equal(detect(text, ALL).length, 0, text);
  });
});

t('邮箱里的数字不会单独被当电话', () => {
  const spans = detect('user12345678@example.com', ALL);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].type, TYPES.EMAIL);
});

t('重叠时高分优先：银行卡不会被电话吃掉', () => {
  const spans = detect('卡号 4242 4242 4242 4242', ALL);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].type, TYPES.BANK_CARD);
});

// ---------------- 脱敏 ----------------
console.log('\n[脱敏]');

t('占位符格式与上游一致', () => {
  const { row } = maskOne('邮箱 a@b.com');
  assert.match(row.masked, /__PII_EMAIL_ADDRESS_\d+__/);
});

t('原文敏感值不出现在脱敏结果里', () => {
  const { row } = maskOne('联系 test@example.com，手机 18744325579');
  assert.equal(row.masked.indexOf('test@example.com'), -1);
  assert.equal(row.masked.indexOf('18744325579'), -1);
});

t('同一实体的多次出现复用同一个占位符', () => {
  const { row } = maskOne('a@b.com 和 a@b.com');
  assert.equal(row.tokens.length, 1);
  assert.equal(row.masked, '__PII_EMAIL_ADDRESS_1__ 和 __PII_EMAIL_ADDRESS_1__');
});

t('没有敏感信息时原样返回，不生成占位符', () => {
  const row = maskText('这是一段普通文字。', ALL);
  assert.deepEqual(row, { ok: true, masked: '这是一段普通文字。', tokens: [] });
});

t('原文自带占位符前缀 → 拒绝脱敏（fail-closed）', () => {
  const row = maskText('文档里写了 __PII_EMAIL_ADDRESS_1__ 这个格式', ALL);
  assert.equal(row.ok, false);
  assert.equal(row.reason, 'placeholder_collision');
});

t('关闭某类识别后不再脱敏该类', () => {
  const row = maskText('a@b.com 18744325579', { email: false, phone: true });
  assert.equal(row.masked.indexOf('a@b.com') >= 0, true);
  assert.equal(row.masked.indexOf('18744325579'), -1);
});

// ---------------- 恢复 ----------------
console.log('\n[恢复]');

t('中文 / 英文 / 中英混合往返一致', () => {
  roundTrip('请联系 test.user+alias@example.com 或 +1 415-555-2671。');
  roundTrip('Call me at (415) 555-2671 or mail a@b.com.');
  roundTrip('身份证 11010519491231002X，卡号 4242 4242 4242 4242，Mixed 文本。');
});

t('占位符被重复时全部还原', () => {
  const { row, values } = maskOne('姓名：张伟');
  const back = restoreText(row.masked + '（再次：' + row.masked + '）', row.tokens, values);
  assert.equal(back.ok, true);
  assert.equal(back.text, '姓名：张伟（再次：姓名：张伟）');
});

t('占位符被加空格 / 改大小写 / 全角下划线仍可还原', () => {
  const { row, values } = maskOne('邮箱 a@b.com');
  ['__ PII_EMAIL_ADDRESS_1 __', '__pii_email_address_1__', '__PII＿EMAIL＿ADDRESS＿1__'].forEach((variant) => {
    const back = restoreText(variant, row.tokens, values);
    assert.equal(back.ok, true, variant + ' → ' + back.reason);
    assert.equal(back.text, 'a@b.com');
  });
});

t('占位符缺失 → 判失败，不输出半截译文', () => {
  const { row, values } = maskOne('邮箱 a@b.com');
  const back = restoreText('邮箱（已省略）', row.tokens, values);
  assert.equal(back.ok, false);
  assert.equal(back.reason, 'missing_placeholder');
});

t('出现映射表外的占位符 → 判失败', () => {
  const { row, values } = maskOne('邮箱 a@b.com');
  const back = restoreText('__PII_EMAIL_ADDRESS_9__', row.tokens, values);
  assert.equal(back.ok, false);
  assert.equal(back.reason, 'unknown_placeholder');
});

t('占位符被翻译成自然语言 → 判失败（不会把原文当译文）', () => {
  const { row, values } = maskOne('邮箱 a@b.com');
  const back = restoreText('邮箱 [电子邮件]', row.tokens, values);
  assert.equal(back.ok, false);
});

t('无占位符的普通文本不受影响', () => {
  const back = restoreText('这是一段 PII 无关的普通译文。', [], new Map());
  assert.equal(back.ok, true);
  assert.equal(back.text, '这是一段 PII 无关的普通译文。');
});

t('restoreTexts 按行对齐，单行失败不影响其它行', () => {
  const out = maskTexts(['邮箱 a@b.com', '普通文本', '电话 18744325579'], ALL);
  const replies = [out.rows[0].masked, out.rows[1].masked, '电话被模型删掉了'];
  const restored = restoreTexts(out.rows, replies, out.values);
  assert.equal(restored[0].ok, true);
  assert.equal(restored[1].ok, true);
  assert.equal(restored[2].ok, false);
});

t('映射只在返回值里：optionsFromConfig 默认开邮箱/电话/证件/银行卡，姓名关', () => {
  const opts = optionsFromConfig({});
  assert.deepEqual(opts, { email: true, phone: true, idCard: true, bankCard: true, userName: false });
  assert.equal(optionsFromConfig({ privacyMaskUserName: true }).userName, true);
  assert.equal(optionsFromConfig({ privacyMaskEmail: false }).email, false);
});

// ---------------- 模拟翻译管线 ----------------
console.log('\n[模拟管线]');

t('脱敏文本发给“模型”，回包后按原文还原（含术语/自定义提示词场景）', () => {
  const source = [
    '请把这段话翻译成英文：我的邮箱是 test@example.com。',
    'Name: John Smith, phone +1 415-555-2671.',
    '混合 mixed 文本：身份证 11010519491231002X。'
  ];
  const opts = { email: true, phone: true, idCard: true, bankCard: true, userName: true };
  const masked = maskTexts(source, opts);
  // 模型只看到占位符
  masked.rows.forEach((row) => {
    assert.equal(/test@example\.com|11010519491231002X|415-555-2671/.test(row.masked), false);
  });
  // 模拟模型：把主语换成译文，但占位符原样保留
  const replies = masked.rows.map((row) => 'Translated: ' + row.masked);
  const restored = restoreTexts(masked.rows, replies, masked.values);
  restored.forEach((one, i) => {
    assert.equal(one.ok, true, one.reason);
    source[i].match(/(test@example\.com|11010519491231002X|\+1 415-555-2671)/g).forEach((secret) => {
      assert.equal(one.text.indexOf(secret) >= 0, true, 'missing ' + secret);
    });
  });
});

console.log('\n[行内格式标记]');

// 0.12.4：行内协议文本按去掉 <kN>/<fN> 的可见文字识别，命中区间按标记边界切段替换，标记原样保留。
t('标签后接加粗值：去掉标记后识别，标记不动', () => {
  const plain = maskText('Your Account Number: 12345678901 is active.', ALL);
  const marked = maskText('Your Account Number: <f1>12345678901</f1> is active.', { ...ALL, inlineMarkers: true });
  assert.equal(plain.masked.indexOf('12345678901'), -1);
  assert.equal(marked.masked.indexOf('12345678901'), -1);
  assert.match(marked.masked, /^Your Account Number: <f1>__PII_[A-Z_]+_\d+__<\/f1> is active\.$/);
});

t('跨标记的邮箱 / 电话按标记切段，每段各自占位，还原后结构与原文一致', () => {
  const ctx = createSession();
  const source = 'Mail <f1>john.doe</f1>@example.com or call <f2>+1</f2> (415) 555-2671 now.';
  const row = maskText(source, { ...ALL, inlineMarkers: true }, ctx);
  ['john.doe', '@example.com', '(415) 555-2671'].forEach((secret) => assert.equal(row.masked.indexOf(secret), -1, secret));
  assert.equal((row.masked.match(/<\/?f\d>/g) || []).join(''), '<f1></f1><f2></f2>');
  const back = restoreText(row.masked, row.tokens, ctx.values);
  assert.equal(back.ok, true);
  assert.equal(back.text, source);
});

t('原子里的值也被遮罩，但不跨出 <kN> 边界', () => {
  const ctx = createSession();
  const source = 'Write to <k1><f1>support@example.com</f1></k1> today.';
  const row = maskText(source, { ...ALL, inlineMarkers: true }, ctx);
  assert.match(row.masked, /^Write to <k1><f1>__PII_EMAIL_[A-Z_]*\d+__<\/f1><\/k1> today\.$/);
  assert.equal(restoreText(row.masked, row.tokens, ctx.values).text, source);
});

t('不开 inlineMarkers 时行为与之前一致', () => {
  assert.deepEqual(maskText('Mail a@b.com now.', ALL), maskText('Mail a@b.com now.', { ...ALL, inlineMarkers: false }));
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
