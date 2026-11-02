// PDF 缓存与后台使用同一份非敏感配置身份，不能把 API Key 放进键或指纹。
import { activeConfig, languageInfoFor, normalizeTargetLang, styleById, normalizeIntensity, styleFingerprint, professionalProfileFor, normalizeProfessionalOptions } from '../config.js';
import { normalizeGlossary } from '../glossary.js';
import { temperatureFor } from '../prompt.js';
import { optionsFromConfig } from '../privacy.js';
import { getProfessionalProfile } from '../professional/registry.js';
import { sha256 } from './store.js';

export const PDF_CACHE_VERSION = 'pdf-v2';

export async function pdfCacheIdentity(config = {}, target, style = 'plain') {
  const active = activeConfig(config);
  const language = languageInfoFor(target, config.customLanguages)
    || languageInfoFor(normalizeTargetLang(config.targetLang, config.customLanguages), config.customLanguages);
  const chosenStyle = styleById(style).value;
  const intensity = chosenStyle === 'plain' ? 'standard' : normalizeIntensity(config.funIntensity);
  const profile = getProfessionalProfile(professionalProfileFor(config));
  const identity = [
    PDF_CACHE_VERSION, language, chosenStyle, intensity, styleFingerprint(chosenStyle, intensity),
    active.provider, active.engine, active.baseUrl.trim().replace(/\/+$/, ''), active.model,
    String(config.customPrompt || '').trim(), normalizeGlossary(config.glossary),
    profile.id, profile.version, normalizeProfessionalOptions(config.professionalOptions),
    config.privacyEnabled === true ? optionsFromConfig(config) : null,
    config.aiContextEnabled === true, temperatureFor(config, chosenStyle),
    config.thinkingMode || 'off', config.thinkingMode === 'custom' ? config.thinkingExtra : ''
  ];
  return sha256(new TextEncoder().encode(JSON.stringify(identity)));
}
