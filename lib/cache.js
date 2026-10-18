// 极简 LRU：同一段文本在同语言下只翻一次（切页/后退/重翻都能命中）
const MAX_ENTRIES = 4000;
const store = new Map();

export function makeKey(targetLang, text) {
  return targetLang + '\u0000' + text;
}

export function get(key) {
  if (!store.has(key)) return undefined;
  const value = store.get(key);
  store.delete(key);
  store.set(key, value);
  return value;
}

export function set(key, value) {
  if (store.has(key)) store.delete(key);
  store.set(key, value);
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
}

export function clear() {
  store.clear();
}

export function size() {
  return store.size;
}
