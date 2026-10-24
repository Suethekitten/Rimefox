// 目标语言保守校验（lib/lang-guard.js）：只抓「目标语言是拉丁字母语系、译文却整段中日韩正文」
// 这一种高置信度错误，短文本 / 专名清单 / 正常混排都不能误伤。
// 运行：node test/lang-guard.test.mjs
import assert from 'node:assert/strict';

import { looksForeignForTarget } from '../lib/lang-guard.js';

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

// 《罗生门》开头的中文译文（足够长、带句读）
const ZH_PROSE =
  '某日傍晚，一个下人正在罗生门下避雨。宽广的门下，除了这个男人以外，一个人也没有，只有一只蟋蟀停在斑驳的朱漆大圆柱上。' +
  '罗生门既然位于朱雀大路，除了这个男人以外，应该还有两三个戴着市女笠、揉乌帽子的避雨人。';
const JA_PROSE =
  'ある日の暮方の事である。一人の下人が、羅生門の下で雨やみを待っていた。広い門の下には、この男のほかに誰もいない。' +
  'ただ、所々丹塗りの剥げた、大きな円柱に、蟋蟀が一匹とまっている。';
const EN_PROSE =
  'It was a evening in late autumn. A lowly servant was waiting for the rain to stop under the Rashomon gate, and nobody else was there.';

console.log('\n[目标语言保守校验]');

t('英文目标：整段中文正文 → 判为异常', () => {
  assert.equal(looksForeignForTarget(ZH_PROSE, 'en'), true);
  assert.equal(looksForeignForTarget(ZH_PROSE, 'en-US'), true);
});

t('英文目标：整段日文 / 韩文正文 → 判为异常', () => {
  assert.equal(looksForeignForTarget(JA_PROSE, 'en'), true);
  assert.equal(
    looksForeignForTarget(
      '어느 날 저녁에 한 하인이 라쇼몬 문 아래에서 비가 그치기를 기다리고 있었다. 넓은 문 아래에는 이 남자 말고 아무도 없었다.',
      'en'
    ),
    true
  );
});

t('英文目标：正常英文译文 → 放行（含少量中文人名 / 引用）', () => {
  assert.equal(looksForeignForTarget(EN_PROSE, 'en'), false);
  assert.equal(looksForeignForTarget(EN_PROSE + ' The gate, called 羅生門, stood on 朱雀大路.', 'en'), false);
});

t('英文目标：短文本不判（标题、按钮、人名）', () => {
  assert.equal(looksForeignForTarget('羅生門', 'en'), false);
  assert.equal(looksForeignForTarget('你好世界。', 'en'), false);
});

t('英文目标：没有句末句读的中文清单不判（可能是术语 / 人名）', () => {
  assert.equal(looksForeignForTarget('张三、李四、王五、赵六、钱七、孙八、周九、吴十、郑十一、王十二', 'en'), false);
});

t('英文目标：中文里夹足够多英文 → 放行', () => {
  assert.equal(looksForeignForTarget('这是 API 返回的错误信息，please check the GitHub issue 或者 README 文档后再试。', 'en'), false);
});

t('其它拉丁字母目标（fr / de / es / pt）同样适用；正常中文 / 日文目标不判', () => {
  assert.equal(looksForeignForTarget(ZH_PROSE, 'fr'), true);
  assert.equal(looksForeignForTarget(ZH_PROSE, 'de'), true);
  assert.equal(looksForeignForTarget(ZH_PROSE, 'es'), true);
  assert.equal(looksForeignForTarget(ZH_PROSE, 'pt-BR'), true);
  assert.equal(looksForeignForTarget(ZH_PROSE, 'zh-CN'), false);
  assert.equal(looksForeignForTarget(ZH_PROSE, 'ja'), false);
});

t('中日韩目标：整段英文回包 → 判为异常（不写缓存）', () => {
  assert.equal(looksForeignForTarget(EN_PROSE, 'zh-CN'), true);
  assert.equal(looksForeignForTarget(EN_PROSE, 'zh-TW'), true);
  assert.equal(looksForeignForTarget(EN_PROSE, 'ja'), true);
  assert.equal(looksForeignForTarget(EN_PROSE, 'ko'), true);
});

t('中日韩目标：短英文 / 无句末标点 / 中英混排不误杀', () => {
  assert.equal(looksForeignForTarget('Continue', 'zh-CN'), false);
  assert.equal(looksForeignForTarget('This is a short English label', 'zh-CN'), false);
  assert.equal(looksForeignForTarget('This is a long English sentence without a final punctuation mark that should still be treated conservatively', 'zh-CN'), false);
  assert.equal(
    looksForeignForTarget('这是 API 返回的错误信息，please check the GitHub issue 或者 README 文档后再试。', 'zh-CN'),
    false
  );
  assert.equal(looksForeignForTarget('正常中文译文，保留 GitHub、API、COVID-19 等专名和缩写。', 'zh-CN'), false);
});

t('空值 / 非字符串 / 坏目标语言：不抛异常，一律放行', () => {
  assert.equal(looksForeignForTarget('', 'en'), false);
  assert.equal(looksForeignForTarget(null, 'en'), false);
  assert.equal(looksForeignForTarget(undefined, undefined), false);
  assert.equal(looksForeignForTarget(123, 'en'), false);
  assert.equal(looksForeignForTarget(ZH_PROSE, ''), false);
});

t('幂等：同一段文字多次判定结果一致', () => {
  const first = looksForeignForTarget(ZH_PROSE, 'en');
  assert.equal(looksForeignForTarget(ZH_PROSE, 'en'), first);
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;
