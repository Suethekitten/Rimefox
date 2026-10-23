// 医学专业翻译配置（纯函数 / 数据无关）
// 只生成可组合的提示词片段；不读取配置、不发请求、不碰 DOM。
export const MEDICAL_PROFILE_VERSION = '2';
export const MEDICAL_TERM_LIMIT = 12;

// 分层维护但按需组合；共同规则始终生效，学科规则只在已知上下文中追加。
export const MEDICAL_RULES = Object.freeze({
  fidelity: '保留否定、条件、时间、比较对象、程度和概率；suspected / confirmed / possible / probable、may / might / should / must 不得混同。不把研究假设或观察结果写成诊断、临床定论或治疗建议，不增删原文事实。',
  evidence: '医学证据：association 不等于 causation，相关性不得强化为因果；no significant difference 不等于 no difference，统计学显著不等于临床意义。保持证据等级、不确定性与结论强弱。',
  statistics: '临床研究与统计：严格区分 mortality / morbidity、incidence / prevalence、relative risk / odds ratio / hazard ratio、sensitivity / specificity、adverse event / adverse reaction。保留研究设计、终点、组别及其数值对应，不能互换风险方向或实验组和对照组。',
  quantities: '数值与药理：准确保留药物名称、剂量、给药途径、频次、单位、样本量、百分比、p 值、置信区间和效应方向；不换算单位、不四舍五入、不改变精度。',
  symbols: '病理、解剖与分子生物学：保持组织部位、分级与分期、良恶性和变异描述；保留基因/蛋白符号、DOI、PMID、临床试验注册编号及引用标记。缩写仅按本文可靠定义解释，有歧义时保留，不猜测。',
  oncology: '肿瘤学上下文：区分总生存期与无进展生存期、缓解与治愈、疾病进展与复发；不混淆病理类型、分期和治疗线次。',
  neurology: '神经科学上下文：保留神经解剖定位、功能缺损、症状与诊断的区别；不把危险因素或生物标志物写成确诊依据。',
  pharmacology: '药理学上下文：区分不良事件与药物不良反应、适应证与禁忌证；保留剂型、剂量、浓度、给药途径与频次，不能自行推定药物因果关系。',
  immunology: '免疫学上下文：区分抗原与抗体、免疫反应与临床保护；保留细胞亚群、细胞因子及受体符号。'
});

// 与普通提示词合并；medicalMode 关闭时 systemPrompt 不会调用这里。
// styled=true 时额外声明：趣味风格不能改变医学事实。
export function medicalPrompt(styled, context) {
  const lines = [
    '【医学专业翻译要求】',
    '本次翻译面向医学学习和医学文献阅读。优先使用规范、准确且符合目标语言医学文献习惯的专业术语，准确保留疾病、症状、体征、病理、解剖、药理、遗传学和临床研究概念。',
    MEDICAL_RULES.fidelity,
    MEDICAL_RULES.evidence,
    MEDICAL_RULES.statistics,
    MEDICAL_RULES.quantities,
    MEDICAL_RULES.symbols,
    '以上规则不改变唯一目标语言、JSON 输出协议、段落顺序、换行、隐私占位符和引用标记。'
  ];
  const subdomain = context && context.subdomain;
  const layer = subdomain === 'gyn-oncology' ? 'oncology' : subdomain;
  if (['oncology', 'neurology', 'pharmacology', 'immunology'].includes(layer)) lines.push(MEDICAL_RULES[layer]);
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
