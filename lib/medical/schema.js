// 词库维护用的离线结构审计；审核状态表示来源流程，不表示临床专家认证。
export function auditMedicalTerms(terms) {
  const issues = [];
  const ids = new Set();
  const sources = new Set();
  const matchNames = new Map();
  (Array.isArray(terms) ? terms : []).forEach((term, index) => {
    if (!term || typeof term !== 'object') {
      issues.push({ code: 'invalid_entry', index });
      return;
    }
    ['id', 'version', 'source', 'target', 'sourceLang', 'targetLang', 'domain', 'subdomain', 'sourceId'].forEach((field) => {
      if (typeof term[field] !== 'string' || !term[field].trim()) issues.push({ code: 'missing_field', index, field });
    });
    if (ids.has(term.id)) issues.push({ code: 'duplicate_id', index });
    ids.add(term.id);
    const key = [term.sourceLang, term.targetLang, String(term.source || '').toLowerCase()].join(':');
    if (sources.has(key)) issues.push({ code: 'duplicate_direction_source', index });
    sources.add(key);
    if (!['reviewed', 'reviewed-upstream'].includes(term.status)) issues.push({ code: 'unreviewed', index });
    if (typeof term.reverse !== 'boolean') issues.push({ code: 'invalid_reverse', index });
    if (!Array.isArray(term.aliases) || term.aliases.some((x) => typeof x !== 'string' || !x.trim())) issues.push({ code: 'invalid_aliases', index });
    if (term.matchEnabled !== undefined && typeof term.matchEnabled !== 'boolean') issues.push({ code: 'invalid_match_enabled', index });
    [term.source].concat(Array.isArray(term.aliases) ? term.aliases : []).filter((x) => typeof x === 'string').forEach((name) => {
      const matchKey = [term.sourceLang, term.targetLang, name.toLowerCase()].join(':');
      if (matchNames.has(matchKey) && matchNames.get(matchKey) !== index) issues.push({ code: 'conflicting_match_name', index });
      matchNames.set(matchKey, index);
    });
    if (term.domain !== 'medical') issues.push({ code: 'invalid_domain', index });
  });
  return issues;
}
