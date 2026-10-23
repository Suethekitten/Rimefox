// MV3 service workers require a static module graph. Register production packages here.
import { medicalProfile } from './profiles/medical/index.js';

export const generalProfile = Object.freeze({
  id: 'general', version: '1', name: '通用翻译', supportedDirections: Object.freeze(['*']), termLimit: 0,
  buildInstructions() { return ''; }, matchTerms() { return []; }, formatTerms() { return ''; },
  buildContext() { return {}; },
  validate() { return { status: 'pass', issues: [], checked: false }; },
  getFingerprint() { return ''; }
});

/** Profiles are pure synchronous packages. No network, storage, DOM, or config access. */
export function createProfileRegistry(profiles = []) {
  const entries = new Map();
  function register(profile) {
    if (!profile || !/^[a-z][a-z0-9-]*$/.test(profile.id) || typeof profile.version !== 'string' || !profile.version ||
        typeof profile.name !== 'string' || !Array.isArray(profile.supportedDirections)) throw new TypeError('Invalid professional profile metadata');
    for (const method of ['buildInstructions', 'matchTerms', 'buildContext', 'validate', 'getFingerprint']) {
      if (typeof profile[method] !== 'function') throw new TypeError('Missing professional profile method: ' + method);
    }
    if (entries.has(profile.id)) throw new Error('Duplicate professional profile: ' + profile.id);
    entries.set(profile.id, Object.freeze({ ...profile }));
    return profile.id;
  }
  profiles.forEach(register);
  return Object.freeze({ register, get: id => entries.get(id), list: () => Array.from(entries.values()) });
}

export const professionalRegistry = createProfileRegistry([generalProfile, medicalProfile]);
export const getProfessionalProfile = id => professionalRegistry.get(id) || generalProfile;
