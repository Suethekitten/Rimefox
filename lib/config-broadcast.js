// 指纹只来自脱敏配置与随机凭据修订号；不读取或散列 API Key。
export async function configFingerprint(config) {
  function stable(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(stable);
    return Object.fromEntries(Object.keys(value).sort().filter((key) => key !== 'apiKey' && key !== '_storageRevision').map((key) => [key, stable(value[key])]));
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(stable(config))));
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('');
}

export function createConfigBroadcaster({ read, tabs, send, delay = 200, stagger = 5, sendTimeout = 1000 }) {
  let timer;
  let running = false;
  let dirty = false;
  const delivered = new Map();
  async function flush() {
    if (running) { dirty = true; return; }
    running = true;
    try {
      const fingerprint = await configFingerprint(await read());
      const targets = await tabs();
      const live = new Set(targets.map((tab) => tab.id));
      for (const id of delivered.keys()) if (!live.has(id)) delivered.delete(id);
      const pending = [];
      for (const tab of targets) {
        if (tab.id == null || delivered.get(tab.id) === fingerprint) continue;
        // 错开发送时间，但不让一个迟迟不应答的标签挡住后面的标签。
        let deadline;
        pending.push(Promise.race([
          Promise.resolve().then(() => send(tab.id, { type: 'dt:configChanged', fingerprint })).then(() => true, () => false),
          new Promise((resolve) => { deadline = setTimeout(() => resolve(false), sendTimeout); })
        ]).then((ok) => { if (ok) delivered.set(tab.id, fingerprint); }).finally(() => clearTimeout(deadline)));
        if (stagger) await new Promise((resolve) => setTimeout(resolve, stagger));
      }
      await Promise.all(pending);
    } finally {
      running = false;
      if (dirty) { dirty = false; schedule(); }
    }
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => flush().catch(() => {}), delay);
  }
  return { schedule, flush };
}
