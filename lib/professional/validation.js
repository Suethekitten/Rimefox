// 专业质量校验门面：同步、本地、无网络；严格复核的请求预算由后台统一执行。
export const VALIDATION_VERSION = '2';
export const MAX_REVIEW_REQUESTS = 3;

export function normalizeQuality(value) {
  return ['fast', 'balanced', 'strict'].includes(value) ? value : 'balanced';
}

export function normalizeReviewLimit(value) {
  if (value === undefined || value === null || value === '') return 1;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(MAX_REVIEW_REQUESTS, Math.floor(number))) : 1;
}

export function validationPolicyFingerprint(options) {
  const opts = options || {};
  const quality = normalizeQuality(opts.quality);
  return 'v' + VALIDATION_VERSION + ':' + quality + ':' + (quality === 'strict' ? normalizeReviewLimit(opts.maxReviewRequests) : 0);
}

export function needsStrictReview(result) {
  return Boolean(result && Array.isArray(result.issues) && result.issues.some((x) => x.severity === 'high'));
}

export function validateTranslation(profile, source, translation, context) {
  const ctx = context || {};
  const quality = normalizeQuality(ctx.quality || (ctx.options && ctx.options.quality));
  if (quality === 'fast' || !profile || typeof profile.validate !== 'function') {
    return { status: 'pass', issues: [], checked: false, quality, version: VALIDATION_VERSION };
  }
  try {
    const result = profile.validate(source, translation, ctx);
    if (!result || !['pass', 'review', 'error'].includes(result.status) || !Array.isArray(result.issues)) throw new Error('invalid validation result');
    if (result.checked === false) {
      return {
        ...result,
        status: result.status === 'pass' ? 'review' : result.status,
        issues: result.issues.concat([{ code: 'VALIDATION_INCOMPLETE', severity: 'medium', kind: 'deterministic', message: '专业校验器未完成检查，需要审查。' }]),
        checked: false, quality, version: VALIDATION_VERSION
      };
    }
    return { ...result, checked: result.checked !== false, quality, version: VALIDATION_VERSION };
  } catch (error) {
    // 校验器失败不能被误报为通过；无原文/译文/异常堆栈进入诊断。
    return { status: 'review', issues: [{ code: 'VALIDATOR_FAILURE', severity: 'medium', kind: 'deterministic', message: '本地质量检查未完成，需要审查。' }], checked: false, quality, version: VALIDATION_VERSION };
  }
}

export const runProfessionalValidation = validateTranslation;
