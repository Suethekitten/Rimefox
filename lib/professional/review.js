// Bounded orchestration. The caller owns paid requests, parsing and privacy restoration.
export async function reviewHighRisk({ engine, source, translation, report, budget, review, accept }) {
  if (engine.options.quality !== 'strict' || !engine.needsReview(report)) return { translation, report, changed: false };
  if (!budget.remaining) return { translation, report: { ...report, review: { attempted: false, reason: 'request-limit' } }, changed: false };
  // Reserve synchronously: concurrent batches share this message's single hard cap.
  budget.remaining -= 1;
  try {
    const candidate = await review(source, translation, report);
    if (typeof candidate !== 'string' || !candidate.trim() || !accept(candidate)) throw new Error('invalid-review-output');
    const checked = engine.validate(source, candidate);
    const high = result => result.issues.filter(x => x.severity === 'high').length;
    const deterministic = checked.issues.some(x => x.kind === 'deterministic' && x.severity === 'high');
    const improved = checked.checked === true && checked.status !== 'error' && !deterministic &&
      (checked.status === 'pass' || high(checked) < high(report));
    if (!improved) return { translation, report: { ...report, review: { attempted: true, accepted: false, reason: 'unresolved' } }, changed: false };
    return {
      translation: candidate,
      report: { ...checked, review: { attempted: true, accepted: true, expertReviewed: false } },
      changed: candidate !== translation
    };
  } catch {
    return { translation, report: { ...report, review: { attempted: true, accepted: false, reason: 'failed' } }, changed: false };
  }
}
