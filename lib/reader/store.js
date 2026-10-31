// 阅读器本地书库：IndexedDB。只在本机保存原书 / 元数据 / 进度 / 译文。
// 不申请 unlimitedStorage；由 reader 在导入前检查容量上限。
const DB_NAME = 'rimefox-reader';
const DB_VERSION = 3;
const STORES = ['books', 'translations', 'failures', 'settings'];

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('IndexedDB is not available')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('translations')) {
        const store = db.createObjectStore('translations', { keyPath: 'key' });
        store.createIndex('bookId', 'bookId', { unique: false });
      }
      if (!db.objectStoreNames.contains('failures')) {
        const store = db.createObjectStore('failures', { keyPath: 'key' });
        store.createIndex('bookId', 'bookId', { unique: false });
      }
      if (!db.objectStoreNames.contains('progress')) db.createObjectStore('progress', { keyPath: 'bookId' });
      if (!db.objectStoreNames.contains('fonts')) db.createObjectStore('fonts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
  return dbPromise;
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const target = transaction.objectStore(store);
    let result;
    try { result = fn(target); } catch (err) { reject(err); return; }
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

function requestPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

export async function sha256(buffer) {
  if (!globalThis.crypto || !globalThis.crypto.subtle) throw new Error('WebCrypto is not available');
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest)).map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function listBooks() {
  const db = await openDb();
  const rows = await requestPromise(db.transaction('books', 'readonly').objectStore('books').getAll());
  const progress = await requestPromise(db.transaction('progress', 'readonly').objectStore('progress').getAll());
  const byId = new Map((progress || []).map((one) => [one.bookId, one]));
  return (rows || []).map((book) => {
    const p = byId.get(book.id);
    return p ? Object.assign({}, book, { progress: { sectionId: p.sectionId, offsetRatio: p.offsetRatio } }) : book;
  }).sort((a, b) => (b.lastOpenedAt || b.createdAt || 0) - (a.lastOpenedAt || a.createdAt || 0));
}

export async function getBook(id) {
  const db = await openDb();
  const book = await requestPromise(db.transaction('books', 'readonly').objectStore('books').get(id));
  if (!book) return book;
  const progress = await requestPromise(db.transaction('progress', 'readonly').objectStore('progress').get(id));
  return progress ? Object.assign({}, book, { progress: { sectionId: progress.sectionId, offsetRatio: progress.offsetRatio } }) : book;
}

export async function saveBook(book) {
  const db = await openDb();
  await tx(db, 'books', 'readwrite', (store) => store.put(book));
  return book;
}

export async function updateBook(id, patch) {
  const book = await getBook(id);
  if (!book) return null;
  const next = Object.assign({}, book, patch);
  await saveBook(next);
  return next;
}

export async function deleteBook(id) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(['books', 'translations', 'failures', 'progress'], 'readwrite');
    transaction.objectStore('books').delete(id);
    transaction.objectStore('progress').delete(id);
    const trans = transaction.objectStore('translations').index('bookId');
    const fail = transaction.objectStore('failures').index('bookId');
    const req1 = trans.openKeyCursor(IDBKeyRange.only(id));
    req1.onsuccess = () => {
      const cursor = req1.result;
      if (!cursor) return;
      transaction.objectStore('translations').delete(cursor.primaryKey);
      cursor.continue();
    };
    const req2 = fail.openKeyCursor(IDBKeyRange.only(id));
    req2.onsuccess = () => {
      const cursor = req2.result;
      if (!cursor) return;
      transaction.objectStore('failures').delete(cursor.primaryKey);
      cursor.continue();
    };
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('delete failed'));
    transaction.onabort = () => reject(transaction.error || new Error('delete aborted'));
  });
}

export async function deleteBookTranslations(id) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('translations', 'readwrite');
    const cursorReq = transaction.objectStore('translations').index('bookId').openKeyCursor(IDBKeyRange.only(id));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      transaction.objectStore('translations').delete(cursor.primaryKey);
      cursor.continue();
    };
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('delete translations failed'));
    transaction.onabort = () => reject(transaction.error || new Error('delete translations aborted'));
  });
}

export async function saveProgress(id, progress) {
  const db = await openDb();
  await tx(db, 'progress', 'readwrite', (store) => store.put({
    bookId: id,
    sectionId: progress && progress.sectionId || '',
    offsetRatio: progress && Number(progress.offsetRatio) || 0,
    updatedAt: Date.now()
  }));
  return progress;
}

export async function getTranslation(key) {
  const db = await openDb();
  return requestPromise(db.transaction('translations', 'readonly').objectStore('translations').get(key));
}

export async function putTranslation(record) {
  const db = await openDb();
  await tx(db, 'translations', 'readwrite', (store) => store.put(record));
  return record;
}

export async function putFailure(record) {
  const db = await openDb();
  await tx(db, 'failures', 'readwrite', (store) => store.put(record));
  return record;
}

export async function getFailure(key) {
  const db = await openDb();
  return requestPromise(db.transaction('failures', 'readonly').objectStore('failures').get(key));
}

export async function getReaderSettings() {
  const db = await openDb();
  const row = await requestPromise(db.transaction('settings', 'readonly').objectStore('settings').get('reader'));
  return row || { id: 'reader', fontFamily: 'serif', fontSize: 18, lineHeight: 1.75, measure: 720, letterSpacing: 0, paragraphSpacing: 1.05, theme: 'auto' };
}

export async function saveReaderSettings(next) {
  const db = await openDb();
  const row = Object.assign({ id: 'reader' }, next);
  await tx(db, 'settings', 'readwrite', (store) => store.put(row));
  return row;
}

export async function getUserFont() {
  const db = await openDb();
  return requestPromise(db.transaction('fonts', 'readonly').objectStore('fonts').get('user'));
}

export async function saveUserFont(record) {
  const db = await openDb();
  await tx(db, 'fonts', 'readwrite', (store) => store.put(Object.assign({ id: 'user' }, record)));
  return record;
}

export async function deleteUserFont() {
  const db = await openDb();
  await tx(db, 'fonts', 'readwrite', (store) => store.delete('user'));
}

export async function requestPersistence() {
  try {
    if (navigator.storage && typeof navigator.storage.persist === 'function') return await navigator.storage.persist();
  } catch (err) { /* best effort */ }
  return false;
}

export async function estimateUsage() {
  if (navigator.storage && navigator.storage.estimate) {
    try { return await navigator.storage.estimate(); } catch (err) { /* ignore */ }
  }
  return { usage: 0, quota: 0 };
}

export const READER_LIMITS = Object.freeze({
  maxBookBytes: 100 * 1024 * 1024,
  maxLibraryBytes: 500 * 1024 * 1024
});
