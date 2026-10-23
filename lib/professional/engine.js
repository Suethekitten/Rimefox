import { getProfessionalProfile, professionalRegistry, generalProfile } from './registry.js';
import { normalizeDocumentContext, contextForTexts, contextFingerprint, contextPrompt } from './context.js';
import { matchProfileTerms } from './terminology.js';
import { validateTranslation, validationPolicyFingerprint, needsStrictReview, normalizeQuality, normalizeReviewLimit } from './validation.js';

/** One immutable policy per translate message; all paths use the same profile hooks. */
export function createProfessionalEngine(config = {}, request = {}) {
  const registry = request.registry || professionalRegistry;
  const id = config.professionalProfile || (config.medicalMode === true ? 'medical' : 'general');
  const profile = registry.get(id) || generalProfile;
  const enabled = profile.id !== 'general';
  const requested = config.professionalOptions || {};
  const options = Object.freeze({
    quality: normalizeQuality(requested.quality),
    subdomain: typeof requested.subdomain === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(requested.subdomain) ? requested.subdomain : 'auto',
    maxReviewRequests: normalizeReviewLimit(requested.maxReviewRequests)
  });
  // Privacy masking must never be bypassed by a title/heading in a new prompt channel.
  const context = profile.buildContext(normalizeDocumentContext(config.privacyEnabled ? null : request.documentContext));
  const excludeSources = request.excludeSources || [];
  const target = request.target;
  const forTexts = texts => contextForTexts(context, texts);
  return Object.freeze({
    profile, enabled, options,
    contextFor: forTexts,
    prompt(texts, userHits) {
      if (!enabled) return null;
      const selectedContext = forTexts(texts);
      const hits = matchProfileTerms(profile, texts, target, userHits, excludeSources);
      return {
        enabled: true, profileId: profile.id, hits,
        instructions: profile.buildInstructions({ ...selectedContext, subdomain: options.subdomain && options.subdomain !== 'auto' ? options.subdomain : selectedContext.subdomain, target, styled: !!request.style && request.style !== 'plain', options }),
        termInstructions: profile.formatTerms ? profile.formatTerms(hits) : hits.map(x => x.source + ' → ' + x.target).join('\n'),
        contextInstructions: contextPrompt(selectedContext, texts)
      };
    },
    fingerprint(text) {
      if (!enabled) return '';
      return JSON.stringify([
        'professional-v2', profile.id, profile.version,
        profile.getFingerprint({ text, target, excludeSources, context: forTexts([text]), options }),
        contextFingerprint(context, [text]), validationPolicyFingerprint(options), options.subdomain || 'auto'
      ]);
    },
    validate(source, translation) {
      if (!enabled) return null;
      return validateTranslation(profile, source, translation, { ...forTexts([source]), target, options, quality: options.quality });
    },
    needsReview: needsStrictReview
  });
}

// Retain systemPrompt's old eighth-argument shape for callers outside the new engine.
export function professionalPromptParts(spec, styled) {
  if (!spec || spec.enabled !== true) return [];
  if (typeof spec.instructions === 'string') return [spec.instructions, spec.termInstructions, spec.contextInstructions].filter(Boolean);
  const profile = getProfessionalProfile(spec.profileId || 'medical');
  return [profile.buildInstructions({ styled }), profile.formatTerms ? profile.formatTerms(spec.hits || []) : ''].filter(Boolean);
}
