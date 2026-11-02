import assert from 'node:assert/strict';
import test from 'node:test';
import { makeArea } from './_fake-storage.mjs';
import { createConfigStore, LOCAL_SECRETS, SESSION_SECRETS } from '../lib/config-storage.js';
import { activeConfig, publicConfig, configPatchSince } from '../lib/config.js';
import { configFingerprint, createConfigBroadcaster } from '../lib/config-broadcast.js';

const key = 'mock-secret-for-session-test';
const slot = { engine: 'openai', baseUrl: 'https://mock.invalid/v1', model: 'fake', apiKey: key };
const config = { _v: 8, currentProvider: 'deepseek', providerConfig: { deepseek: slot } };
function env() {
  const local = makeArea({ clone: true });
  const session = makeArea({ clone: true });
  return { local, session, store: createConfigStore({ local, session }) };
}

test('legacy initialization is serialized, keeps device policy and scrubs backups', async () => {
  const e = env();
  await e.local.set({ config, config_backup_v3: config });
  const values = await Promise.all(Array.from({ length: 20 }, () => e.store.get()));
  assert.ok(values.every((cfg) => cfg.credentialRevision === values[0].credentialRevision));
  assert.equal(values[0].keyMigrationPending, true);
  assert.equal(activeConfig(values[0]).apiKey, key);
  assert.equal(activeConfig(values[0]).keyStorage, 'local');
  const disk = await e.local.get(null);
  assert.equal(disk[LOCAL_SECRETS].deepseek.key, key);
  assert.ok(!JSON.stringify(disk.config).includes(key));
  assert.ok(!JSON.stringify(disk.config_backup_v3).includes(key));
  const before = JSON.stringify(await e.local.get(null));
  await e.store.get();
  assert.equal(JSON.stringify(await e.local.get(null)), before);
});

test('new keys default to session; worker recreation keeps them, complete browser restart removes them', async () => {
  const e = env();
  await e.store.save({ currentProvider: 'deepseek', providerConfig: { deepseek: slot } });
  assert.ok(!JSON.stringify(await e.local.get(null)).includes(key));
  assert.equal(activeConfig(await createConfigStore(e).get()).apiKey, key);
  const freshSession = makeArea({ clone: true });
  assert.equal(activeConfig(await createConfigStore({ local: e.local, session: freshSession }).get()).apiKey, '');
});

test('consented migration removes every disk copy and is idempotent', async () => {
  const e = env();
  await e.local.set({ config, config_backup_v3: { ...config, engineConfig: { openai: { apiKey: key } } } });
  await e.store.get();
  const migrated = await e.store.save({ keyMigration: 'session' });
  assert.equal(migrated.keyMigrationPending, false);
  assert.equal(activeConfig(migrated).apiKey, key);
  assert.equal(activeConfig(migrated).keyStorage, 'session');
  assert.ok(!JSON.stringify(await e.local.get(null)).includes(key));
  const again = await e.store.save({ keyMigration: 'session' });
  assert.equal(again.credentialRevision, migrated.credentialRevision);
  assert.equal(activeConfig(await createConfigStore(e).get()).apiKey, key);
});

test('remembering keys persists across browser sessions and deleting a provider removes its credentials', async () => {
  const e = env();
  const custom = { ...slot, keyStorage: 'local' };
  await e.store.save({ currentProvider: '__custom__', customProviders: [{ id: '__custom__', name: 'Mock' }], providerConfig: { __custom__: custom } });
  const restarted = createConfigStore({ local: e.local, session: makeArea({ clone: true }) });
  assert.equal(activeConfig(await restarted.get()).apiKey, key);
  await restarted.save({ customProviders: [], currentProvider: 'deepseek' });
  assert.ok(!JSON.stringify(await e.local.get(null)).includes(key));
});

test('failed session staging or local commit preserves the old key and can retry', async () => {
  for (const failure of ['session', 'local']) {
    const e = env();
    await e.local.set({ config });
    await e.store.get();
    const area = failure === 'session' ? e.session : e.local;
    const original = area.set;
    area.set = async () => { throw new Error('simulated write failure'); };
    await assert.rejects(e.store.save({ keyMigration: 'session' }), /simulated/);
    area.set = original;
    const recovered = await createConfigStore(e).get();
    assert.equal(activeConfig(recovered).apiKey, key);
    assert.equal(activeConfig(recovered).keyStorage, 'local');
    assert.equal(activeConfig(await e.store.save({ keyMigration: 'session' })).apiKey, key);
  }
});

test('a committed journal recovers after worker termination before session finalization', async () => {
  const e = env();
  await e.local.set({ config });
  await e.store.get();
  const original = e.session.set;
  e.session.set = async (change) => {
    if (!change[SESSION_SECRETS]?.pending) throw new Error('worker terminated after local commit');
    return original(change);
  };
  await assert.rejects(e.store.save({ keyMigration: 'session' }), /worker terminated/);
  e.session.set = original;
  const recovered = await createConfigStore(e).get();
  assert.equal(activeConfig(recovered).apiKey, key);
  assert.equal(activeConfig(recovered).keyStorage, 'session');
  assert.ok(!JSON.stringify(await e.local.get(null)).includes(key));
});

test('concurrent saves preserve independent fields; invalid saves do not mutate credentials', async () => {
  const e = env();
  await e.store.save({ providerConfig: { deepseek: slot } });
  await Promise.all([e.store.save({ uiTheme: 'dark' }), e.store.save({ targetLang: 'fr' })]);
  const saved = await e.store.get();
  assert.equal(saved.uiTheme, 'dark');
  assert.equal(saved.targetLang, 'fr');
  await assert.rejects(e.store.save({ glossary: [{ source: 'bad', target: '坏', note: '中'.repeat(501) }], providerConfig: { deepseek: { apiKey: 'do-not-store' } } }));
  assert.equal(activeConfig(await e.store.get()).apiKey, key);
});

test('two stale form snapshots submit only their own edits, including provider Key changes', async () => {
  const e = env();
  const initial = await e.store.save({ providerConfig: { deepseek: slot } });
  const first = structuredClone(initial);
  const second = structuredClone(initial);
  first.uiTheme = 'dark';
  second.providerConfig.deepseek.apiKey = 'mock-changed-in-second-window';
  await Promise.all([e.store.save(configPatchSince(initial, first)), e.store.save(configPatchSince(initial, second))]);
  const result = await e.store.get();
  assert.equal(result.uiTheme, 'dark');
  assert.equal(activeConfig(result).apiKey, 'mock-changed-in-second-window');
});

test('pause survives worker recreation; old failures cannot pause replacement credentials', async () => {
  const e = env();
  const initial = await e.store.save({ providerConfig: { deepseek: slot } });
  assert.equal(await e.store.pause(initial.credentialRevision), true);
  assert.equal((await createConfigStore(e).get()).authPaused, true);
  assert.equal((await e.store.save({ uiTheme: 'dark' })).authPaused, true);
  const replacement = await e.store.save({ providerConfig: { deepseek: { apiKey: 'mock-replacement' } } });
  assert.equal(replacement.authPaused, false);
  assert.equal(await e.store.pause(initial.credentialRevision), false);
  assert.equal(await e.store.resume(initial.credentialRevision), false);
  assert.equal((await e.store.get()).authPaused, false);
});

test('fingerprints exclude Key values and write journals, but change with credential revisions', async () => {
  assert.equal(await configFingerprint({ a: 1, apiKey: 'one', _storageRevision: 'one' }), await configFingerprint({ apiKey: 'two', _storageRevision: 'two', a: 1 }));
  const e = env();
  const before = publicConfig(await e.store.save({ providerConfig: { deepseek: slot } }));
  const after = publicConfig(await e.store.save({ providerConfig: { deepseek: { apiKey: 'replacement' } } }));
  assert.ok(!JSON.stringify(before).includes(key));
  assert.equal(before.hasKey, after.hasKey);
  assert.notEqual(await configFingerprint(before), await configFingerprint(after));
});

test('20-tab broadcasts coalesce changes, skip duplicate fingerprints and contain no Key', async () => {
  const sent = [];
  let reads = 0;
  let revision = 'one';
  const broadcaster = createConfigBroadcaster({ delay: 5, stagger: 0,
    read: async () => { reads += 1; return { credentialRevision: revision, apiKey: 'must-not-leak' }; },
    tabs: async () => Array.from({ length: 20 }, (_, id) => ({ id })),
    send: async (id, payload) => sent.push({ id, payload })
  });
  for (let i = 0; i < 50; i += 1) broadcaster.schedule();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(reads, 1);
  assert.equal(sent.length, 20);
  await broadcaster.flush();
  assert.equal(sent.length, 20);
  revision = 'two';
  await broadcaster.flush();
  assert.equal(sent.length, 40);
  assert.ok(!JSON.stringify(sent).includes('must-not-leak'));
});

test('a silent tab does not block other tabs or future broadcasts', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const sent = [];
  let revision = 1;
  const broadcaster = createConfigBroadcaster({ stagger: 1, sendTimeout: 10,
    read: async () => ({ revision }),
    tabs: async () => [{ id: 1 }, { id: 2 }, { id: 3 }],
    send: async (id) => { sent.push(id); if (id === 1) await held; }
  });
  try {
    await broadcaster.flush();
    assert.deepEqual(sent, [1, 2, 3]);
    revision = 2;
    await broadcaster.flush();
    assert.deepEqual(sent, [1, 2, 3, 1, 2, 3]);
  } finally { release(); }
});
