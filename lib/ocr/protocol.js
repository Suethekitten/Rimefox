// OCR 本地组件协议（扩展 ⇄ Native Messaging 宿主），v1。
// 纯函数：后台、扩展页面、Node 测试和参考宿主（tools/ocr-mock-host）共用同一份校验。
// 协议说明与示例见 docs/OCR-INTERFACE.md §3；改字段必须同步文档并升 OCR_PROTOCOL_VERSION。

export const OCR_PROTOCOL_VERSION = 1;

// 宿主名只能是小写字母、数字、下划线和点；正式组件安装器按这个名字注册宿主清单。
export const OCR_NATIVE_HOST = 'com.rimefox.ocr';

// 本地组件可以提供的后端。新增后端时同步 status.js 的 OCR_CHOICES 与文档。
export const OCR_NATIVE_BACKENDS = ['system', 'paddle'];

// 后端自报的状态（hello 响应里 backends[].status）。
export const OCR_BACKEND_STATES = ['ready', 'engine_missing', 'model_missing', 'language_unavailable', 'incompatible', 'unsupported'];

// 宿主在 result.error.code 里允许返回的错误码；未知码一律按 internal 处理。
export const OCR_HOST_ERRORS = [
  'bad_request', 'unsupported_protocol', 'engine_missing', 'model_missing',
  'language_unavailable', 'incompatible', 'too_large', 'busy', 'cancelled', 'internal'
];

export const OCR_IMAGE_MIMES = ['image/png', 'image/jpeg'];

export const OCR_LIMITS = {
  // Chrome：宿主 → 扩展单条消息上限 1 MB，扩展 → 宿主 64 MiB。
  hostMessageBytes: 1024 * 1024,
  requestBytes: 64 * 1024 * 1024,
  // base64 后的图像上限。阅读器单页画布不超过 4 Mi 像素（lib/reader/pdf-raster.js），PNG 远低于此。
  imageBase64Chars: 32 * 1024 * 1024,
  imageMaxSide: 8192,
  maxLines: 5000,
  maxLineChars: 4000,
  maxTextChars: 300000,
  maxLanguages: 8,
  maxBackends: 8
};

const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BACKEND_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export class OcrError extends Error {
  constructor(code, message, detail) {
    super(message || code);
    this.name = 'OcrError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

function shortText(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export function normalizeLanguages(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const one of list) {
    if (typeof one !== 'string' || !LANG_RE.test(one) || out.includes(one)) continue;
    out.push(one);
    if (out.length >= OCR_LIMITS.maxLanguages) break;
  }
  return out;
}

// 校验并规范化识别输入图像：{ mime, data(base64，不带 data: 前缀), width, height }。
export function normalizeOcrImage(image) {
  if (!image || typeof image !== 'object') throw new OcrError('bad_request', '缺少识别图像');
  const mime = String(image.mime || '');
  if (!OCR_IMAGE_MIMES.includes(mime)) throw new OcrError('bad_request', '图像格式只支持 PNG / JPEG');
  const data = typeof image.data === 'string' ? image.data : '';
  if (!data || data.length % 4 !== 0 || !BASE64_RE.test(data)) throw new OcrError('bad_request', '图像数据不是有效的 base64');
  if (data.length > OCR_LIMITS.imageBase64Chars) throw new OcrError('too_large', '图像过大');
  const width = Number(image.width);
  const height = Number(image.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > OCR_LIMITS.imageMaxSide || height > OCR_LIMITS.imageMaxSide) {
    throw new OcrError('bad_request', '图像尺寸无效');
  }
  return { mime, data, width, height };
}

// data:image/png;base64,xxxx → { mime, data }
export function splitDataUrl(url) {
  const m = /^data:(image\/(?:png|jpeg));base64,(.*)$/.exec(String(url || ''));
  if (!m) throw new OcrError('bad_request', '不是 PNG / JPEG 的 data URL');
  return { mime: m[1], data: m[2] };
}

export function buildHello({ id, clientVersion }) {
  return { v: OCR_PROTOCOL_VERSION, id: String(id), type: 'hello', client: { name: 'rimefox', version: String(clientVersion || '') } };
}

export function buildRecognize({ id, backend, image, languages, device }) {
  if (!BACKEND_RE.test(String(backend || ''))) throw new OcrError('bad_request', '后端 id 无效');
  const dev = device === 'gpu' || device === 'cpu' ? device : 'auto';
  return {
    v: OCR_PROTOCOL_VERSION,
    id: String(id),
    type: 'recognize',
    backend: String(backend),
    image: normalizeOcrImage(image),
    languages: normalizeLanguages(languages),
    options: { device: dev }
  };
}

export function buildCancel({ id, target }) {
  return { v: OCR_PROTOCOL_VERSION, id: String(id), type: 'cancel', target: String(target) };
}

function normalizeBackend(raw) {
  if (!raw || typeof raw !== 'object' || !BACKEND_RE.test(String(raw.id || ''))) return null;
  const status = OCR_BACKEND_STATES.includes(raw.status) ? raw.status : 'unsupported';
  const devices = Array.isArray(raw.devices) ? raw.devices.filter((d) => d === 'gpu' || d === 'cpu') : [];
  return {
    id: raw.id,
    status,
    name: shortText(raw.name, 80),
    version: shortText(raw.version, 40),
    model: shortText(raw.model, 80),
    devices: Array.from(new Set(devices)),
    languages: normalizeLanguages(raw.languages),
    // 下载 / 磁盘占用由组件如实上报，设置页据此显示，不写跨平台约数。单位：字节。
    downloadBytes: Number.isFinite(raw.downloadBytes) && raw.downloadBytes >= 0 ? Math.round(raw.downloadBytes) : null,
    diskBytes: Number.isFinite(raw.diskBytes) && raw.diskBytes >= 0 ? Math.round(raw.diskBytes) : null,
    message: shortText(raw.message, 200)
  };
}

function normalizeBox(box) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const nums = box.map(Number);
  if (!nums.every((n) => Number.isFinite(n) && n >= 0)) return null;
  return nums.map((n) => Math.round(n * 100) / 100);
}

export function normalizeLines(lines) {
  if (!Array.isArray(lines)) throw new OcrError('bad_response', '识别结果缺少 lines');
  if (lines.length > OCR_LIMITS.maxLines) throw new OcrError('bad_response', '识别结果行数过多');
  const out = [];
  let total = 0;
  for (const raw of lines) {
    if (!raw || typeof raw.text !== 'string') throw new OcrError('bad_response', '识别结果行格式无效');
    const text = raw.text.slice(0, OCR_LIMITS.maxLineChars);
    total += text.length;
    if (total > OCR_LIMITS.maxTextChars) throw new OcrError('bad_response', '识别文字过多');
    const conf = Number(raw.confidence);
    out.push({
      text,
      confidence: raw.confidence == null || !Number.isFinite(conf) ? null : Math.max(0, Math.min(1, conf)),
      // [x, y, w, h]，单位是输入图像像素，原点左上。
      box: normalizeBox(raw.box)
    });
  }
  return out;
}

// 解析宿主发来的一条消息；格式不对抛 OcrError('bad_response')，调用方据此断开或丢弃。
export function parseHostMessage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OcrError('bad_response', '宿主消息不是对象');
  if (raw.v !== OCR_PROTOCOL_VERSION) throw new OcrError('unsupported_protocol', '宿主协议版本不匹配', { v: raw.v });
  if (!ID_RE.test(String(raw.id || ''))) throw new OcrError('bad_response', '宿主消息缺少 id');
  if (raw.type === 'hello') {
    const component = raw.component && typeof raw.component === 'object' ? raw.component : {};
    const protocols = Array.isArray(component.protocols) ? component.protocols.filter(Number.isInteger) : [];
    const backends = (Array.isArray(raw.backends) ? raw.backends : [])
      .slice(0, OCR_LIMITS.maxBackends).map(normalizeBackend).filter(Boolean);
    return {
      type: 'hello',
      id: raw.id,
      component: { version: shortText(component.version, 40), platform: shortText(component.platform, 40), protocols },
      backends
    };
  }
  if (raw.type === 'result') {
    if (raw.ok !== true) {
      const err = raw.error && typeof raw.error === 'object' ? raw.error : {};
      const code = OCR_HOST_ERRORS.includes(err.code) ? err.code : 'internal';
      return { type: 'result', id: raw.id, ok: false, error: { code, message: shortText(err.message, 300) } };
    }
    const engine = raw.engine && typeof raw.engine === 'object' ? raw.engine : {};
    return {
      type: 'result',
      id: raw.id,
      ok: true,
      backend: BACKEND_RE.test(String(raw.backend || '')) ? raw.backend : '',
      engine: {
        name: shortText(engine.name, 80),
        version: shortText(engine.version, 40),
        model: shortText(engine.model, 80),
        device: engine.device === 'gpu' || engine.device === 'cpu' ? engine.device : ''
      },
      // GPU 初始化或识别失败后组件自行回退 CPU 时写 'gpu_failed'，阅读器只用于提示与记录。
      fallback: raw.fallback === 'gpu_failed' ? 'gpu_failed' : '',
      durationMs: Number.isFinite(raw.durationMs) && raw.durationMs >= 0 ? Math.round(raw.durationMs) : null,
      lines: normalizeLines(raw.lines)
    };
  }
  throw new OcrError('bad_response', '未知的宿主消息类型');
}
