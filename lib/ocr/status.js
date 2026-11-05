// OCR 选择与状态：纯函数，设置页、阅读器、后台共用同一套判定，避免两边各写一份口径。
// 对应 docs/PDF-HANDOFF.md §5.2 的选择表；状态码说明见 docs/OCR-INTERFACE.md §2。

export const OCR_CHOICES = ['auto', 'system', 'paddle', 'off'];
export const OCR_DEFAULT_CHOICE = 'auto';

// 「自动选择」的优先顺序：先系统 OCR，再本地 PaddleOCR；以后接入的后端追加在末尾。
export const OCR_AUTO_ORDER = ['system', 'paddle'];

export const OCR_STATUS = Object.freeze({
  READY: 'ready',
  NOT_CONFIGURED: 'not_configured', // 自动选择下没有任何就绪引擎
  DISABLED: 'disabled', // 用户主动关闭
  PERMISSION_NEEDED: 'permission_needed', // 没有授予 nativeMessaging 可选权限
  COMPONENT_MISSING: 'component_missing', // 连接器未安装 / 宿主清单不存在
  ENGINE_MISSING: 'engine_missing', // 连接器在，但所选引擎包未安装
  MODEL_MISSING: 'model_missing',
  LANGUAGE_UNAVAILABLE: 'language_unavailable',
  INCOMPATIBLE: 'incompatible', // 协议 / 版本 / 扩展 ID 不匹配
  UNSUPPORTED: 'unsupported', // 当前平台没有这种后端
  ERROR: 'error' // 检测失败、宿主崩溃等，可重试
});

const KNOWN = new Set(Object.values(OCR_STATUS));

export function normalizeOcrChoice(value) {
  return OCR_CHOICES.includes(value) ? value : OCR_DEFAULT_CHOICE;
}

// 把来源（source）的连接状态折算到它负责的后端上：来源连不上时，它名下的后端都不可用。
// source: { status: 'ok' | 'permission_needed' | 'component_missing' | 'incompatible' | 'error', provides, backends }
export function backendStatesFromSources(sources) {
  const out = [];
  for (const src of sources || []) {
    if (!src) continue;
    if (src.status === 'ok') {
      const seen = new Set();
      for (const b of src.backends || []) {
        if (!b || seen.has(b.id)) continue;
        seen.add(b.id);
        out.push({ ...b, source: src.id, status: KNOWN.has(b.status) ? b.status : OCR_STATUS.UNSUPPORTED });
      }
      // 来源已连上但没报某个后端：该平台 / 该安装不提供它。
      for (const id of src.provides || []) {
        if (!seen.has(id)) out.push({ id, source: src.id, status: id === 'system' ? OCR_STATUS.UNSUPPORTED : OCR_STATUS.ENGINE_MISSING });
      }
    } else {
      const status = KNOWN.has(src.status) ? src.status : OCR_STATUS.ERROR;
      for (const id of src.provides || []) out.push({ id, source: src.id, status });
    }
  }
  return out;
}

// 根据用户选择和各后端状态得出「现在能不能识别、用哪个后端」。
// 返回 { choice, status, backend, reason }：backend 只在 status === 'ready' 时有值；
// reason 是自动选择下未就绪时最值得提示的具体原因（设置页可以展示），阅读器仍按 status 提示。
export function resolveOcr(choice, backends) {
  const pick = normalizeOcrChoice(choice);
  const list = Array.isArray(backends) ? backends : [];
  if (pick === 'off') return { choice: pick, status: OCR_STATUS.DISABLED, backend: null, reason: '' };
  if (pick !== 'auto') {
    const hit = list.find((b) => b.id === pick);
    const status = hit ? hit.status : OCR_STATUS.UNSUPPORTED;
    return { choice: pick, status, backend: status === OCR_STATUS.READY ? pick : null, reason: status === OCR_STATUS.READY ? '' : status };
  }
  const order = OCR_AUTO_ORDER.concat(list.map((b) => b.id).filter((id) => !OCR_AUTO_ORDER.includes(id)));
  for (const id of order) {
    const hit = list.find((b) => b.id === id);
    if (hit && hit.status === OCR_STATUS.READY) return { choice: pick, status: OCR_STATUS.READY, backend: id, reason: '' };
  }
  // 版本不兼容是用户装过组件之后才会出现的问题，不能笼统报「未配置」。
  if (list.some((b) => b.status === OCR_STATUS.INCOMPATIBLE)) {
    return { choice: pick, status: OCR_STATUS.INCOMPATIBLE, backend: null, reason: OCR_STATUS.INCOMPATIBLE };
  }
  const rank = [OCR_STATUS.MODEL_MISSING, OCR_STATUS.LANGUAGE_UNAVAILABLE, OCR_STATUS.ENGINE_MISSING, OCR_STATUS.ERROR,
    OCR_STATUS.COMPONENT_MISSING, OCR_STATUS.PERMISSION_NEEDED, OCR_STATUS.UNSUPPORTED];
  const reason = rank.find((s) => list.some((b) => b.status === s)) || OCR_STATUS.COMPONENT_MISSING;
  return { choice: pick, status: OCR_STATUS.NOT_CONFIGURED, backend: null, reason };
}

// 可恢复（用户点「重试」或重新检测就可能好）的状态；其余需要用户去设置页处理。
export function isRetryableOcrStatus(status) {
  return status === OCR_STATUS.ERROR;
}

const SETTINGS = 'open-settings';

// 阅读器 / 设置页的提示文案。not_configured 的中英文是用户指定原文，不要改写。
const NOTICES = {
  not_configured: { zh: '未配置OCR，请前往设置配置', en: 'No OCR configured. Please configure OCR in Settings.', action: SETTINGS },
  permission_needed: { zh: '需要授权连接本地 OCR 组件，请前往设置', en: 'Permission is needed to connect to the local OCR component. Please open Settings.', action: SETTINGS },
  component_missing: { zh: '未检测到本地 OCR 组件，请前往设置安装', en: 'Local OCR component not found. Please install it in Settings.', action: SETTINGS },
  engine_missing: { zh: '所选 OCR 引擎尚未安装，请前往设置', en: 'The selected OCR engine is not installed. Please open Settings.', action: SETTINGS },
  model_missing: { zh: '所选 OCR 引擎缺少模型，请前往设置', en: 'The selected OCR engine is missing its model. Please open Settings.', action: SETTINGS },
  language_unavailable: { zh: '所选 OCR 引擎不支持当前识别语言，请前往设置', en: 'The selected OCR engine does not support this language. Please open Settings.', action: SETTINGS },
  incompatible: { zh: '本地 OCR 组件版本不兼容，请前往设置更新', en: 'The local OCR component is incompatible. Please update it in Settings.', action: SETTINGS },
  unsupported: { zh: '当前系统不支持所选 OCR，请前往设置更换', en: 'The selected OCR is not available on this system. Please choose another in Settings.', action: SETTINGS },
  error: { zh: '检测 OCR 组件失败，可稍后重试', en: 'Could not check the OCR component. Please try again.', action: 'retry' },
  disabled: { zh: 'OCR 已关闭', en: 'OCR is turned off.', action: null }
};

// 返回 { kind: 'none' | 'prompt' | 'info', text, action: 'open-settings' | 'retry' | null }。
// ready 不提示；disabled 只显示状态、不引导去设置（尊重用户主动关闭）。
export function ocrNotice(status, uiLang) {
  if (status === OCR_STATUS.READY) return { kind: 'none', text: '', action: null };
  const one = NOTICES[status] || NOTICES.error;
  const text = uiLang === 'en' ? one.en : one.zh;
  return { kind: status === OCR_STATUS.DISABLED ? 'info' : 'prompt', text, action: one.action };
}
