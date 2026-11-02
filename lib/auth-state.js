import { configStore } from './config-storage.js';
import { ApiError } from './engines/errors.js';

export function isKeyFailure(status, raw = '') {
  return status === 401 || ([400, 403].includes(status) && /(?:invalid|incorrect|expired|revoked)[_ -]?(?:x[_ -]?)?(?:api[_ -]?)?key|authentication_error|api[_ -]?key[_ -]?(?:is[_ -]?)?(?:not[_ -]?valid|invalid|expired|revoked)/i.test(raw));
}

export function authGuard(snapshot, { allowPaused = false } = {}) {
  const revision = snapshot.credentialRevision;
  return {
    async beforeSend() {
      const current = await configStore().get();
      const changed = current.credentialRevision !== revision;
      if (changed || (current.authPaused && !allowPaused)) {
        const error = new ApiError(changed ? '接口凭据已变化，请重新翻译。' : '接口鉴权失败，翻译已暂停；请在设置中更新密钥或测试连接。', 401, '');
        error.code = changed ? 'credentials_changed' : 'auth_paused';
        throw error;
      }
    },
    async onHttpError(status, raw) {
      if (!isKeyFailure(status, raw)) return '';
      return await configStore().pause(revision) ? 'auth_paused' : 'credentials_changed';
    },
    resume: () => configStore().resume(revision)
  };
}

export const authErrorCode = (error) => ['auth_paused', 'credentials_changed'].includes(error?.code) ? error.code : '';
