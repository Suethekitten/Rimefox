// PDF 缓存与后台使用同一份非敏感配置身份，不能把 API Key 放进键或指纹。
import { activeConfig, languageInfoFor, normalizeTargetLang, styleById, normalizeIntensity, styleFingerprint, professionalProfileFor, normalizeProfessionalOptions } from '../config.js';
import { normalizeGlossary } from '../glossary.js';
import { temperatureFor } from '../prompt.js';
import { optionsFromConfig } from '../privacy.js';
import { getProfessionalProfile } from '../professional/registry.js';
import { sha256 } from './store.js';

export const PDF_CACHE_VERSION = 'pdf-v2';

// 同一份配置在 PDF 每页 / 每批都会重复计算身份：把结果按配置修订号缓存，
// 避免每个批次都重新清洗术语表并做 SHA-256。配置一保存修订号就会变。
const IDENTITY_CACHE_MAX = 32;
const identityCache = new Map();

function identityCacheKey(config, target, style) {
  const revision = config && typeof config._storageRevision === 'string' ? config._storageRevision : '';
  if (!revision) return '';
  return [revision, target || '', style || 'plain'].join('|');
}

async function computeIdentity(config, target, style) {
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

export async function pdfCacheIdentity(config = {}, target, style = 'plain') {
  const key = identityCacheKey(config, target, style);
  if (key) {
    const hit = identityCache.get(key);
    if (hit) {
      identityCache.delete(key);
      identityCache.set(key, hit);
      return hit;
    }
  }
  const result = await computeIdentity(config, target, style);
  if (key) {
    identityCache.set(key, result);
    while (identityCache.size > IDENTITY_CACHE_MAX) identityCache.delete(identityCache.keys().next().value);
  }
  return result;
}
