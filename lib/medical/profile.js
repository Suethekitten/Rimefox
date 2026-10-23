// 医学专业翻译配置（纯函数 / 数据无关）
// 只生成可组合的提示词片段；不读取配置、不发请求、不碰 DOM。
export const MEDICAL_PROFILE_VERSION = '1';
export const MEDICAL_TERM_LIMIT = 12;

// 与普通提示词合并；medicalMode 关闭时 systemPrompt 不会调用这里。
// styled=true 时额外声明：趣味风格不能改变医学事实。
export function medicalPrompt(styled) {
  const lines = [
    '【医学专业翻译要求】',
    '本次翻译面向医学学习和医学文献阅读。优先使用规范、准确且符合目标语言医学文献习惯的专业术语，准确保留疾病、症状、体征、病理、解剖、药理、遗传学和临床研究概念。',
    '严格区分相关性与因果性，不得把 association 译成“导致”；区分 statistically significant 与 clinically significant、mortality 与 morbidity、incidence 与 prevalence、relative risk / odds ratio / hazard ratio、sensitivity 与 specificity、adverse event 与 adverse reaction、suspected 与 confirmed、may / might 与 must、no significant difference 与 no difference。',
    '保留否定、条件、可能性、程度、比较对象和时间关系；不得擅自强化或弱化临床结论。保持药物名称、剂量、单位、实验数值、样本量、p 值、置信区间、效应方向及统计结果准确。',
    '保留基因符号、蛋白名称、标准缩写、DOI、PMID、临床试验注册编号和必要引用标记。缩写按上下文解释，不擅自猜测有歧义的缩写；不换算单位、不四舍五入、不改变数值精度。',
    '允许按目标语言习惯调整句序，但不得增加原文没有的事实、推断、临床建议或诊断结论。原文属于研究结果、观察性研究或假设时，译文必须保持同样的证据程度。',
    '以上规则不改变唯一目标语言、JSON 输出协议、段落顺序、换行、隐私占位符和引用标记。'
  ];
  if (styled) {
    lines.push('如果同时开启趣味风格：风格只能改变非专业措辞；医学事实、数字、统计、否定、不确定性、因果、剂量和风险程度必须保持准确，冲突时以准确性优先。');
  }
  return lines.join('\n');
}

// 只放本批真正命中的、已审核的术语；用户术语在提示词中排在后面并明确优先。
export function medicalTermPrompt(hits) {
  const rows = Array.isArray(hits) ? hits : [];
  if (!rows.length) return '';
  const lines = rows.map((one) => {
    const abbr = one.abbreviation ? '（' + one.abbreviation + '）' : '';
    return '- ' + one.source + ' → ' + one.target + abbr;
  });
  return (
    '医学专业术语（已审核，仅在用户术语未覆盖时使用；结合上下文判断，不要机械替换，矛盾时以用户术语为准）：\n' +
    lines.join('\n')
  );
}
