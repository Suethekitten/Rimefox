// Shared budget and user priority, independent of any discipline's dictionary.
import { GLOSSARY_PROMPT_LIMIT } from '../glossary.js';

export function matchProfileTerms(profile, texts, target, userHits = [], excludeSources = []) {
  const limit = Math.max(0, Math.min(Number(profile.termLimit) || 12, GLOSSARY_PROMPT_LIMIT - userHits.length));
  if (!limit) return [];
  const excluded = new Set(Array.from(excludeSources, x => String(x).toLowerCase()));
  userHits.forEach(x => excluded.add(x.source.toLowerCase()));
  return profile.matchTerms(texts, target, { limit, excludeSources: excluded });
}
