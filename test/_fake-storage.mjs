// 假的 chrome.storage 区域（三个 pipeline 测试共用）
//
// 之前每个测试文件各抄一份，行为已经悄悄不同：有的按值深拷贝（防止被测代码原地改坏夹具），
// 有的在 object 形式 get 时返回默认值。这里用选项把差异显式化，避免"抄的时候抄错一版"。
//
// - clone:        set / get 时做 JSON 深拷贝（默认 false）
// - withDefaults: get({ a: 1 }) 对缺失键返回默认值（默认 false，和 Chrome 一致）
// - exposeData:   把内部 Map 暴露成 .data，方便测试断言（默认 true）
export function makeArea({ clone = false, withDefaults = false, exposeData = true } = {}) {
  const data = new Map();
  const copy = (value) => (clone ? JSON.parse(JSON.stringify(value)) : value);
  const area = {
    async get(keys) {
      if (keys == null) return Object.fromEntries(data);
      if (typeof keys === 'string') return data.has(keys) ? { [keys]: copy(data.get(keys)) } : {};
      if (Array.isArray(keys)) {
        const out = {};
        keys.forEach((k) => {
          if (data.has(k)) out[k] = copy(data.get(k));
        });
        return out;
      }
      if (!withDefaults) return {};
      const out = {};
      Object.keys(keys).forEach((k) => {
        out[k] = data.has(k) ? copy(data.get(k)) : keys[k];
      });
      return out;
    },
    async set(obj) {
      Object.keys(obj || {}).forEach((k) => data.set(k, copy(obj[k])));
    },
    async remove(keys) {
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => data.delete(k));
    },
    async setAccessLevel() {
      return Promise.resolve();
    },
    async getBytesInUse() {
      return 0;
    }
  };
  if (exposeData) area.data = data;
  return area;
}
