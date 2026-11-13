// 画面に触れない計算(日付・結合・絞り込み・並べ方)。node --test で確かめる。

export const SOON_DAYS = 30; // 使用期限・応募期限を「近い」とみなす日数

const pad = n => String(n).padStart(2, '0');

// 端末の時刻での YYYY-MM-DD
export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 'YYYY-MM-DD'(または 'YYYY/M/D')を、その日の0時(端末の時刻)の通し日数にする。読めなければ null
export function dayNumber(s) {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(String(s || '').trim());
  if (!m) return null;
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5);
}

// today から date までの日数(今日=0、昨日=-1)。日付がなければ null
export function daysUntil(date, today = todayStr()) {
  const a = dayNumber(date);
  const b = dayNumber(today);
  return a === null || b === null ? null : a - b;
}

// mtime(ISO 8601 の文字か、日付だけ、ミリ秒の数)を比べられる数にする
export function ms(v) {
  if (v === '' || v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (/^\d{11,}$/.test(s)) return Number(s);
  const t = Date.parse(s.replace(/\//g, '-'));
  return Number.isFinite(t) ? t : 0;
}

export function isDeleted(v) {
  return v === true || v === 1 || /^(1|true)$/i.test(String(v ?? '').trim());
}

export function newId(prefix, code = '') {
  return `${prefix}-${code ? `${code}-` : ''}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function norm(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

// ---------- 優待 ----------

// 「3月末・9月末」「3,9月」「毎年3月31日」「2027-03-31」などから権利確定月(1〜12)を取り出す
export function recordMonths(text) {
  const s = String(text || '').normalize('NFKC');
  const out = new Set();
  for (const m of s.matchAll(/\d{4}[-/.](\d{1,2})[-/.]\d{1,2}/g)) out.add(+m[1]);
  const rest = s.replace(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/g, ' ');
  // 「3・9月」「3,9月末」のように月がまとめて書かれたものも拾う
  for (const m of rest.matchAll(/((?:\d{1,2}\s*[,、・/&と]\s*)*\d{1,2})\s*月/g)) {
    for (const n of m[1].split(/[,、・/&と\s]+/)) if (+n >= 1 && +n <= 12) out.add(+n);
  }
  return [...out].sort((a, b) => a - b);
}

// 保有株式と優待マスタを証券コードで結合する。どちらか片方にしかない銘柄も出す
export function joinHoldings(holdings, benefits) {
  const map = new Map();
  for (const h of holdings || []) {
    map.set(h.code, { code: h.code, name: h.name, shares: h.shares ?? null, held: true, benefit: null });
  }
  for (const b of benefits || []) {
    if (!b || isDeleted(b.deleted)) continue;
    const row = map.get(b.code);
    if (row) { row.benefit = b; if (!row.name) row.name = b.company_name; } else map.set(b.code, { code: b.code, name: b.company_name, shares: null, held: false, benefit: b });
  }
  return [...map.values()];
}

export function hasOf(row) {
  const v = row.benefit && row.benefit.has_benefit;
  return v === 'あり' || v === 'なし' ? v : '要確認';
}

// 検索と絞り込み。has: '' | 'あり' | 'なし' | '要確認'、month: 0 か 1〜12
export function filterHoldings(rows, { q = '', has = '', month = 0, heldOnly = false } = {}) {
  const words = norm(q) ? String(q).normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean).map(norm) : [];
  return rows.filter(r => {
    if (heldOnly && !r.held) return false;
    if (has && hasOf(r) !== has) return false;
    const b = r.benefit || {};
    if (month && !recordMonths(b.record_dates).includes(month)) return false;
    if (!words.length) return true;
    const hay = norm([r.code, r.name, b.benefit_category, b.benefit_detail, b.tiers, b.memo, b.benefit_status].join(' '));
    return words.every(w => hay.includes(w));
  });
}

export const SORTS = {
  code: (a, b) => a.code.localeCompare(b.code),
  name: (a, b) => (a.name || '').localeCompare(b.name || '', 'ja'),
  // 次に来る権利確定月が近い順(確定月が分からないものは後ろ)
  record: (a, b, month = new Date().getMonth() + 1) => nextMonthGap(a, month) - nextMonthGap(b, month) || a.code.localeCompare(b.code),
};

function nextMonthGap(row, month) {
  const ms = recordMonths(row.benefit && row.benefit.record_dates);
  if (!ms.length) return 99;
  return Math.min(...ms.map(m => (m - month + 12) % 12));
}

// 12か月の暦: 月ごとに権利確定する銘柄の数
export function monthCounts(rows) {
  const out = Array(13).fill(0);
  for (const r of rows) for (const m of recordMonths(r.benefit && r.benefit.record_dates)) out[m]++;
  return out;
}

// ---------- 受取・使用 ----------

export const USED = new Set(['使用済', '失効']);

// 'used' | 'expired' | 'soon' | 'later' | 'none'
export function expiryLevel(r, today = todayStr()) {
  if (USED.has(r.status)) return 'used';
  const d = daysUntil(r.expires_at, today);
  if (d === null) return 'none';
  if (d < 0) return 'expired';
  if (d <= SOON_DAYS) return 'soon';
  return 'later';
}

// 使いきっていないものを期限の近い順に。期限のないものはその後、使い終えたものは最後(新しい順)
export function sortReceipts(list, today = todayStr()) {
  const rank = { expired: 0, soon: 0, later: 0, none: 1, used: 2 };
  return list.filter(r => !isDeleted(r.deleted)).slice().sort((a, b) => {
    const la = expiryLevel(a, today), lb = expiryLevel(b, today);
    if (rank[la] !== rank[lb]) return rank[la] - rank[lb];
    if (la === 'used') return String(b.used_at || b.expires_at || '').localeCompare(String(a.used_at || a.expires_at || ''));
    if (rank[la] === 0) return (dayNumber(a.expires_at) - dayNumber(b.expires_at)) || (a.company_name || '').localeCompare(b.company_name || '', 'ja');
    return String(b.received_at || '').localeCompare(String(a.received_at || ''));
  });
}

// ---------- 特典・キャンペーン ----------

export const CLOSED = new Set(['応募済', '当選', '落選', '見送り', '対象外']);

// { days, closed, level }  level: 'over' | 'today' | 'soon' | 'later' | 'none' | 'done'
export function campaignState(c, today = todayStr()) {
  const days = daysUntil(c.deadline, today);
  const done = CLOSED.has(c.status);
  let level = days === null ? 'none' : days < 0 ? 'over' : days === 0 ? 'today' : days <= 7 ? 'soon' : 'later';
  if (done) level = 'done';
  return { days, closed: done || (days !== null && days < 0), level };
}

// まだ動ける特典を期限の近い順に、そのあと終わったもの(期限の新しい順)
export function sortCampaigns(list, today = todayStr()) {
  return list.filter(c => !isDeleted(c.deleted)).slice().sort((a, b) => {
    const sa = campaignState(a, today), sb = campaignState(b, today);
    if (sa.closed !== sb.closed) return sa.closed ? 1 : -1;
    const da = sa.days ?? 9999, dbb = sb.days ?? 9999;
    return sa.closed ? dbb - da : da - dbb;
  });
}
