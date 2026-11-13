// IndexedDB の薄いラッパー。外部ライブラリなしで動かす(読書メモの js/db.js と同じ形)。
const DB_NAME = 'yutai-memo';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ['benefits', 'receipts', 'campaigns']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' }).createIndex('code', 'code');
      }
      // 保有株式はハブ(ポートフォリオ)から読むだけ。同期では送らない
      if (!db.objectStoreNames.contains('holdings')) db.createObjectStore('holdings', { keyPath: 'code' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export async function getAll(name) {
  return wrap((await store(name)).getAll());
}

export async function get(name, id) {
  return wrap((await store(name)).get(id));
}

// 同期のために、優待・受取・特典の書き込みを知らせる。mtime は同期で新旧を比べる時刻(ISO 8601の文字)。
// 同期で受け取ったデータや初期データを書くときは { silent: true } にして、送り返さないようにする。
export const SYNCED = ['benefits', 'receipts', 'campaigns'];
let changeHook = null;
export function onChange(fn) { changeHook = fn; }
function touch(name, values, silent) {
  if (silent || !SYNCED.includes(name)) return;
  const now = new Date().toISOString();
  for (const v of values) { v.mtime = now; v.deleted = false; }
}
function notify(name, changes, silent) {
  if (!silent && changeHook && SYNCED.includes(name) && changes.length) changeHook(name, changes);
}

export async function put(name, value, { silent = false } = {}) {
  touch(name, [value], silent);
  const r = await wrap((await store(name, 'readwrite')).put(value));
  notify(name, [{ id: value.id, mtime: value.mtime }], silent);
  return r;
}

export async function del(name, id, { silent = false } = {}) {
  const r = await wrap((await store(name, 'readwrite')).delete(id));
  notify(name, [{ id, mtime: new Date().toISOString(), deleted: true }], silent);
  return r;
}

// mtime を変えずに「未送信」にだけ載せる(バックアップの読み込みなど)
export function markDirty(name, values) {
  if (changeHook && SYNCED.includes(name) && values.length) changeHook(name, values.map(v => ({ id: v.id, mtime: v.mtime })));
}

export async function putMany(name, values, { silent = false } = {}) {
  touch(name, values, silent);
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite');
    const s = tx.objectStore(name);
    for (const v of values) s.put(v);
    tx.oncomplete = () => { notify(name, values.map(v => ({ id: v.id, mtime: v.mtime })), silent); resolve(values.length); };
    tx.onerror = () => reject(tx.error);
  });
}

// 中身を入れ替える(保有株式の更新に使う)
export async function replaceAll(name, values) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite');
    const s = tx.objectStore(name);
    s.clear();
    for (const v of values) s.put(v);
    tx.oncomplete = () => resolve(values.length);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getMeta(key, fallback = null) {
  const row = await get('meta', key);
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  return put('meta', { key, value });
}

// ブラウザにデータを消されにくくする(ホーム画面に追加したPWAでは許可されやすい)
export async function requestPersist() {
  if (navigator.storage && navigator.storage.persist) {
    try { return await navigator.storage.persist(); } catch { return false; }
  }
  return false;
}
