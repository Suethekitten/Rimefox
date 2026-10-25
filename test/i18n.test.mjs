// 界面语言单测：静态文案映射（纯函数，不依赖浏览器）。
// 运行：node test/i18n.test.mjs
import assert from 'node:assert/strict';

import { translateText, t as translateFor, applyI18n, UI_LANGS } from '../lib/i18n.js';
import { sanitizeTranslationCss, ACCENT_PRESETS } from '../lib/appearance.js';
import { normalizeSiteRules, BUILTIN_SITE_RULES } from '../lib/site-rules.js';

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

console.log('\n[界面语言]');

t('translateText：整段精确匹配，保留前后空白', () => {
  assert.equal(translateText('保存'), 'Save');
  assert.equal(translateText('  保存\n'), '  Save\n');
});

t('translateText：未知文案原样返回', () => {
  assert.equal(translateText('这不是界面文案'), '这不是界面文案');
  assert.equal(translateText(''), '');
});

t('translateText：动态状态文案按模式翻译', () => {
  assert.equal(translateText('已保存（12:34:56）'), 'Saved (12:34:56)');
  assert.equal(
    translateText('已导入 109 条（新增 109 条，点「保存」后生效）'),
    'Imported 109 term(s) (109 new); click Save to apply'
  );
  assert.equal(translateText('切换失败：network error'), 'Switch failed: network error');
  assert.equal(translateText('未开启。按 Alt + A 可直接翻译。'), 'Off. Press Alt + A to translate the page.');
  assert.equal(translateText('翻译中… 已译 42 / 118 段（36%）'), 'Translating… 42 / 118 paragraphs (36%)');
  assert.equal(translateText('已译 42 段'), '42 paragraphs translated');
  assert.equal(translateText('失败原因：'), 'Last error: ');
  assert.equal(translateText('开始翻译'), 'Translate');
});

t('核心入口文案已覆盖', () => {
  ['设置', '翻译', '术语表', '快捷键', '缓存与迁移', '高级', '保存', '放弃更改', '翻译此页', '诊断'].forEach((key) => {
    assert.notEqual(translateText(key), key, key + ' 没有英文');
  });
});

t('语言列表：中文在前，English 在后', () => {
  assert.deepEqual(
    UI_LANGS.map((one) => one.value),
    ['zh', 'en']
  );
});

t('设置页新增文案已覆盖', () => {
  ['界面主题', '界面语言', '自定义提示词', '输出调试日志', '恢复默认'].forEach((key) => {
    assert.notEqual(translateText(key), key, key + ' 没有英文');
  });
});

t('医学专业模式文案已覆盖', () => {
  ['专业翻译', '医学专业模式', '优先使用已审核的医学术语；保留剂量、统计结果和临床结论。默认关闭。'].forEach((key) => {
    assert.notEqual(translateText(key), key, key + ' 没有英文');
  });
});

t('专业质量、严格模式费用与批次上限说明有完整英文', () => {
  [
    '专业翻译质量', '快速', '标准（推荐）', '严格', '严格模式额外请求上限',
    '快速：提示词与术语；标准：增加本地检查；严格：允许复核高风险片段。',
    '严格模式默认关闭；复核会额外调用您配置的 API，增加 Token 用量与费用。模型复核不等于医学专家审核。',
    '每个翻译批次最多允许 0–3 次额外请求（含网络重试）；整页可能包含多个批次。0 表示不额外调用。快速与标准模式不增加复核请求。'
  ].forEach((key) => assert.notEqual(translateText(key), key));
  assert.match(translateText('专业翻译有 2 段需要核对；请对照原文确认数值与结论。'), /^2 professional translation segment\(s\) need review/);
  assert.match(translateText('译文有 2 段需要核对；请对照原文确认链接、引用与语义。'), /^2 translated segment\(s\) need review/);
  assert.equal(translateText('保留原文 1'), '1 kept original');
  assert.equal(translateText('安全调整 1'), '1 safely adjusted');
  assert.match(translateText('链接顺序无法安全重排，已保留原文。可切换双语模式查看译文。'), /switch to bilingual mode/);
});

t('悬停对照相关文案已覆盖', () => {
  [
    '悬停对照',
    '悬停时显示对应原句；无法准确匹配时回退到行或段落。可在网页悬浮入口中快速开关。',
    '开启悬停对照',
    '关闭悬停对照',
    '段落级对应',
    '行级对应',
    '原文节选',
    '展开全文',
    '收起',
    '关闭原文提示',
    '原文内容，可滚动查看',
    '设置保存失败，请重试'
  ].forEach((key) => {
    assert.notEqual(translateText(key), key, key + ' 没有英文');
  });
});

t('隐私设置文案已覆盖', () => {
  ['隐私保护', '本地脱敏', 'AI 隐私保护翻译', '邮箱地址', '电话号码', '身份证号', '银行卡号', '中文姓名'].forEach((key) => {
    assert.notEqual(translateText(key), key, key + ' 没有英文');
  });
});

t('弹窗主题切换文案已覆盖', () => {
  ['切换到深色', '切换到浅色'].forEach((key) => {
    assert.notEqual(translateText(key), key, key + ' 没有英文');
  });
});

t('输入框翻译设置文案有英文', () => {
  ['输入框翻译', '目标语言', '跟随页面语言', '输入框快捷键', '「跟随页面语言」= 用页面 lang 属性认得出的语言；认不出来时用英文。'].forEach((key) => {
    assert.notEqual(translateText(key), key, key + ' 没有英文');
  });
  const desc =
    '光标在输入框或可编辑区域里时，按下快捷键把这段文字翻成目标语言后原地写回；也可以右键 →「凛狐：翻译输入框内容」。有选区时只翻选中的部分，翻完按 Ctrl+Z（Mac：⌘Z）能回到原文。密码框和支付类字段不翻译，输入法拼字中不会打断。输入框里多是草稿和私信，这类翻译不写进翻译缓存。';
  assert.notEqual(translateText(desc), desc, '设置页说明没有英文');
});

t('自定义语言 / 趣味强度 / AI 精翻文案有英文', () => {
  [
    '傲娇猫娘', '趣味风格强度', '轻度', '标准', '夸张',
    '仅对文言文、傲娇猫娘等趣味风格生效，普通翻译不受影响。保存后不会立刻重译；下次翻译或点「重新翻译」时生效。',
    '自定义目标语言', '显示名称', '语言代码（可选）', '翻译说明（可选）', '添加', '编辑', '保存修改', '取消编辑',
    '请填写显示名称', '语言代码不是有效的 BCP 47 标签', '已有同名语言', '已有相同语言代码',
    '最多添加 20 种自定义语言', '已加入表单；点「保存」后生效', '已取消编辑',
    'AI 精翻',
    '开启后将向你配置的翻译 API 发送有限的相关上下文，可能增加输入 Token 消耗，但默认不额外发起复核请求。',
    '上下文只来自当前文章标题、章节、缩写定义和同文章内相邻正文，并作为不可信参考数据发送。开启不会自动启用严格质量复核；已开启的严格复核仍按原预算运行。隐私脱敏开启时整段上下文都不发送。',
    '例如：粤语（香港）', '例如：yue-Hant-HK',
    '只改写正文，只对当前页生效；选择会保留，切换下拉框不会立即重译，下次明确翻译时生效',
    '趣味翻译：选择会保留，只对当前页生效，下次明确翻译时应用',
    '简体中文', '繁體中文', '日本語', '한국어', 'Français', 'Deutsch', 'Español', 'Русский', 'Português',
    '目标语言已更新；当前页面译文保持不变，点「重新翻译」后应用。',
    '页面上下文已更新；已译内容保持不变，重新翻译后使用新上下文。'
  ].forEach((key) => assert.notEqual(translateText(key), key, key + ' 没有英文'));
});

t('t()：按当前界面语言输出', () => {
  assert.equal(translateFor('开始翻译'), '开始翻译');
  applyI18n(null, 'en');
  assert.equal(translateFor('开始翻译'), 'Translate');
  assert.equal(translateFor('未开启。按 Alt + A 可直接翻译。'), 'Off. Press Alt + A to translate the page.');
  applyI18n(null, 'zh');
  assert.equal(translateFor('开始翻译'), '开始翻译');
});

t('弹窗：读不到页面地址时的本地文件提示有英文', () => {
  const zh = '浏览器内置页、扩展商店页无法翻译。如果这是本地文件，请打开 chrome://extensions → 本扩展的「详细信息」→ 开启「允许访问文件网址」，然后按 ⌘R 刷新。';
  const en = translateText(zh);
  assert.notEqual(en, zh);
  assert.match(en, /local file/);
  assert.match(en, /chrome:\/\/extensions/);
});

t('外观 / 站点与兼容性：色板名和内置规则说明有英文', () => {
  ACCENT_PRESETS.forEach((one) => assert.notEqual(translateText(one.label), one.label, one.label + ' 没有英文'));
  BUILTIN_SITE_RULES.forEach((one) => assert.notEqual(translateText(one.note), one.note, one.note + ' 没有英文'));
  ['外观', '站点与兼容性', '悬浮入口', '置顶小窗', '可能降低性能', '高级参数', '搜索设置', '夜间'].forEach((key) => {
    assert.notEqual(translateText(key), key, key + ' 没有英文');
  });
});

t('校验提示：自定义 CSS / 站点规则产生的每条错误都有英文', () => {
  const messages = [];
  ['color: red } body { x: y', 'background: url(x.png)', 'color: expression(1)', 'color: red /* x */', 'x'.repeat(2001), 'oops; 1x: 2', Array(42).fill('color: red').join(';')]
    .forEach((css) => messages.push(...sanitizeTranslationCss(css).errors));
  messages.push(...normalizeSiteRules({}).errors);
  messages.push(
    ...normalizeSiteRules([
      1,
      { matches: [] },
      { matches: ['http://bad host'], textSelectors: 'x' },
      { matches: ['a.com'], excludeSelectors: [3], mode: 'x', theme: 'nope' }
    ]).errors
  );
  messages.push(...normalizeSiteRules(Array(60).fill({ matches: ['a.com'] })).errors);
  assert.ok(messages.length >= 12, '错误样本太少：' + messages.length);
  messages.forEach((msg) => assert.notEqual(translateText(msg), msg, msg + ' 没有英文'));
});

t('校验提示：多条错误用「；」连起来时逐条翻译', () => {
  const zh = '第 1 条规则不是对象；第 2 条规则没有可用的 matches';
  assert.equal(translateText(zh), 'Rule 1 is not an object; Rule 2 has no usable matches');
  assert.equal(translateText('格式正确，共 3 条规则'), 'Looks good: 3 rule(s)');
  // 自带「；」的整句文案优先整句匹配
  assert.equal(translateText('设置在别的页面被修改过；保存时会以这里的内容为准'), 'Settings were changed on another page; saving here will overwrite them');
  // 没有一条能翻的就原样返回
  assert.equal(translateText('这不是界面文案；那也不是'), '这不是界面文案；那也不是');
});

t('设置页：缓存统计和浏览器快捷键行有英文', () => {
  assert.equal(
    translateText('本次会话：1234 条 · 793 KB（上限 8000 条 / 4.0 MB）　磁盘：321 条 · 64 KB（上限 512 KB）　命中率：63%（63 / 100）'),
    'This session: 1234 entries · 793 KB (limit 8000 entries / 4.0 MB)　Disk: 321 entries · 64 KB (limit 512 KB)　Hit rate: 63% (63 / 100)'
  );
  assert.equal(translateText('浏览器快捷键：⌥A'), 'Browser shortcut: ⌥A');
  assert.match(translateText('已获取 2 个模型。点「选择」挑一个，或直接手填；别忘了保存。'), /^Loaded 2 models\./);
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
