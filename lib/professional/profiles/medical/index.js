// Static adapter: retain the audited medical package and its public compatibility API.
import { MEDICAL_PROFILE_VERSION, MEDICAL_TERM_LIMIT, medicalPrompt, medicalTermPrompt } from '../../../medical/profile.js';
import { matchMedicalTerms, medicalFingerprintFor } from '../../../medical/terminology.js';
import { validateMedical } from './validators.js';
import { normalizeDocumentContext } from '../../context.js';

export const medicalProfile = Object.freeze({
  id: 'medical',
  version: MEDICAL_PROFILE_VERSION,
  name: '医学专业翻译',
  supportedDirections: Object.freeze(['en>zh-CN', 'zh-CN>en']),
  termLimit: MEDICAL_TERM_LIMIT,
  buildInstructions(context) { return medicalPrompt(context.styled, context); },
  matchTerms(texts, target, options) {
    return matchMedicalTerms(texts, target, options.limit, options.excludeSources);
  },
  formatTerms: medicalTermPrompt,
  buildContext: normalizeDocumentContext,
  validate: validateMedical,
  getFingerprint(context) {
    return medicalFingerprintFor(context.text, context.target, context.excludeSources);
  }
});
