// 后台拥有配置 / 凭据的同一条串行队列；模块只在调用时读取 config.js 的绑定。
import { DEFAULTS, CONFIG_VERSION, mergeConfig, migrateConfig } from './config.js';
import { assertGlossaryNotes } from './glossary.js';
import { credentialVault } from './credential-vault.js';
import { endpointIdentity } from './provider-endpoint.js';

export const LOCAL_SECRETS = 'rimefox.secrets.local';
export const SESSION_SECRETS = 'rimefox.secrets.session';
const stores = new WeakMap();
const copy = (value) => JSON.parse(JSON.stringify(value));
const token = () => crypto.randomUUID();
// chrome.storage 读回对象时会重排键；写入确认只能比较「同一棵树」，不能比较键顺序。
export function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function scrub(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(scrub);
  const out = {};
  Object.keys(value).forEach((key) => { if (key !== 'apiKey') out[key] = scrub(value[key]); });
  return out;
}

function migrateSlots(stored) {
  const migrated = migrateConfig(stored);
  // Historical custom slots can predate the explicit provider list.
  if (!Array.isArray(migrated.customProviders)) {
    migrated.customProviders = Object.keys(migrated.providerConfig || {}).filter((id) => id === '__custom__' || id.startsWith('custom:')).map((id) => ({ id, name: '自定义' }));
  }
  return migrated;
}

export function createConfigStore({ local, session, vault = credentialVault(local) }) {
  let queue = Promise.resolve();
  const serial = (fn) => {
    const job = queue.then(fn);
    queue = job.catch(() => {});
    return job;
  };
  async function read() {
    const disk = await local.get(['config', 'config_backup_v3', 'config_migration_backup', LOCAL_SECRETS]);
    const stored = disk.config || {};
    const memory = session ? (await session.get(SESSION_SECRETS))[SESSION_SECRETS] || {} : {};
    let secrets = memory;
    if (memory.pending) {
      secrets = memory.pending.id === stored._storageRevision ? memory.pending.next : { ...memory, pending: undefined };
      await session.set({ [SESSION_SECRETS]: secrets });
    }
    const migrated = migrateSlots(stored);
    const cfg = mergeConfig(DEFAULTS, migrated);
    // Re-upgrading after an old-version rollback must retain keys edited in that version.
    const persistent = { ...await vault.read(stored._storageRevision), ...(disk[LOCAL_SECRETS] || {}) };
    const keys = {};
    let legacy = false;
    const legacyIds = [];
    Object.keys(cfg.providerConfig || {}).forEach((id) => {
      const slot = cfg.providerConfig[id];
      const oldKey = typeof slot.apiKey === 'string' ? slot.apiKey : '';
      if (oldKey) { legacy = true; legacyIds.push(id); }
      const policy = slot.keyStorage === 'local' || oldKey ? 'local' : 'session';
      const entry = (policy === 'local' ? persistent : secrets.keys || {})[id];
      keys[id] = oldKey ? { key: oldKey, version: entry && entry.key === oldKey ? entry.version : token() } : entry;
      slot.apiKey = keys[id] && typeof keys[id].key === 'string' ? keys[id].key : '';
      slot.keyStorage = policy;
    });
    const active = cfg.providerConfig[cfg.currentProvider] || {};
    cfg.credentialRevision = JSON.stringify([cfg.currentProvider, active.engine || '', String(active.baseUrl || '').trim().replace(/\/+$/, ''), keys[cfg.currentProvider]?.version || 'missing']);
    cfg.authPaused = !!(secrets.paused && secrets.paused.revision === cfg.credentialRevision);
    cfg.credentialsRevision = JSON.stringify(Object.keys(keys).sort().map((id) => [id, keys[id]?.version || 'missing']));
    // 一次性迁移只针对「旧版本写在配置里的 Key」。0.16.2 及更早没有记录名单时，
    // 只把当时已在设备上的 Key 当作旧 Key；升级后新填的会话 Key 不受迁移选择影响。
    const recorded = Array.isArray(stored.keyMigrationProviders) ? stored.keyMigrationProviders : Object.keys(persistent);
    const scope = stored.keyMigrationPending === true || legacy ? [...new Set([...recorded, ...legacyIds])] : [];
    cfg.keyMigrationProviders = scope.filter((id) => cfg.providerConfig[id] && cfg.providerConfig[id].keyStorage === 'local' && keys[id]);
    cfg.keyMigrationPending = cfg.keyMigrationProviders.length > 0;
    return { cfg, disk, stored, secrets, persistent, keys, legacy };
  }

  async function persist(state, next, migration) {
    const persistent = {};
    const ephemeral = {};
    const scope = state.cfg.keyMigrationProviders || [];
    const remaining = [];
    Object.keys(next.providerConfig || {}).forEach((id) => {
      const slot = next.providerConfig[id];
      const inScope = scope.includes(id);
      const policy = migration && inScope ? migration : (slot.keyStorage === 'local' ? 'local' : 'session');
      const key = typeof slot.apiKey === 'string' ? slot.apiKey.trim() : '';
      // 用户已在升级后亲自改过这个服务商的 Key 或保存方式：以用户的新选择为准，不再纳入迁移。
      if (!migration && inScope && policy === 'local' && key && state.keys[id] && state.keys[id].key === key) remaining.push(id);
      slot.keyStorage = policy;
      slot.apiKey = key;
      if (!key) return;
      const previous = state.keys[id];
      const entry = previous && previous.key === key ? previous : { key, version: token() };
      (policy === 'local' ? persistent : ephemeral)[id] = entry;
    });
    if (!session && Object.keys(ephemeral).length) throw new Error('当前浏览器不支持会话密钥存储');
    const id = token();
    const nextSecrets = { keys: ephemeral, paused: state.secrets.paused || null };
    const clean = scrub(next);
    delete clean.authPaused;
    delete clean.credentialRevision;
    delete clean.credentialsRevision;
    delete clean.keyMigration;
    clean.keyMigrationProviders = remaining;
    clean.keyMigrationPending = remaining.length > 0;
    clean._v = CONFIG_VERSION;
    clean._storageRevision = id;
    // 先保存可恢复的会话日志，再提交 local。SW 在两步之间退出也不会丢 Key。
    if (session) {
      await session.set({ [SESSION_SECRETS]: { ...state.secrets, pending: { id, next: nextSecrets } } });
      const verified = (await session.get(SESSION_SECRETS))[SESSION_SECRETS];
      if (stableJson(verified?.pending) !== stableJson({ id, next: nextSecrets })) throw new Error('会话密钥写入未确认，原设置已保留');
    }
    await vault.stage(id, persistent);
    const writes = { config: clean, [LOCAL_SECRETS]: {} };
    if ((Number(state.stored._v) || 1) < CONFIG_VERSION && Object.keys(state.stored).length) {
      writes.config_migration_backup = { fromVersion: Number(state.stored._v) || 1, toVersion: CONFIG_VERSION, createdAt: Date.now(), config: scrub(state.stored) };
    }
    if (state.disk.config_backup_v3) writes.config_backup_v3 = scrub(state.disk.config_backup_v3);
    else if ((Number(state.stored._v) || 1) < CONFIG_VERSION && Object.keys(state.stored).length) writes.config_backup_v3 = scrub(state.stored);
    await local.set(writes);
    await vault.read(id);
    // local 的提交标记是事实来源；最后一步失败时由下一次 read 恢复。
    if (session) { try { await session.set({ [SESSION_SECRETS]: nextSecrets }); } catch { /* journal retained */ } }
    return (await read()).cfg;
  }

  async function current() {
    let state = await read();
    if (state.legacy || Object.keys(state.disk[LOCAL_SECRETS] || {}).length || !state.stored._storageRevision || (Number(state.stored._v) || 1) < CONFIG_VERSION) {
      await persist(state, state.cfg);
      state = await read();
    }
    return state;
  }

  return {
    get: () => serial(async () => (await current()).cfg),
    recoveryInfo: () => serial(async () => {
      const backup = (await local.get('config_migration_backup')).config_migration_backup;
      return backup ? { available: true, fromVersion: backup.fromVersion, createdAt: backup.createdAt } : { available: false };
    }),
    restoreMigration: () => serial(async () => {
      const state = await current();
      const backup = state.disk.config_migration_backup;
      if (!backup?.config) throw new Error('没有可恢复的升级前配置');
      const next = mergeConfig(DEFAULTS, migrateSlots(backup.config));
      for (const [id, slot] of Object.entries(next.providerConfig || {})) {
        const now = state.cfg.providerConfig[id];
        // A rollback must never send the current credential to an old/different endpoint.
        const matches = now && now.engine === slot.engine && endpointIdentity(now.baseUrl) === endpointIdentity(slot.baseUrl);
        slot.apiKey = matches ? now.apiKey : '';
        slot.keyStorage = matches ? now.keyStorage : 'session';
      }
      return persist(state, next);
    }),
    save: (patch) => serial(async () => {
      const state = await current();
      const change = typeof patch === 'function' ? patch(copy(state.cfg)) : patch || {};
      if (change === null) return state.cfg;
      if (change.glossary !== undefined) assertGlossaryNotes(change.glossary);
      const migration = ['local', 'session'].includes(change.keyMigration) ? change.keyMigration : null;
      const next = mergeConfig(state.cfg, change);
      if (!migration && JSON.stringify(next) === JSON.stringify(state.cfg)) return state.cfg;
      return persist(state, next, migration);
    }),
    pause: (revision) => serial(async () => {
      const state = await current();
      if (!session || revision !== state.cfg.credentialRevision) return false;
      await session.set({ [SESSION_SECRETS]: { ...state.secrets, paused: { revision, reason: 'authentication' } } });
      return true;
    }),
    resume: (revision) => serial(async () => {
      const state = await current();
      if (!session || revision !== state.cfg.credentialRevision) return false;
      await session.set({ [SESSION_SECRETS]: { ...state.secrets, paused: null } });
      return true;
    })
  };
}

export function configStore() {
  const area = chrome.storage.local;
  if (!stores.has(area)) stores.set(area, createConfigStore({ local: area, session: chrome.storage.session }));
  return stores.get(area);
}
