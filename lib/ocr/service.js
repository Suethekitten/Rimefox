// OCR 服务：汇总所有来源（目前只有 native；以后可加扩展内 WASM 来源），按用户选择解析出可用后端，
// 串行执行识别任务并支持按 jobId 取消。后台 service worker 持有唯一实例，页面经消息路由调用。
// 接口说明见 docs/OCR-INTERFACE.md §4–§5。
import { OcrError, normalizeOcrImage, normalizeLanguages } from './protocol.js';
import { OCR_STATUS, backendStatesFromSources, resolveOcr, normalizeOcrChoice } from './status.js';

const JOB_ID_RE = /^[A-Za-z0-9:_-]{1,80}$/;

// options:
//   sources      → 来源数组，每个实现 { id, provides, detect({refresh}), recognize({...}), dispose?() }
//   getChoice()  → Promise<string>（配置里的 ocrEngine）
//   ttlMs        → 检测结果缓存时长；权限 / 组件变化时调用 invalidate()
//   now()        → 测试可替换
export function createOcrService(options) {
  const opts = options || {};
  const sources = (opts.sources || []).filter(Boolean);
  const ttlMs = opts.ttlMs == null ? 30000 : opts.ttlMs;
  const now = opts.now || (() => Date.now());

  let detected = null; // { at, sources }
  let detecting = null;
  let queue = Promise.resolve();
  const jobs = new Map(); // jobId → AbortController

  function invalidate() {
    detected = null;
  }

  async function detectAll(refresh) {
    if (!refresh && detected && now() - detected.at < ttlMs) return detected.sources;
    if (detecting && !refresh) return detecting;
    // 走到这里说明缓存已过期或被强制刷新：让来源重新握手，不复用连接里的旧 hello。
    const run = Promise.all(sources.map(async (src) => {
      try {
        return await src.detect({ refresh: true });
      } catch (err) {
        return { id: src.id, provides: src.provides || [], status: OCR_STATUS.ERROR, backends: [], message: (err && err.message) || '' };
      }
    })).then((list) => {
      detected = { at: now(), sources: list };
      return list;
    }).finally(() => {
      if (detecting === run) detecting = null;
    });
    detecting = run;
    return run;
  }

  // 返回给页面的完整状态快照（不含任何图像 / 文本）。
  async function status({ refresh } = {}) {
    const choice = normalizeOcrChoice(opts.getChoice ? await opts.getChoice() : undefined);
    const list = await detectAll(refresh);
    const backends = backendStatesFromSources(list);
    const resolved = resolveOcr(choice, backends);
    return {
      ...resolved,
      backends,
      sources: list.map((s) => ({ id: s.id, status: s.status, component: s.component || null, message: s.message || '' })),
      checkedAt: detected ? detected.at : now()
    };
  }

  function sourceFor(backendId, list) {
    const src = list.find((s) => s.status === 'ok' && (s.backends || []).some((b) => b.id === backendId));
    return src ? sources.find((one) => one.id === src.id) : null;
  }

  // 识别一张图。返回 { backend, engine, fallback, durationMs, lines }；
  // 未就绪抛 OcrError(status)，页面据此显示 ocrNotice，不重试也不把空文本送去翻译。
  async function recognize({ image, languages, jobId, device } = {}) {
    const img = normalizeOcrImage(image);
    const langs = normalizeLanguages(languages);
    const id = jobId == null ? '' : String(jobId);
    if (id && !JOB_ID_RE.test(id)) throw new OcrError('bad_request', 'jobId 无效');
    if (id && jobs.has(id)) throw new OcrError('bad_request', 'jobId 重复');

    // 先登记任务再检测组件：首次连接 / 握手期间到达的 ocr:cancel 也必须生效。
    const controller = new AbortController();
    if (id) jobs.set(id, controller);
    let snap;
    let src;
    try {
      snap = await status();
      if (controller.signal.aborted) throw new OcrError('cancelled', '已取消');
      if (snap.status !== OCR_STATUS.READY) throw new OcrError(snap.status, snap.reason || snap.status);
      src = sourceFor(snap.backend, (detected && detected.sources) || []);
      if (!src) {
        invalidate();
        throw new OcrError(OCR_STATUS.ERROR, '所选 OCR 来源不可用');
      }
    } catch (err) {
      if (id && jobs.get(id) === controller) jobs.delete(id);
      throw err;
    }

    // OCR 吃 CPU / GPU 和内存：全局串行，避免多页同时识别把组件拖垮。
    const run = queue.then(async () => {
      if (controller.signal.aborted) throw new OcrError('cancelled', '已取消');
      return src.recognize({ backend: snap.backend, image: img, languages: langs, device, signal: controller.signal });
    });
    queue = run.catch(() => {});
    try {
      return await run;
    } catch (err) {
      // 引擎 / 模型 / 组件状态变了：下一次重新检测，而不是一直用旧的「就绪」快照。
      if (err && [OCR_STATUS.ENGINE_MISSING, OCR_STATUS.MODEL_MISSING, OCR_STATUS.INCOMPATIBLE,
        OCR_STATUS.COMPONENT_MISSING, OCR_STATUS.ERROR].includes(err.code)) invalidate();
      throw err instanceof OcrError ? err : new OcrError(OCR_STATUS.ERROR, (err && err.message) || '识别失败');
    } finally {
      if (id && jobs.get(id) === controller) jobs.delete(id);
    }
  }

  function cancel(jobId) {
    const controller = jobs.get(String(jobId));
    if (!controller) return false;
    controller.abort();
    return true;
  }

  function dispose() {
    for (const c of jobs.values()) c.abort();
    jobs.clear();
    for (const src of sources) { try { if (src.dispose) src.dispose(); } catch (e) { /* ignore */ } }
    invalidate();
  }

  return { status, recognize, cancel, invalidate, dispose };
}
