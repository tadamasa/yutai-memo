/**
 * 株主優待ハブ: 株主優待メモアプリ(https://tadamasa.github.io/yutai-memo/)の優待・受取・特典を、
 * スプレッドシート「株主優待ハブ」に同期する受け口。読書メモの読書ハブと同じ考え方で作っている。
 *
 * 使い方は hub/README.md を参照。
 *  1. 株主優待ハブのスプレッドシート → 拡張機能 → Apps Script に、このファイルを貼る
 *  2. setup を一度実行(合言葉が実行ログに出る)
 *  3. デプロイ → 新しいデプロイ → ウェブアプリ(実行ユーザー: 自分、アクセス: 全員)
 *  4. 出たURLと合言葉を、株主優待メモアプリの設定に入れる
 *
 * 読書ハブとの違い: 表そのものが正(json 列はない)。人やほかのAIが表を直接書き換えても、
 * 次の同期のときに行ごとの指紋(_sync シート)と比べて見つけ、新しい rev を振ってアプリへ流す。
 *
 * 口(すべて ContentService の JSON を返す)
 *   GET  ?action=ping                         → { ok, app: 'yutai-hub' }(合言葉なし)
 *   GET  ?action=pull&since=<rev>&token=…     → { ok, rev, more, benefits:[…], receipts:[…], campaigns:[…] }
 *   GET  ?action=holdings&token=…             → { ok, at, holdings:[{ code, name, shares, price }] }(ポートフォリオを読むだけ)
 *   POST 本文 { token, benefits:[…], receipts:[…], campaigns:[…] } → { ok, rev, saved, skipped, current }
 *        current は skipped になった行の表の今の中身({ benefits:[…], … })。端末はこれで手元を表に合わせる。
 *        各要素は表の列名をキーにした行。id で upsert。mtime が表と同じか古いものは捨てる。deleted:true は墓標。
 */

const COLS = {
  benefits: ['id', 'code', 'company_name', 'has_benefit', 'benefit_category', 'benefit_detail', 'tiers', 'record_dates', 'arrival_timing', 'validity_note', 'official_url', 'checked_at', 'benefit_status', 'memo', 'rev', 'mtime', 'deleted'],
  receipts: ['id', 'code', 'company_name', 'benefit_name', 'fiscal_year', 'received_at', 'expires_at', 'status', 'used_at', 'memo', 'rev', 'mtime', 'deleted'],
  campaigns: ['id', 'code', 'company_name', 'title', 'deadline', 'conditions', 'apply_route', 'apply_url', 'status', 'memo', 'rev', 'mtime', 'deleted'],
};
const KINDS = ['benefits', 'receipts', 'campaigns'];
const ID_PREFIX = { benefits: 'ben', receipts: 'rcp', campaigns: 'camp' };
const META = ['rev', 'mtime', 'deleted']; // 指紋に入れない列(deleted は入れる)
const LEDGER = '_sync';
const LEDGER_COLS = ['kind', 'id', 'rev', 'hash', 'gone'];
const PAGE = 400; // 1回の応答で返す最大件数

// 保有株式の正本(読むだけ)。スクリプト プロパティ PORTFOLIO_ID で上書きできる
const PORTFOLIO_ID = '15s_YBYsSbCHmGRGO8ZjP_9SdS_hqQqBmhjBJP9D4fsk';
const PORTFOLIO_SHEET = '保有株式';
const PORTFOLIO_FIRST_ROW = 4; // 見出しは3行目
const CODE_RE = /^[0-9][0-9A-Z]{3}$/; // 4桁の証券コード(130A のような英字入りも)

function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN')) props.setProperty('TOKEN', Utilities.getUuid().replace(/-/g, ''));
  withLock_(() => reconcileAll_());
  Logger.log('合言葉: ' + props.getProperty('TOKEN'));
}

// さくら(Muse)専用の合言葉。端末用(TOKEN)とは別物で、SAKURA_TOKEN を消せばさくらだけ止められる。
// さくら用の合言葉では、追加と更新はできるが、削除は受け付けない。
function setupSakura() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SAKURA_TOKEN')) props.setProperty('SAKURA_TOKEN', Utilities.getUuid().replace(/-/g, ''));
  Logger.log('さくら用合言葉: ' + props.getProperty('SAKURA_TOKEN'));
}

// ---------- 入口 ----------

function doGet(e) {
  const p = (e && e.parameter) || {};
  const action = p.action || 'ping';
  if (action === 'ping') return json_({ ok: true, app: 'yutai-hub' });
  const who = auth_(p.token);
  if (!who) return json_({ ok: false, error: 'unauthorized' });
  if (action === 'pull') return json_(withLock_(() => pull_(Number(p.since || 0))));
  if (action === 'holdings') return json_(holdings_());
  return json_({ ok: false, error: 'unknown action' });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad json' }); }
  if (!req || typeof req !== 'object' || Array.isArray(req)) return json_({ ok: false, error: 'bad json' });
  // 合言葉は本文の token でも、URLのパラメータ(?token=)でも受け付ける
  const who = auth_(req.token || (e.parameter && e.parameter.token) || '');
  if (!who) return json_({ ok: false, error: 'unauthorized' });
  return json_(withLock_(() => upsert_(req, who === 'sakura')));
}

// 'device' | 'sakura' | ''
function auth_(given) {
  if (!given) return '';
  const props = PropertiesService.getScriptProperties();
  if (given === props.getProperty('TOKEN')) return 'device';
  if (given === props.getProperty('SAKURA_TOKEN')) return 'sakura';
  return '';
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ---------- 書き込み(upsert) ----------

function upsert_(req, isSakura) {
  const st = reconcileAll_(); // 先に、表で直接直された行に rev を振っておく
  const out = { ok: true, saved: 0, skipped: [], current: { benefits: [], receipts: [], campaigns: [] } };
  for (const kind of KINDS) {
    const t = st.tables[kind];
    let changed = false;
    for (const item of req[kind] || []) {
      if (!item || !item.id) continue;
      const id = String(item.id);
      const del = isDeleted_(item.deleted);
      if (isSakura && del) { out.skipped.push(id); continue; } // さくら用合言葉では削除を受け付けない
      const mtime = mtimeText_(item.mtime);
      const i = t.index[id];
      if (i !== undefined && ms_(t.rows[i].mtime) >= ms_(mtime)) {
        // 表のほうが新しい(か同じ)。端末の cursor がこの行の rev を越えていると pull では戻らないので、表の今の中身を返す
        out.skipped.push(id);
        out.current[kind].push(record_(kind, t.rows[i]));
        continue;
      }
      const row = i === undefined ? blank_(kind) : t.rows[i];
      if (!del) for (const c of COLS[kind]) if (META.indexOf(c) < 0 && c in item) row[c] = text_(item[c]);
      row.id = id;
      row.rev = String(++st.rev);
      row.mtime = mtime;
      row.deleted = del ? '1' : '0';
      if (i === undefined) { t.index[id] = t.rows.length; t.rows.push(row); }
      st.ledger.put(kind, id, Number(row.rev), hash_(kind, row), false);
      changed = true;
      out.saved++;
    }
    if (changed) writeTable_(t);
  }
  st.ledger.write();
  setRev_(st.rev);
  out.rev = st.rev;
  return out;
}

// ---------- 読み出し(pull) ----------

function pull_(since) {
  const st = reconcileAll_();
  const fresh = [];
  for (const kind of KINDS) {
    for (const r of st.tables[kind].rows) if (Number(r.rev) > since) fresh.push({ kind, rev: Number(r.rev), rec: record_(kind, r) });
    // 表から行ごと消された分は削除として流す
    for (const g of st.ledger.gone(kind)) if (g.rev > since) fresh.push({ kind, rev: g.rev, rec: { id: g.id, rev: g.rev, mtime: g.mtime, deleted: true } });
  }
  fresh.sort((x, y) => x.rev - y.rev);
  const page = fresh.slice(0, PAGE);
  const more = fresh.length > PAGE;
  const out = { ok: true, rev: more ? page[page.length - 1].rev : st.rev, more, benefits: [], receipts: [], campaigns: [] };
  for (const f of page) out[f.kind].push(f.rec);
  return out;
}

function record_(kind, r) {
  const o = {};
  for (const c of COLS[kind]) o[c] = r[c] === undefined ? '' : r[c];
  o.rev = Number(r.rev);
  o.deleted = isDeleted_(r.deleted);
  return o;
}

// ---------- 保有株式(ポートフォリオを読むだけ) ----------

function holdings_() {
  const id = PropertiesService.getScriptProperties().getProperty('PORTFOLIO_ID') || PORTFOLIO_ID;
  let sh;
  try { sh = SpreadsheetApp.openById(id).getSheetByName(PORTFOLIO_SHEET); } catch (err) { return { ok: false, error: 'portfolio: ' + err.message }; }
  if (!sh) return { ok: false, error: 'portfolio: シート「' + PORTFOLIO_SHEET + '」がありません' };
  const last = sh.getLastRow();
  const list = [];
  if (last >= PORTFOLIO_FIRST_ROW) {
    const values = sh.getRange(PORTFOLIO_FIRST_ROW, 1, last - PORTFOLIO_FIRST_ROW + 1, 6).getDisplayValues();
    for (const r of values) {
      const code = String(r[0]).trim().toUpperCase();
      if (!CODE_RE.test(code)) continue; // 空行やメモの行(貸株入金などのリンク)は飛ばす
      list.push({ code, name: String(r[1]).trim(), shares: num_(r[3]), price: num_(r[5]) });
    }
  }
  return { ok: true, at: new Date().toISOString(), holdings: list };
}

function num_(s) {
  const n = Number(String(s).replace(/[,，\s円]/g, ''));
  return isFinite(n) && String(s).trim() !== '' ? n : null;
}

// ---------- 表と台帳 ----------

// 3つの表を読み、表で直接直された行・id のない行・消された行を見つけて rev を振る
function reconcileAll_() {
  const ledger = ledger_();
  let rev = getRev_(ledger);
  const tables = {};
  const now = new Date().toISOString();
  for (const kind of KINDS) {
    const t = readTable_(kind);
    let changed = false;
    const seen = {};
    for (const r of t.rows) {
      if (!r.id) {
        if (!COLS[kind].some(c => META.indexOf(c) < 0 && c !== 'id' && r[c])) continue; // まったくの空行
        r.id = newId_(kind, r.code);
        t.index[r.id] = t.rows.indexOf(r);
        changed = true;
      }
      seen[r.id] = true;
      const h = hash_(kind, r);
      const led = ledger.get(kind, r.id);
      if (!led || led.gone) {
        // 初めて見る行。最初から入っていた行(rev あり)はその rev を使う
        const known = Number(r.rev) > 0 && !led;
        if (!known) { r.rev = String(++rev); if (!r.mtime) r.mtime = now; changed = true; }
        if (!r.deleted) { r.deleted = '0'; changed = true; }
        ledger.put(kind, r.id, Number(r.rev), hash_(kind, r), false);
      } else if (led.hash !== h) {
        // 表で直接直された行
        r.rev = String(++rev);
        r.mtime = now;
        ledger.put(kind, r.id, rev, h, false);
        changed = true;
      }
    }
    for (const led of ledger.list(kind)) {
      if (!seen[led.id] && !led.gone) ledger.put(kind, led.id, ++rev, led.hash, true, now);
    }
    if (changed) writeTable_(t);
    tables[kind] = t;
  }
  ledger.write();
  setRev_(rev);
  return { tables, ledger, rev };
}

function readTable_(kind) {
  const cols = COLS[kind];
  const sh = sheet_(kind, cols);
  const width = Math.max(sh.getLastColumn(), cols.length);
  const head = sh.getRange(1, 1, 1, width).getDisplayValues()[0].map(h => String(h).trim());
  // 見出しが足りなければ後ろに足す(列の順番は人が並べ替えてもよい)
  const missing = cols.filter(c => head.indexOf(c) < 0);
  if (missing.length) {
    let at = head.filter(String).length;
    if (sh.getMaxColumns() < at + missing.length) sh.insertColumnsAfter(sh.getMaxColumns(), at + missing.length - sh.getMaxColumns());
    sh.getRange(1, at + 1, sh.getMaxRows(), missing.length).setNumberFormat('@');
    sh.getRange(1, at + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    missing.forEach(c => { head[at++] = c; });
  }
  const pos = {};
  head.forEach((h, i) => { if (h && pos[h] === undefined) pos[h] = i; });
  const last = sh.getLastRow();
  const values = last > 1 ? sh.getRange(2, 1, last - 1, head.length).getDisplayValues() : [];
  const rows = [];
  const index = {};
  values.forEach(v => {
    const r = {};
    for (const c of cols) r[c] = String(v[pos[c]] === undefined ? '' : v[pos[c]]).trim();
    if (r.id) index[r.id] = rows.length;
    rows.push(r);
  });
  return { kind, sh, head, pos, rows, index, width: head.length };
}

function writeTable_(t) {
  const n = t.rows.length;
  if (!n) return;
  const need = n + 1 - t.sh.getMaxRows();
  if (need > 0) t.sh.insertRowsAfter(t.sh.getMaxRows(), need);
  // 列ごとに書く(人が足した列や数式には触れない)。日付やコードが勝手に変換されないよう、書式なしテキストにする
  for (const c of COLS[t.kind]) {
    const col = t.rows.map(r => [r[c] === undefined ? '' : r[c]]);
    t.sh.getRange(2, t.pos[c] + 1, n, 1).setNumberFormat('@').setValues(col);
  }
}

function sheet_(name, cols) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

// 台帳: どの行にどの rev を振ったか、そのときの行の指紋。表から消された行(gone)も覚えておく
function ledger_() {
  const sh = sheet_(LEDGER, LEDGER_COLS);
  const last = sh.getLastRow();
  const rows = last > 1 ? sh.getRange(2, 1, last - 1, LEDGER_COLS.length).getDisplayValues() : [];
  const map = {};
  rows.forEach(r => { if (r[1]) map[r[0] + '\t' + r[1]] = { kind: r[0], id: r[1], rev: Number(r[2]) || 0, hash: r[3], gone: String(r[4]) !== '' && String(r[4]) !== '0', mtime: String(r[4]) }; });
  let dirty = false;
  return {
    get: (kind, id) => map[kind + '\t' + id] || null,
    put: (kind, id, rev, hash, gone, at) => {
      const k = kind + '\t' + id;
      const cur = map[k];
      if (cur && cur.rev === rev && cur.hash === hash && cur.gone === gone) return;
      map[k] = { kind, id, rev, hash, gone, mtime: gone ? (at || new Date().toISOString()) : '' };
      dirty = true;
    },
    list: kind => Object.keys(map).map(k => map[k]).filter(x => x.kind === kind),
    gone: kind => Object.keys(map).map(k => map[k]).filter(x => x.kind === kind && x.gone),
    maxRev: () => Object.keys(map).reduce((m, k) => Math.max(m, map[k].rev), 0),
    write: () => {
      if (!dirty) return;
      const out = Object.keys(map).map(k => map[k]).map(x => [x.kind, x.id, String(x.rev), x.hash, x.gone ? x.mtime : '']);
      const need = out.length + 1 - sh.getMaxRows();
      if (need > 0) sh.insertRowsAfter(sh.getMaxRows(), need);
      if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, LEDGER_COLS.length).clearContent();
      if (out.length) sh.getRange(2, 1, out.length, LEDGER_COLS.length).setNumberFormat('@').setValues(out);
      dirty = false;
    },
  };
}

function getRev_(ledger) {
  const v = PropertiesService.getScriptProperties().getProperty('REV');
  if (v !== null && v !== undefined && v !== '') return Math.max(Number(v), ledger.maxRev());
  // 初回: 表に入っている rev の最大から始める
  let m = ledger.maxRev();
  for (const kind of KINDS) {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(kind);
    if (!sh || sh.getLastRow() < 2) continue;
    const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
    const j = head.indexOf('rev');
    if (j < 0) continue;
    sh.getRange(2, j + 1, sh.getLastRow() - 1, 1).getDisplayValues().forEach(r => { m = Math.max(m, Number(r[0]) || 0); });
  }
  return m;
}

function setRev_(rev) { PropertiesService.getScriptProperties().setProperty('REV', String(rev)); }

// ---------- 小さな道具 ----------

function blank_(kind) { const r = {}; for (const c of COLS[kind]) r[c] = ''; return r; }

function newId_(kind, code) {
  return ID_PREFIX[kind] + '-' + (code ? String(code) + '-' : '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 行の指紋(rev と mtime は含めない)。人が書き換えたかどうかを見分けるためだけに使う
function hash_(kind, r) {
  let s = '';
  for (const c of COLS[kind]) if (c !== 'rev' && c !== 'mtime') s += c + '=' + (c === 'deleted' ? (isDeleted_(r[c]) ? '1' : '0') : String(r[c] === undefined ? '' : r[c])) + '\u0001';
  let h1 = 0x811c9dc5, h2 = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
    h2 = (Math.imul(h2, 31) + ch) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}

function isDeleted_(v) { return v === true || v === 1 || /^(1|true)$/i.test(String(v === undefined || v === null ? '' : v).trim()); }

// mtime は ISO 8601 の文字(2026-11-13T09:30:00.000Z)。最初の投入分は日付だけ(2026-11-13)で、その日の0時(UTC)とみなす
function ms_(v) {
  if (v === '' || v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (/^\d{11,}$/.test(s)) return Number(s);
  const t = Date.parse(s.replace(/\//g, '-'));
  return isFinite(t) ? t : 0;
}

function mtimeText_(v) {
  if (typeof v === 'number' || /^\d{11,}$/.test(String(v))) return new Date(Number(v)).toISOString();
  return v ? String(v) : new Date().toISOString();
}

function text_(v) { return v === null || v === undefined ? '' : String(v); }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
