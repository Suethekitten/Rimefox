// OCR 来源：经 Native Messaging 连接已安装的本地组件（连接器 + 可选 PaddleOCR 引擎包）。
// 只在后台 service worker 里使用；chrome 相关能力全部由调用方注入，Node 测试用假端口驱动。
// 来源接口（detect / recognize / cancel / dispose）见 docs/OCR-INTERFACE.md §4。
import {
  OCR_PROTOCOL_VERSION, OCR_NATIVE_BACKENDS, OcrError,
  buildHello, buildRecognize, buildCancel, parseHostMessage
} from './protocol.js';
import { OCR_STATUS } from './status.js';

// chrome.runtime.lastError.message → 来源状态。Chrome 不保证文案稳定，匹配不到时按可重试的 error。
export function mapNativeError(message) {
  const text = String(message || '').toLowerCase();
  if (text.includes('not found')) return OCR_STATUS.COMPONENT_MISSING;
  if (text.includes('forbidden') || text.includes('invalid native messaging host name')) return OCR_STATUS.INCOMPATIBLE;
  return OCR_STATUS.ERROR;
}

// options:
//   connect()          → Port（chrome.runtime.connectNative(OCR_NATIVE_HOST)）；未授予权限时可抛错或返回 null
//   lastError()        → string | ''（chrome.runtime.lastError?.message）
//   hasPermission()    → Promise<boolean>（chrome.permissions.contains({ permissions: ['nativeMessaging'] })）
//   clientVersion      → 扩展版本号，随 hello 发给组件
//   helloTimeoutMs / requestTimeoutMs / idleMs：超时与空闲断开
//   timers             → { set, clear }，测试可替换
export function createNativeOcrSource(options) {
  const opts = options || {};
  // Node 里 unref，避免空闲计时器拖住测试进程；service worker 的 setTimeout 返回数字，不受影响。
  const timers = opts.timers || {
    set: (fn, ms) => { const t = setTimeout(fn, ms); if (t && typeof t.unref === 'function') t.unref(); return t; },
    clear: (id) => clearTimeout(id)
  };
  const helloTimeoutMs = opts.helloTimeoutMs || 5000;
  const requestTimeoutMs = opts.requestTimeoutMs || 120000;
  const idleMs = opts.idleMs || 60000;

  let port = null;
  let seq = 0;
  let idleTimer = null;
  let helloInfo = null; // 最近一次握手结果（连接存续期间有效）
  const pending = new Map(); // id → { resolve, reject, timer, kind }

  const nextId = () => 'r' + (++seq);

  function clearIdle() {
    if (idleTimer) timers.clear(idleTimer);
    idleTimer = null;
  }
  function armIdle() {
    clearIdle();
    if (pending.size) return;
    idleTimer = timers.set(() => dispose(), idleMs);
  }

  function settle(id, fn, value) {
    const job = pending.get(id);
    if (!job) return; // 已取消 / 超时的晚归响应：丢弃
    pending.delete(id);
    if (job.timer) timers.clear(job.timer);
    if (job.onAbort && job.signal) job.signal.removeEventListener('abort', job.onAbort);
    fn === 'resolve' ? job.resolve(value) : job.reject(value);
    armIdle();
  }

  function failAll(err) {
    for (const id of Array.from(pending.keys())) settle(id, 'reject', err);
  }

  function onMessage(raw) {
    let msg;
    try {
      msg = parseHostMessage(raw);
    } catch (err) {
      // 协议不匹配或格式错误：整条连接都不可信，断开并让在途任务失败。
      const code = err.code === 'unsupported_protocol' ? OCR_STATUS.INCOMPATIBLE : OCR_STATUS.ERROR;
      const id = raw && typeof raw.id === 'string' ? raw.id : '';
      if (id && pending.has(id) && code === OCR_STATUS.ERROR) settle(id, 'reject', new OcrError('bad_response', err.message));
      else drop(new OcrError(code, err.message));
      return;
    }
    if (msg.type === 'hello') settle(msg.id, 'resolve', msg);
    else if (msg.ok) settle(msg.id, 'resolve', msg);
    else settle(msg.id, 'reject', new OcrError(msg.error.code, msg.error.message || msg.error.code));
  }

  function drop(err) {
    const old = port;
    port = null;
    helloInfo = null;
    clearIdle();
    if (old) { try { old.disconnect(); } catch (e) { /* 已断开 */ } }
    failAll(err);
  }

  function ensurePort() {
    if (port) return port;
    let next = null;
    try {
      next = opts.connect ? opts.connect() : null;
    } catch (err) {
      throw new OcrError(mapNativeError(err && err.message), (err && err.message) || '无法连接本地 OCR 组件');
    }
    if (!next) throw new OcrError(OCR_STATUS.PERMISSION_NEEDED, '未授权连接本地 OCR 组件');
    port = next;
    next.onMessage.addListener(onMessage);
    next.onDisconnect.addListener(() => {
      if (port !== next) return;
      const message = (opts.lastError && opts.lastError()) || '本地 OCR 组件已断开';
      port = null;
      helloInfo = null;
      clearIdle();
      failAll(new OcrError(mapNativeError(message), message));
    });
    return next;
  }

  function request(message, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      let p;
      try {
        p = ensurePort();
      } catch (err) {
        reject(err);
        return;
      }
      clearIdle();
      const job = { resolve, reject, signal, timer: null, onAbort: null };
      job.timer = timers.set(() => {
        settle(message.id, 'reject', new OcrError(OCR_STATUS.ERROR, '本地 OCR 组件响应超时'));
      }, timeoutMs);
      if (signal) {
        job.onAbort = () => {
          try { p.postMessage(buildCancel({ id: nextId(), target: message.id })); } catch (e) { /* 端口已断 */ }
          settle(message.id, 'reject', new OcrError('cancelled', '已取消'));
        };
        signal.addEventListener('abort', job.onAbort, { once: true });
      }
      pending.set(message.id, job);
      try {
        p.postMessage(message);
      } catch (err) {
        settle(message.id, 'reject', new OcrError(OCR_STATUS.ERROR, (err && err.message) || '发送失败'));
      }
    });
  }

  async function handshake() {
    if (helloInfo) return helloInfo;
    const hello = await request(buildHello({ id: nextId(), clientVersion: opts.clientVersion }), helloTimeoutMs);
    if (!hello.component.protocols.includes(OCR_PROTOCOL_VERSION)) {
      drop(new OcrError(OCR_STATUS.INCOMPATIBLE, '本地 OCR 组件协议版本不兼容'));
      throw new OcrError(OCR_STATUS.INCOMPATIBLE, '本地 OCR 组件协议版本不兼容', { protocols: hello.component.protocols });
    }
    helloInfo = hello;
    armIdle();
    return hello;
  }

  // 来源接口：detect → { id, status, provides, component, backends, message }
  async function detect({ refresh } = {}) {
    const base = { id: 'native', provides: OCR_NATIVE_BACKENDS.slice(), component: null, backends: [], message: '' };
    let granted = false;
    try {
      granted = opts.hasPermission ? await opts.hasPermission() : false;
    } catch (err) {
      granted = false;
    }
    if (!granted) return { ...base, status: OCR_STATUS.PERMISSION_NEEDED };
    if (refresh) helloInfo = null;
    try {
      const hello = await handshake();
      return { ...base, status: 'ok', component: hello.component, backends: hello.backends };
    } catch (err) {
      const code = err instanceof OcrError ? err.code : OCR_STATUS.ERROR;
      const status = [OCR_STATUS.PERMISSION_NEEDED, OCR_STATUS.COMPONENT_MISSING, OCR_STATUS.INCOMPATIBLE].includes(code) ? code : OCR_STATUS.ERROR;
      return { ...base, status, message: (err && err.message) || '' };
    }
  }

  // 来源接口：recognize → 规范化后的 result（见 protocol.parseHostMessage 的 result 分支）
  async function recognize({ backend, image, languages, device, signal }) {
    if (signal && signal.aborted) throw new OcrError('cancelled', '已取消');
    await handshake();
    const message = buildRecognize({ id: nextId(), backend, image, languages, device });
    return request(message, requestTimeoutMs, signal);
  }

  function dispose() {
    drop(new OcrError(OCR_STATUS.ERROR, '本地 OCR 连接已关闭'));
  }

  return {
    id: 'native',
    provides: OCR_NATIVE_BACKENDS.slice(),
    detect,
    recognize,
    dispose,
    // 测试 / 诊断用
    get connected() { return !!port; },
    get pendingCount() { return pending.size; }
  };
}
