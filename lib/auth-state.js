import { configStore, LOCAL_SECRETS, SESSION_SECRETS } from './config-storage.js';
import { ApiError } from './engines/errors.js';

// 同一份凭据的连续批次不必每次都重读完整配置；配置 / 密钥 / 暂停状态变化时由
// storage.onChanged 清空缓存，保证换了 Key 之后下一次发送前仍会重新核对。
let knownRevision = '';
let knownPaused = false;
try {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' && area !== 'session') return;
      if (changes.config || changes[LOCAL_SECRETS] || changes[SESSION_SECRETS]) {
        knownRevision = '';
        knownPaused = false;
      }
    });
  }
} catch (err) {
  /* 测试或不支持 storage.onChanged 的环境：每次回退到读配置 */
}

export function isKeyFailure(status, raw = '') {
  return status === 401 || ([400, 403].includes(status) && /(?:invalid|incorrect|expired|revoked)[_ -]?(?:x[_ -]?)?(?:api[_ -]?)?key|authentication_error|api[_ -]?key[_ -]?(?:is[_ -]?)?(?:not[_ -]?valid|invalid|expired|revoked)/i.test(raw));
}

export function authGuard(snapshot, { allowPaused = false } = {}) {
  const revision = snapshot.credentialRevision;
  return {
    async beforeSend() {
      if (revision && revision === knownRevision) {
        if (!knownPaused || allowPaused) return;
        const error = new ApiError('接口鉴权失败，翻译已暂停；请在设置中更新密钥或测试连接。', 401, '');
        error.code = 'auth_paused';
        throw error;
      }
      const current = await configStore().get();
      knownRevision = current.credentialRevision;
      knownPaused = !!current.authPaused;
      const changed = current.credentialRevision !== revision;
      if (changed || (current.authPaused && !allowPaused)) {
        const error = new ApiError(changed ? '接口凭据已变化，请重新翻译。' : '接口鉴权失败，翻译已暂停；请在设置中更新密钥或测试连接。', 401, '');
        error.code = changed ? 'credentials_changed' : 'auth_paused';
        throw error;
      }
    },
    async onHttpError(status, raw) {
      if (!isKeyFailure(status, raw)) return '';
      const paused = await configStore().pause(revision);
      if (paused) {
        knownRevision = revision;
        knownPaused = true;
        return 'auth_paused';
      }
      knownRevision = '';
      return 'credentials_changed';
    },
    resume: async () => {
      const ok = await configStore().resume(revision);
      knownRevision = '';
      knownPaused = false;
      return ok;
    }
  };
}

export const authErrorCode = (error) => ['auth_paused', 'credentials_changed'].includes(error?.code) ? error.code : '';
