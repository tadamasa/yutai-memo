// 株主優待ハブ(スプレッドシート「株主優待ハブ」+ Apps Script)との自動同期。読書メモの js/sync.js と同じ考え方。
// 端末内の IndexedDB が正で、変わった行だけを POST で送り(id で upsert)、GET action=pull で rev より新しい行だけを受け取る。
// 同じ行を二つの端末(や表の直接編集)で直したときは、mtime(最後に書いた時刻)が新しい方を残す。
import * as db from './db.js';
import { ms } from './yutai.js';

const KINDS = db.SYNCED; // benefits, receipts, campaigns
const BATCH = 200; // 1回に送る件数
const empty = () => Object.fromEntries(KINDS.map(k => [k, {}]));
let dirty = empty(); // 未送信: { kind: { id: { mtime, deleted } } }
let cfg = { url: '', token: '' };
let timer = null;
let running = null;
let saveTimer = null;
let onRemoteChange = () => {};
const listeners = new Set();
export const status = { state: 'off', lastAt: null, holdingsAt: null, error: '', pending: 0 };

const count = () => KINDS.reduce((n, k) => n + Object.keys(dirty[k]).length, 0);
function emit() {
  status.pending = count();
  listeners.forEach(fn => fn(status));
}
export function onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function saveDirty() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => db.setMeta('syncDirty', dirty), 300);
}

// 未接続のあいだに書いたものも覚えておき、接続したときに送る
function mark(name, changes) {
  for (const c of changes) dirty[name][c.id] = { mtime: c.mtime || new Date().toISOString(), deleted: !!c.deleted };
  saveDirty();
  emit();
  schedule();
}

export async function initSync(opts = {}) {
  if (opts.onRemoteChange) onRemoteChange = opts.onRemoteChange;
  const [url, token, saved, lastAt, holdingsAt] = await Promise.all([
    db.getMeta('syncUrl', ''), db.getMeta('syncToken', ''), db.getMeta('syncDirty'), db.getMeta('syncLastAt'), db.getMeta('holdingsAt'),
  ]);
  cfg = { url, token };
  if (saved) dirty = Object.assign(empty(), saved);
  status.state = url ? 'idle' : 'off';
  status.lastAt = lastAt;
  status.holdingsAt = holdingsAt;
  db.onChange(mark);
  emit();
}

export function enabled() { return !!(cfg.url && cfg.token); }

// 書いてから少し待ってまとめて送る
export function schedule(delay = 4000) {
  if (!enabled()) return;
  clearTimeout(timer);
  timer = setTimeout(() => { syncNow().catch(() => {}); }, delay);
}

async function readJson(res) {
  if (!res.ok) throw new Error(`株主優待ハブ HTTP ${res.status}`);
  let data;
  try { data = await res.json(); } catch { throw new Error('株主優待ハブの応答を読めませんでした(URLが正しいか、デプロイのアクセスが「全員」か確かめてください)'); }
  if (!data.ok) throw new Error(data.error === 'unauthorized' ? '合言葉が違います' : `株主優待ハブ: ${data.error}`);
  return data;
}

async function post(body, url = cfg.url) {
  // text/plain にすると事前確認(CORS preflight)が要らず、Apps Scriptで受けられる
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' });
  return readJson(res);
}

// 読み取り専用の問い合わせ(pull / holdings / ping)。ヘッダを付けない GET なので事前確認は起きない
export async function ask(action, params = {}, { url = cfg.url, token = cfg.token } = {}) {
  const u = new URL(url);
  u.searchParams.set('action', action);
  if (action !== 'ping') u.searchParams.set('token', token);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const res = await fetch(u.toString(), { redirect: 'follow', cache: 'no-store' });
  return readJson(res);
}

function takeBatch() {
  const out = Object.fromEntries(KINDS.map(k => [k, []]));
  let n = 0;
  for (const k of KINDS) {
    for (const [id, d] of Object.entries(dirty[k])) {
      if (n >= BATCH) return out;
      out[k].push([id, d]);
      n++;
    }
  }
  return out;
}

async function apply(name, items) {
  let changed = 0;
  for (const it of items) {
    if (!it || !it.id) continue;
    const pending = dirty[name][it.id];
    if (pending && ms(pending.mtime) >= ms(it.mtime)) continue; // 手元の未送信のほうが新しい
    const local = await db.get(name, it.id);
    if (local && ms(local.mtime) > ms(it.mtime)) continue;
    if (it.deleted) { if (local) { await db.del(name, it.id, { silent: true }); changed++; } continue; }
    if (local && ms(local.mtime) === ms(it.mtime) && local.rev === it.rev) continue; // 同じもの
    const rec = Object.assign({}, it, { deleted: false });
    await db.put(name, rec, { silent: true });
    changed++;
  }
  return changed;
}

// 保有株式(ポートフォリオ)を取り直す。古いハブや一時的な失敗では、手元の一覧をそのまま使う
export async function refreshHoldings() {
  const res = await ask('holdings');
  if (!Array.isArray(res.holdings) || !res.holdings.length) return 0;
  await db.replaceAll('holdings', res.holdings.map(h => ({ code: String(h.code), name: h.name || '', shares: h.shares ?? null, price: h.price ?? null })));
  status.holdingsAt = res.at || new Date().toISOString();
  await db.setMeta('holdingsAt', status.holdingsAt);
  return res.holdings.length;
}

export function syncNow() {
  if (!enabled()) return Promise.resolve(0);
  if (running) return running;
  running = (async () => {
    status.state = 'syncing'; status.error = ''; emit();
    let changed = 0;
    try {
      // 1. 送る(id で upsert)
      for (let guard = 0; guard < 50 && count(); guard++) {
        const batch = takeBatch();
        const body = { token: cfg.token };
        for (const k of KINDS) {
          body[k] = [];
          for (const [id, d] of batch[k]) {
            const rec = d.deleted ? null : await db.get(k, id);
            body[k].push(rec ? Object.assign({}, rec, { id, mtime: rec.mtime || d.mtime, deleted: false }) : { id, mtime: d.mtime, deleted: true });
          }
        }
        await post(body);
        // 送っている間に書き直されたものは、次の回に送る
        for (const k of KINDS) for (const item of body[k]) if (dirty[k][item.id] && ms(dirty[k][item.id].mtime) <= ms(item.mtime)) delete dirty[k][item.id];
        saveDirty();
      }
      // 2. 受け取る(rev より新しい行だけ、400件ずつ)
      let cursor = Number(await db.getMeta('syncCursor', 0)) || 0;
      for (let guard = 0; guard < 100; guard++) {
        const res = await ask('pull', { since: cursor });
        for (const k of KINDS) changed += await apply(k, res[k] || []);
        cursor = res.rev;
        await db.setMeta('syncCursor', cursor);
        if (!res.more) break;
      }
      // 3. 保有株式(読むだけ)
      try { if (await refreshHoldings()) changed++; } catch (e) { console.warn('保有株式を読めませんでした', e); }
      status.lastAt = new Date().toISOString();
      await db.setMeta('syncLastAt', status.lastAt);
      status.state = 'idle';
    } catch (e) {
      status.state = 'error';
      status.error = navigator.onLine === false ? 'オフラインです' : e.message;
    } finally {
      running = null;
      emit();
    }
    if (changed) await onRemoteChange(changed);
    return changed;
  })();
  return running;
}

// 接続: ハブであることを確かめてから、手元の未送信分を送り、最初から受け取る
export async function connect(url, token) {
  const u = url.trim();
  const ping = await ask('ping', {}, { url: u });
  if (ping.app !== 'yutai-hub') throw new Error('株主優待ハブではないURLです(読書ハブなど別のハブのURLかもしれません)');
  cfg = { url: u, token: token.trim() };
  await db.setMeta('syncUrl', cfg.url);
  await db.setMeta('syncToken', cfg.token);
  await db.setMeta('syncCursor', 0);
  status.state = 'idle';
  emit();
  return syncNow();
}

export async function disconnect() {
  cfg = { url: '', token: '' };
  clearTimeout(timer);
  await Promise.all(['syncUrl', 'syncToken', 'syncCursor', 'syncLastAt'].map(k => db.setMeta(k, null)));
  status.state = 'off'; status.lastAt = null; status.error = '';
  emit();
}
