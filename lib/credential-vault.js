// Extension-origin IndexedDB is not exposed through content-script chrome.storage.
// Only device credentials enter this database; session credentials stay in storage.session.
const DB = 'rimefox-credentials';
const TABLE = 'vault';
const memory = new WeakMap();
const clone = (v) => structuredClone(v);

export function memoryCredentialVault() {
  let state = { active: {} };
  return {
    async read(revision) {
      if (state.pending) state = { active: state.pending.id === revision ? state.pending.keys : state.active };
      return clone(state.active);
    },
    async stage(id, keys) { state = { active: state.active, pending: { id, keys: clone(keys) } }; }
  };
}

export function credentialVault(owner) {
  // Node fixtures explicitly have no browser IndexedDB. Never fall back to chrome.storage.
  if (typeof indexedDB === 'undefined' && typeof process !== 'undefined' && process.versions?.node) {
    if (!memory.has(owner)) memory.set(owner, memoryCredentialVault());
    return memory.get(owner);
  }
  let opening;
  function open() {
    if (!opening) opening = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('无法打开安全凭据存储，原设置已保留')); return; }
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(TABLE);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('凭据存储被其他窗口占用，请重试'));
      req.onsuccess = () => { req.result.onversionchange = () => { req.result.close(); opening = null; }; resolve(req.result); };
    }).catch((err) => { opening = null; throw err; });
    return opening;
  }
  async function update(change) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TABLE, 'readwrite');
      const table = tx.objectStore(TABLE);
      const req = table.get('device');
      let result;
      req.onsuccess = () => {
        try { const next = change(req.result || { active: {} }); result = next.active; table.put(next, 'device'); }
        catch (err) { tx.abort(); reject(err); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('凭据写入失败，原设置已保留'));
    });
  }
  return {
    read: (revision) => update((s) => ({ active: s.pending && s.pending.id === revision ? s.pending.keys : s.active })),
    stage: (id, keys) => update((s) => ({ active: s.active, pending: { id, keys } }))
  };
}
