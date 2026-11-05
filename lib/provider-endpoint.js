export const endpointIdentity = (url) => String(url || '').trim().replace(/\/+$/, '');

// An unchanged saved credential is bound to its saved endpoint until the user saves
// the new address or supplies a different credential. Manual refresh has the same rule.
export function canFetchModels(saved, form) {
  return !saved?.apiKey || form.apiKey !== saved.apiKey || endpointIdentity(form.baseUrl) === endpointIdentity(saved.baseUrl);
}
