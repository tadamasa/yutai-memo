import * as db from './db.js';
import * as sync from './sync.js';
import * as W from './words.js';
import {
  todayStr, daysUntil, recordMonths, joinHoldings, filterHoldings, hasOf, SORTS, monthCounts,
  expiryLevel, sortReceipts, campaignState, sortCampaigns, newId, isDeleted, SOON_DAYS,
} from './yutai.js';
import { exportData, importData } from './backup.js';

// ---------- 状態 ----------
const state = { holdings: [], benefits: [], receipts: [], campaigns: [] };
// 優待一覧の絞り込み(端末ごとの好み。同期しない)
const view = { q: '', has: '', month: 0, sort: 'code', receipts: 'open' };

const $view = document.getElementById('view');
const $action = document.getElementById('nav-action');

// ---------- ユーティリティ ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 外部のURLは http(s) だけをリンクにする
function safeUrl(u) {
  const s = String(u || '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

function toast(msg, ms = 2600) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}

// 'YYYY-MM-DD' → '11/17(火)'。年が違えば年も付ける
const WEEK = '日月火水木金土';
function fmtDay(s, { year = false } = {}) {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(String(s || ''));
  if (!m) return String(s || '');
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  const y = year || d.getFullYear() !== new Date().getFullYear() ? `${m[1]}/` : '';
  return `${y}${+m[2]}/${+m[3]}(${WEEK[d.getDay()]})`;
}

// <input type="date"> 用
function dateValue(s) {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(String(s || ''));
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}

const fmtShares = n => (n === null || n === undefined || n === '' ? '' : `${Number(n).toLocaleString('ja-JP')}株`);

function daysText(d) {
  if (d === null) return '';
  if (d < 0) return `${-d}日過ぎ`;
  if (d === 0) return '今日まで';
  return `あと${d}日`;
}

function setTitle(text, { back = false, action = null } = {}) {
  document.getElementById('nav-title').textContent = text;
  const large = document.getElementById('nav-title-large');
  large.textContent = text;
  large.classList.toggle('is-long', text.length > 9);
  document.getElementById('back').hidden = !back;
  document.title = `${text} - ${W.APP}`;
  $action.hidden = !action;
  $action.onclick = action ? action.onClick : null;
  if (action) { $action.textContent = action.label; $action.setAttribute('aria-label', action.aria || action.label); }
}

function setTab(tab) {
  for (const a of document.querySelectorAll('.tabbar__item')) {
    const on = a.dataset.tab === tab;
    a.classList.toggle('is-active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

// 一覧が下から順に浮かぶように、要素に --i を振る(12件で頭打ち)
function stagger(root) {
  [...root.querySelectorAll('[data-rise]')].forEach((el, i) => el.style.setProperty('--i', Math.min(i, 12)));
}

async function load() {
  const [holdings, benefits, receipts, campaigns] = await Promise.all(['holdings', 'benefits', 'receipts', 'campaigns'].map(n => db.getAll(n)));
  Object.assign(state, {
    holdings: holdings.sort((a, b) => a.code.localeCompare(b.code)),
    benefits: benefits.filter(b => !isDeleted(b.deleted)),
    receipts: receipts.filter(r => !isDeleted(r.deleted)),
    campaigns: campaigns.filter(c => !isDeleted(c.deleted)),
  });
  const saved = await db.getMeta('benefitView');
  if (saved && !load.done) Object.assign(view, saved);
  load.done = true;
}

function rows() { return joinHoldings(state.holdings, state.benefits); }
function rowOf(code) { return rows().find(r => r.code === code); }
function companyOf(code) { const r = rowOf(code); return r ? r.name : ''; }

// 初回起動: seed.json(ハブの初期データと同じ中身)から読み込む
async function seedIfEmpty() {
  if (await db.getMeta('seededAt')) return false;
  const [b, h] = await Promise.all([db.getAll('benefits'), db.getAll('holdings')]);
  if (b.length || h.length) { await db.setMeta('seededAt', 'existing'); return false; }
  const res = await fetch('seed.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('初期データ(seed.json)を読めませんでした');
  const seed = await res.json();
  await db.replaceAll('holdings', seed.holdings);
  for (const name of db.SYNCED) await db.putMany(name, seed[name] || [], { silent: true });
  await db.setMeta('holdingsAt', seed.holdingsAt || seed.version);
  await db.setMeta('seededAt', seed.version);
  return true;
}

// ---------- 部品 ----------
function badge(has) {
  const cls = has === 'あり' ? 'badge--yes' : has === 'なし' ? 'badge--no' : 'badge--check';
  return `<span class="badge ${cls}">${has === '要確認' ? '要確認' : `優待${has}`}</span>`;
}

function monthChips(text) {
  const ms = recordMonths(text);
  return ms.length ? ms.map(m => `<span class="month-chip">${m}月</span>`).join('') : '';
}

// 12か月の暦帯: 権利確定する銘柄のある月に印を灯す。押すとその月で絞り込む
function ribbonHtml(all) {
  const counts = monthCounts(all);
  const now = new Date().getMonth() + 1;
  const any = counts.some(Boolean);
  const cells = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    const n = counts[m];
    const dots = n ? '<i></i>'.repeat(Math.min(n, 3)) : '';
    return `<button class="ribbon__m${m === now ? ' is-now' : ''}${view.month === m ? ' is-active' : ''}${n ? ' has' : ''}" data-month="${m}" aria-pressed="${view.month === m}" aria-label="${m}月 権利確定 ${n}銘柄">
      <span class="ribbon__num">${m}</span><span class="ribbon__dots">${dots}</span>${n > 3 ? `<span class="ribbon__more">${n}</span>` : ''}</button>`;
  }).join('');
  return `<section class="ribbon" aria-label="権利確定の暦">
    <div class="ribbon__cord" aria-hidden="true"></div>
    <div class="ribbon__months">${cells}</div>
    ${any ? '' : `<p class="ribbon__hint">${esc(W.EMPTY.ribbon)}</p>`}
  </section>`;
}

// ---------- 1. 優待 ----------
function renderBenefits() {
  setTab('benefits');
  setTitle(W.TABS.benefits);
  const all = rows();
  const list = filterHoldings(all, view).sort((a, b) => SORTS[view.sort](a, b));
  const n = { all: all.length, あり: 0, なし: 0, 要確認: 0 };
  all.forEach(r => { n[hasOf(r)]++; });
  const seg = [['', `すべて ${n.all}`], ['あり', `あり ${n['あり']}`], ['要確認', `要確認 ${n['要確認']}`], ['なし', `なし ${n['なし']}`]];
  $view.innerHTML = `
    ${ribbonHtml(all)}
    <div class="search-wrap"><input class="search-field" id="q" type="search" placeholder="銘柄名・コード・内容で探す" value="${esc(view.q)}" autocomplete="off" enterkeyhint="search" aria-label="銘柄を探す"></div>
    <div class="segmented-wrap"><div class="segmented segmented--wide" role="group" aria-label="優待の有無">
      ${seg.map(([v, l]) => `<button class="segmented__item${view.has === v ? ' is-active' : ''}" data-has="${v}" aria-pressed="${view.has === v}">${l}</button>`).join('')}
    </div></div>
    <div class="sort-bar">
      <span class="muted" id="stock-count">${countText(list)}</span>
      <label for="sort" class="visually-hidden">並び順</label>
      <select id="sort"><option value="code"${view.sort === 'code' ? ' selected' : ''}>コード順</option><option value="name"${view.sort === 'name' ? ' selected' : ''}>名前順</option><option value="record"${view.sort === 'record' ? ' selected' : ''}>権利確定が近い順</option></select>
    </div>
    <div id="stock-list">${stockListHtml(list)}</div>`;
  stagger($view);
  const save = () => db.setMeta('benefitView', { has: view.has, month: view.month, sort: view.sort });
  const q = document.getElementById('q');
  // 検索は一覧だけを差し替える(入力欄はそのまま。日本語の変換中も途切れない)
  q.addEventListener('input', () => {
    view.q = q.value;
    const found = filterHoldings(all, view).sort((a, b) => SORTS[view.sort](a, b));
    document.getElementById('stock-list').innerHTML = stockListHtml(found);
    document.getElementById('stock-count').textContent = countText(found);
  });
  $view.querySelectorAll('[data-has]').forEach(b => b.addEventListener('click', () => { view.has = b.dataset.has; save(); renderBenefits(); }));
  $view.querySelectorAll('[data-month]').forEach(b => b.addEventListener('click', () => { const m = +b.dataset.month; view.month = view.month === m ? 0 : m; save(); renderBenefits(); }));
  document.getElementById('sort').addEventListener('change', e => { view.sort = e.target.value; save(); renderBenefits(); });
}

const countText = list => `${list.length}銘柄${view.month ? ` ・ ${view.month}月に権利確定` : ''}`;
const stockListHtml = list => (list.length ? `<ul class="stocks">${list.map(stockHtml).join('')}</ul>` : `<p class="empty-note">${esc(W.EMPTY.benefits)}</p>`);

function stockHtml(r) {
  const b = r.benefit || {};
  const has = hasOf(r);
  const sub = [r.code, r.held ? fmtShares(r.shares) : '保有なし'].filter(Boolean).join(' ・ ');
  const detail = [b.benefit_category ? `<span class="tag">${esc(b.benefit_category)}</span>` : '', b.benefit_detail ? `<span class="stock__detail">${esc(b.benefit_detail)}</span>` : ''].join('');
  return `<li data-rise><a class="stock${r.held ? '' : ' is-sold'}" href="#benefit/${encodeURIComponent(r.code)}">
    <div class="stock__head"><span class="stock__name">${esc(r.name)}</span>${badge(has)}</div>
    <div class="stock__sub"><span>${esc(sub)}</span>${monthChips(b.record_dates)}</div>
    ${detail ? `<div class="stock__body">${detail}</div>` : ''}
    ${b.tiers ? `<div class="stock__tiers">${esc(b.tiers)}</div>` : ''}
  </a></li>`;
}

// ---------- 優待の詳細と編集 ----------
function field(name, value, { type = 'text', list = '', area = false, rows = 3 } = {}) {
  const label = W.LABEL[name] || name;
  const ph = W.PLACEHOLDER[name] ? ` placeholder="${esc(W.PLACEHOLDER[name])}"` : '';
  if (area) return `<div class="frow frow--area"><label for="f-${name}">${esc(label)}</label><textarea id="f-${name}" name="${name}" rows="${rows}"${ph}>${esc(value)}</textarea></div>`;
  return `<div class="frow"><label for="f-${name}">${esc(label)}</label><input id="f-${name}" name="${name}" type="${type}" value="${esc(type === 'date' ? dateValue(value) : value)}"${list ? ` list="${list}"` : ''}${ph} autocomplete="off"></div>`;
}

function selectField(name, value, options) {
  const opts = options.includes(value) || !value ? options : [value, ...options];
  return `<div class="frow"><label for="f-${name}">${esc(W.LABEL[name] || name)}</label><select id="f-${name}" name="${name}">${opts.map(o => `<option${o === value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></div>`;
}

function datalist(id, items) { return `<datalist id="${id}">${items.map(i => `<option value="${esc(i)}">`).join('')}</datalist>`; }

function formValues(form) {
  const out = {};
  for (const el of form.elements) if (el.name) out[el.name] = el.type === 'radio' ? (el.checked ? el.value : out[el.name] ?? '') : el.value.trim();
  return out;
}

function renderBenefit(code) {
  const r = rowOf(code);
  if (!r) { location.hash = '#benefits'; return; }
  setTab('benefits');
  setTitle(r.name, { back: true });
  const b = r.benefit || { id: `ben-${code}`, code, company_name: r.name, has_benefit: '要確認' };
  const has = hasOf(r);
  const today = todayStr();
  const receipts = sortReceipts(state.receipts.filter(x => x.code === code), today);
  const campaigns = sortCampaigns(state.campaigns.filter(x => x.code === code), today);
  const url = safeUrl(b.official_url);
  $view.innerHTML = `
    <div class="stock-head">
      <p class="stock-head__sub">${esc(code)} ・ ${r.held ? esc(fmtShares(r.shares)) : '保有なし'}${b.checked_at ? ` ・ ${esc(fmtDay(b.checked_at, { year: true }))}に確認` : ''}</p>
      ${url ? `<a class="btn btn--tinted btn--small" href="${esc(url)}" target="_blank" rel="noopener">公式ページを開く</a>` : `<a class="btn btn--tinted btn--small" href="https://www.google.com/search?q=${encodeURIComponent(`${r.name} ${code} 株主優待`)}" target="_blank" rel="noopener">優待を検索する</a>`}
    </div>
    <form id="bform" class="noshi" autocomplete="off">
      <div class="noshi__band" aria-hidden="true"></div>
      <fieldset class="has-pick"><legend>${esc(W.LABEL.has_benefit)}</legend>
        ${W.HAS.map(v => `<label class="has-pick__item"><input type="radio" name="has_benefit" value="${v}"${has === v ? ' checked' : ''}><span>${v}</span></label>`).join('')}
      </fieldset>
      <div class="card form-card">
        ${field('benefit_category', b.benefit_category, { list: 'dl-cat' })}
        ${field('benefit_detail', b.benefit_detail, { area: true })}
        ${field('tiers', b.tiers, { area: true })}
        ${field('record_dates', b.record_dates)}
        ${field('arrival_timing', b.arrival_timing)}
        ${field('validity_note', b.validity_note)}
      </div>
      <div class="card form-card">
        ${field('official_url', b.official_url, { type: 'url' })}
        <div class="frow"><label for="f-checked_at">${W.LABEL.checked_at}</label><input id="f-checked_at" name="checked_at" type="date" value="${esc(dateValue(b.checked_at))}"><button type="button" class="btn btn--plain btn--small" id="checked-today">今日</button></div>
        ${field('benefit_status', b.benefit_status, { list: 'dl-bstatus' })}
        ${field('memo', b.memo, { area: true })}
      </div>
      ${datalist('dl-cat', W.CATEGORIES)}${datalist('dl-bstatus', W.BENEFIT_STATUS)}
      <div class="actions"><button class="btn btn--prominent btn--large" type="submit">保存する</button></div>
    </form>
    <section class="list-section">
      <h3 class="list-section__header">受取・使用</h3>
      ${receipts.length ? `<ul class="receipts">${receipts.map(receiptHtml).join('')}</ul>` : ''}
      <div class="actions"><a class="btn btn--tinted" href="#receipt/new/${encodeURIComponent(code)}">＋ 受取を記録</a></div>
    </section>
    <section class="list-section">
      <h3 class="list-section__header">特典・キャンペーン</h3>
      ${campaigns.map(c => campaignHtml(c, today)).join('')}
      <div class="actions"><a class="btn btn--tinted" href="#campaign/new/${encodeURIComponent(code)}">＋ 特典を追加</a></div>
    </section>`;
  const form = document.getElementById('bform');
  document.getElementById('checked-today').addEventListener('click', () => { form.elements.checked_at.value = todayStr(); });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const v = formValues(form);
    const rec = Object.assign({}, b, v, { id: b.id || `ben-${code}`, code, company_name: b.company_name || r.name });
    if (rec.official_url && !safeUrl(rec.official_url)) { toast('公式ページは https:// で始まるURLにしてください'); return; }
    await db.put('benefits', rec);
    await load();
    toast('保存しました');
    history.length > 1 ? history.back() : (location.hash = '#benefits');
  });
  bindCampaignStatus($view, () => renderBenefit(code));
}

// ---------- 2. 受取・使用 ----------
function receiptHtml(r) {
  const today = todayStr();
  const level = expiryLevel(r, today);
  const d = daysUntil(r.expires_at, today);
  const when = r.expires_at ? fmtDay(r.expires_at) : '期限なし';
  const sub = [r.fiscal_year, r.received_at ? `${fmtDay(r.received_at)}着` : '', r.status !== '未使用' ? r.status : '', r.used_at ? `${fmtDay(r.used_at)}使用` : ''].filter(Boolean).join(' ・ ');
  const flag = level === 'expired' ? '<span class="flag flag--over">期限切れ</span>' : level === 'soon' ? `<span class="flag flag--soon">${esc(daysText(d))}</span>` : '';
  return `<li data-rise><a class="receipt receipt--${level}" href="#receipt/${encodeURIComponent(r.id)}">
    <div class="receipt__when"><span class="receipt__label">期限</span><b>${esc(when)}</b>${level === 'later' ? `<span class="receipt__left">${esc(daysText(d))}</span>` : ''}</div>
    <div class="receipt__main">
      <div class="receipt__name">${esc(r.company_name || companyOf(r.code))} ${flag}</div>
      <div class="receipt__benefit">${esc(r.benefit_name || '優待')}</div>
      ${sub ? `<div class="receipt__sub">${esc(sub)}</div>` : ''}
    </div>
  </a></li>`;
}

function renderReceipts() {
  setTab('receipts');
  setTitle(W.TABS.receipts, { action: { label: '＋', aria: '受取を記録', onClick: () => { location.hash = '#receipt/new'; } } });
  const today = todayStr();
  const sorted = sortReceipts(state.receipts, today);
  const open = sorted.filter(r => expiryLevel(r, today) !== 'used');
  const used = sorted.filter(r => expiryLevel(r, today) === 'used');
  const over = open.filter(r => expiryLevel(r, today) === 'expired').length;
  const soon = open.filter(r => expiryLevel(r, today) === 'soon').length;
  const list = view.receipts === 'used' ? used : view.receipts === 'all' ? sorted : open;
  const seg = [['open', `使える ${open.length}`], ['used', `使い終えた ${used.length}`], ['all', 'すべて']];
  $view.innerHTML = `
    ${over || soon ? `<p class="lead">${over ? `<span class="flag flag--over">期限切れ ${over}</span>` : ''}${soon ? `<span class="flag flag--soon">${SOON_DAYS}日以内 ${soon}</span>` : ''}</p>` : ''}
    <div class="segmented-wrap"><div class="segmented segmented--wide" role="group" aria-label="表示">
      ${seg.map(([v, l]) => `<button class="segmented__item${view.receipts === v ? ' is-active' : ''}" data-r="${v}" aria-pressed="${view.receipts === v}">${l}</button>`).join('')}
    </div></div>
    ${list.length ? `<ul class="receipts">${list.map(receiptHtml).join('')}</ul>` : `<p class="empty-note">${esc(view.receipts === 'used' ? W.EMPTY.receiptsUsed : W.EMPTY.receiptsOpen)}</p>`}
    <div class="actions"><a class="btn btn--tinted" href="#receipt/new">＋ 受取を記録</a></div>`;
  stagger($view);
  $view.querySelectorAll('[data-r]').forEach(b => b.addEventListener('click', () => { view.receipts = b.dataset.r; renderReceipts(); }));
}

function codeOptions(selected) {
  const list = rows().slice().sort((a, b) => a.code.localeCompare(b.code));
  return `<option value="">選んでください</option>${list.map(r => `<option value="${esc(r.code)}"${r.code === selected ? ' selected' : ''}>${esc(r.code)} ${esc(r.name)}</option>`).join('')}`;
}

function renderReceipt(id, presetCode = '') {
  const isNew = id === 'new';
  const r = isNew ? null : state.receipts.find(x => x.id === id);
  if (!isNew && !r) { location.hash = '#receipts'; return; }
  setTab('receipts');
  setTitle(isNew ? '受取を記録' : '受取・使用', { back: true });
  const rec = r || { code: presetCode, benefit_name: '', fiscal_year: '', received_at: todayStr(), expires_at: '', status: '未使用', used_at: '', memo: '' };
  if (isNew && presetCode) {
    const b = (rowOf(presetCode) || {}).benefit || {};
    rec.benefit_name = b.benefit_category || '';
  }
  $view.innerHTML = `
    <form id="rform" class="noshi" autocomplete="off">
      <div class="noshi__band" aria-hidden="true"></div>
      <div class="card form-card">
        <div class="frow"><label for="f-code">${W.LABEL.code}</label><select id="f-code" name="code" required>${codeOptions(rec.code)}</select></div>
        ${field('benefit_name', rec.benefit_name)}
        ${field('fiscal_year', rec.fiscal_year)}
      </div>
      <div class="card form-card">
        ${field('received_at', rec.received_at, { type: 'date' })}
        ${field('expires_at', rec.expires_at, { type: 'date' })}
        ${selectField('status', rec.status || '未使用', W.RECEIPT_STATUS)}
        ${field('used_at', rec.used_at, { type: 'date' })}
        ${field('memo', rec.memo, { area: true })}
      </div>
      <div class="actions"><button class="btn btn--prominent btn--large" type="submit">保存する</button></div>
      ${isNew ? '' : '<div class="actions"><button class="btn btn--plain btn--danger" type="button" id="del">この記録を削除</button></div>'}
    </form>`;
  const form = document.getElementById('rform');
  form.elements.status.addEventListener('change', () => {
    if (form.elements.status.value === '使用済' && !form.elements.used_at.value) form.elements.used_at.value = todayStr();
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const v = formValues(form);
    if (!v.code) { toast('銘柄を選んでください'); return; }
    const next = Object.assign({}, r || {}, v, { id: r ? r.id : newId('rcp', v.code), company_name: companyOf(v.code) || (r && r.company_name) || '' });
    await db.put('receipts', next);
    await load();
    toast('保存しました');
    history.length > 1 ? history.back() : (location.hash = '#receipts');
  });
  const del = document.getElementById('del');
  if (del) del.addEventListener('click', async () => {
    if (!confirm('この記録を削除しますか。')) return;
    await db.del('receipts', r.id);
    await load();
    toast('削除しました');
    history.length > 1 ? history.back() : (location.hash = '#receipts');
  });
}

// ---------- 3. 特典 ----------
function campaignHtml(c, today = todayStr()) {
  const st = campaignState(c, today);
  const url = safeUrl(c.apply_url);
  const big = st.days === null ? '—' : st.days < 0 ? '済' : String(st.days);
  const unit = st.days === null ? '期限なし' : st.days < 0 ? `${-st.days}日前に締切` : st.days === 0 ? '今日が締切' : '日';
  return `<article class="ticket ticket--${st.level}" data-rise>
    <div class="ticket__left">
      <p class="ticket__company">${esc(c.company_name || companyOf(c.code))}<span class="muted"> ${esc(c.code)}</span></p>
      <h3 class="ticket__title">${esc(c.title)}</h3>
      <dl class="ticket__dl">
        <dt>${W.LABEL.deadline}</dt><dd>${c.deadline ? esc(fmtDay(c.deadline, { year: true })) : '—'}</dd>
        ${c.conditions ? `<dt>${W.LABEL.conditions}</dt><dd>${esc(c.conditions)}</dd>` : ''}
        ${c.apply_route ? `<dt>${W.LABEL.apply_route}</dt><dd>${esc(c.apply_route)}</dd>` : ''}
        ${c.memo ? `<dt>${W.LABEL.memo}</dt><dd class="ticket__memo">${esc(c.memo)}</dd>` : ''}
      </dl>
    </div>
    <div class="ticket__stub" aria-label="${esc(st.days === null ? '期限なし' : daysText(st.days))}">
      ${st.days !== null && st.days > 0 ? '<span class="ticket__ato">あと</span>' : ''}<b class="ticket__days">${big}</b><span class="ticket__unit">${esc(unit)}</span>
    </div>
    <div class="ticket__foot">
      <label class="visually-hidden" for="cs-${esc(c.id)}">応募ステータス</label>
      <select class="status-pick status-pick--${esc(c.status || '未確認')}" id="cs-${esc(c.id)}" data-cstatus="${esc(c.id)}">${W.CAMPAIGN_STATUS.concat(W.CAMPAIGN_STATUS.includes(c.status) || !c.status ? [] : [c.status]).map(s => `<option${s === (c.status || '未確認') ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select>
      ${url ? `<a class="btn btn--tinted btn--small" href="${esc(url)}" target="_blank" rel="noopener">応募ページ</a>` : ''}
      <a class="btn btn--plain btn--small" href="#campaign/${encodeURIComponent(c.id)}">編集</a>
    </div>
  </article>`;
}

function bindCampaignStatus(root, rerender) {
  root.querySelectorAll('[data-cstatus]').forEach(sel => sel.addEventListener('change', async () => {
    const c = state.campaigns.find(x => x.id === sel.dataset.cstatus);
    if (!c) return;
    await db.put('campaigns', Object.assign({}, c, { status: sel.value }));
    await load();
    toast(`「${sel.value}」にしました`);
    rerender();
  }));
}

function renderCampaigns() {
  setTab('campaigns');
  setTitle(W.TABS.campaigns, { action: { label: '＋', aria: '特典を追加', onClick: () => { location.hash = '#campaign/new'; } } });
  const today = todayStr();
  const sorted = sortCampaigns(state.campaigns, today);
  const live = sorted.filter(c => !campaignState(c, today).closed);
  const done = sorted.filter(c => campaignState(c, today).closed);
  $view.innerHTML = `
    ${live.length ? live.map(c => campaignHtml(c, today)).join('') : `<p class="empty-note">${esc(W.EMPTY.campaigns)}</p>`}
    ${done.length ? `<details class="fold"><summary>終わった特典<small>${done.length}件</small></summary><div class="fold__body">${done.map(c => campaignHtml(c, today)).join('')}</div></details>` : ''}
    <div class="actions"><a class="btn btn--tinted" href="#campaign/new">＋ 特典を追加</a></div>`;
  stagger($view);
  bindCampaignStatus($view, renderCampaigns);
}

function renderCampaign(id, presetCode = '') {
  const isNew = id === 'new';
  const c = isNew ? null : state.campaigns.find(x => x.id === id);
  if (!isNew && !c) { location.hash = '#campaigns'; return; }
  setTab('campaigns');
  setTitle(isNew ? '特典を追加' : '特典', { back: true });
  const rec = c || { code: presetCode, title: '', deadline: '', conditions: '', apply_route: '', apply_url: '', status: '未確認', memo: '' };
  $view.innerHTML = `
    <form id="cform" class="noshi" autocomplete="off">
      <div class="noshi__band" aria-hidden="true"></div>
      <div class="card form-card">
        <div class="frow"><label for="f-code">${W.LABEL.code}</label><select id="f-code" name="code" required>${codeOptions(rec.code)}</select></div>
        ${field('title', rec.title, { area: true, rows: 2 })}
        ${field('deadline', rec.deadline, { type: 'date' })}
        ${selectField('status', rec.status || '未確認', W.CAMPAIGN_STATUS)}
      </div>
      <div class="card form-card">
        ${field('conditions', rec.conditions, { area: true })}
        ${field('apply_route', rec.apply_route)}
        ${field('apply_url', rec.apply_url, { type: 'url' })}
        ${field('memo', rec.memo, { area: true })}
      </div>
      <div class="actions"><button class="btn btn--prominent btn--large" type="submit">保存する</button></div>
      ${isNew ? '' : '<div class="actions"><button class="btn btn--plain btn--danger" type="button" id="del">この特典を削除</button></div>'}
    </form>`;
  const form = document.getElementById('cform');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const v = formValues(form);
    if (!v.code) { toast('銘柄を選んでください'); return; }
    if (!v.title) { toast('特典の名前を入れてください'); return; }
    if (v.apply_url && !safeUrl(v.apply_url)) { toast('応募ページは https:// で始まるURLにしてください'); return; }
    const next = Object.assign({}, c || {}, v, { id: c ? c.id : newId('camp', v.code), company_name: companyOf(v.code) || (c && c.company_name) || '' });
    await db.put('campaigns', next);
    await load();
    toast('保存しました');
    history.length > 1 ? history.back() : (location.hash = '#campaigns');
  });
  const del = document.getElementById('del');
  if (del) del.addEventListener('click', async () => {
    if (!confirm('この特典を削除しますか。')) return;
    await db.del('campaigns', c.id);
    await load();
    toast('削除しました');
    history.length > 1 ? history.back() : (location.hash = '#campaigns');
  });
}

// ---------- 4. 設定 ----------
const fmtStamp = iso => {
  if (!iso) return 'まだ';
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return fmtDay(iso, { year: true });
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

let unwatchSync = null;
function bindSyncSettings() {
  const stateEl = document.getElementById('sync-state');
  const sum = document.getElementById('sync-sum');
  const hold = document.getElementById('hold-at');
  const show = st => {
    if (!document.body.contains(stateEl)) return;
    stateEl.textContent = st.state === 'off' ? `未接続${st.pending ? ` ・ この端末で書いた未送信 ${st.pending}件` : ''}`
      : st.state === 'syncing' ? '同期しています…'
      : st.state === 'error' ? `同期できませんでした: ${st.error}`
      : `最終同期: ${fmtStamp(st.lastAt)}${st.pending ? ` ・ 未送信 ${st.pending}件` : ''}`;
    sum.textContent = st.state === 'off' ? '' : st.state === 'error' ? 'エラー' : st.state === 'syncing' ? '同期中' : '接続中';
    hold.textContent = fmtStamp(st.holdingsAt);
  };
  if (unwatchSync) unwatchSync();
  unwatchSync = sync.onStatus(show);
  show(sync.status);
  const on = document.getElementById('s-on');
  if (on) on.addEventListener('click', async () => {
    const url = document.getElementById('s-url').value.trim();
    const token = document.getElementById('s-token').value.trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url) || !token) { toast('URL(script.google.com)と合言葉を入れてください'); return; }
    on.disabled = true;
    try { await sync.connect(url, token); } catch (e) { toast(e.message, 4000); on.disabled = false; return; }
    if (sync.status.state === 'error') { toast(sync.status.error, 4000); on.disabled = false; return; }
    toast('株主優待ハブにつなぎました');
    await load();
    renderSettings().then(() => { document.getElementById('sync-fold').open = true; });
  });
  const now = document.getElementById('s-now');
  if (now) now.addEventListener('click', () => sync.syncNow());
  const off = document.getElementById('s-off');
  if (off) off.addEventListener('click', async () => {
    if (!confirm('同期をやめますか。この端末のデータとスプレッドシートはどちらも残ります。')) return;
    await sync.disconnect();
    renderSettings().then(() => { document.getElementById('sync-fold').open = true; });
  });
}

async function renderSettings() {
  setTab('settings');
  setTitle(W.TABS.settings);
  const [syncUrl, syncToken, lastBackup, seededAt, persisted] = await Promise.all([
    db.getMeta('syncUrl', ''), db.getMeta('syncToken', ''), db.getMeta('lastBackupAt'), db.getMeta('seededAt'),
    navigator.storage && navigator.storage.persisted ? navigator.storage.persisted() : Promise.resolve(false),
  ]);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $view.innerHTML = `
    <details class="fold" id="sync-fold" open><summary>株主優待ハブ(同期)<small id="sync-sum"></small></summary><div class="fold__body">
      <div class="card">
        <div class="row"><label for="s-url">URL</label><input id="s-url" type="url" autocomplete="off" value="${esc(syncUrl)}" placeholder="https://script.google.com/macros/s/…/exec"></div>
        <div class="row"><label for="s-token">合言葉</label><input id="s-token" type="password" autocomplete="off" value="${esc(syncToken)}" placeholder="setup の実行ログに出たもの"></div>
      </div>
      <p class="list-section__footer" id="sync-state"></p>
      <div class="actions">${syncUrl ? `<button class="btn btn--prominent" id="s-now">今すぐ同期</button><button class="btn btn--plain" id="s-off">同期をやめる</button>` : `<button class="btn btn--prominent" id="s-on">接続して同期する</button>`}</div>
      <div class="card"><div class="row"><span class="row__label">保有株数の更新</span><span class="row__value" id="hold-at"></span></div></div>
      <p class="list-section__footer">自分のGoogleスプレッドシート「株主優待ハブ」に、優待・受取・特典を置きます。開いたとき、アプリに戻ったとき、書いて数秒後に、変わった分だけをやり取りします。保有株数はポートフォリオのシートから読むだけです。準備の手順は<a href="https://github.com/tadamasa/yutai-memo/blob/main/hub/README.md" target="_blank" rel="noopener">こちら</a>。</p>
    </div></details>
    <details class="fold"><summary>バックアップ</summary><div class="fold__body">
      <div class="card"><p class="small muted" style="margin:0">ハブとつないでいれば、データはスプレッドシートにもあります。つないでいないときは、ときどき書き出して「ファイル」アプリ(iCloud Drive)に保存してください。</p>
      <p class="small" style="margin:var(--space-2) 0 0">最後の書き出し: ${lastBackup ? esc(fmtStamp(lastBackup)) : 'まだありません'}</p></div>
      <div class="actions"><button class="btn btn--tinted" id="export">書き出す</button><label class="btn btn--tinted">読み込む<input type="file" id="import" accept="application/json,.json" hidden></label></div>
      ${!standalone ? '<p class="list-section__footer">Safariの共有ボタンから「ホーム画面に追加」してから使ってください。追加しないと、しばらく開かないうちにデータが消えることがあります。</p>' : ''}
      <p class="list-section__footer">保存領域の保護: ${persisted ? '有効' : '未許可'}</p>
    </div></details>
    <details class="fold"><summary>このアプリの使い方</summary><div class="fold__body">
      <div class="card story">${W.STORY.map(p => `<p>${esc(p)}</p>`).join('')}</div>
    </div></details>
    <details class="fold"><summary>このアプリについて</summary><div class="fold__body">
      <p class="list-section__footer">保有 ${state.holdings.length}銘柄 ・ 優待 ${state.benefits.length}件 ・ 受取 ${state.receipts.length}件 ・ 特典 ${state.campaigns.length}件。初期データ: ${esc(seededAt || '—')}。</p>
    </div></details>`;
  bindSyncSettings();
  document.getElementById('export').addEventListener('click', async () => {
    try { if (await exportData()) { toast('書き出しました'); renderSettings(); } } catch (e) { toast(e.message); }
  });
  document.getElementById('import').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try { const n = await importData(await f.text()); await load(); toast(`${n}件を読み込みました`); renderSettings(); } catch (err) { toast(err.message); }
  });
}

// ---------- ルーティング ----------
async function route() {
  const [name, arg, arg2] = location.hash.replace(/^#/, '').split('/').map(s => decodeURIComponent(s || ''));
  window.scrollTo(0, 0);
  document.body.dataset.route = name || 'benefits';
  $view.classList.remove('is-in');
  void $view.offsetWidth;
  $view.classList.add('is-in');
  switch (name) {
    case 'benefit': return renderBenefit(arg);
    case 'receipts': return renderReceipts();
    case 'receipt': return renderReceipt(arg || 'new', arg2);
    case 'campaigns': return renderCampaigns();
    case 'campaign': return renderCampaign(arg || 'new', arg2);
    case 'settings': return renderSettings();
    default: return renderBenefits();
  }
}

document.getElementById('back').addEventListener('click', () => (history.length > 1 ? history.back() : (location.hash = '#benefits')));
addEventListener('hashchange', route);

// Large Title の折り畳み
const nav = document.getElementById('nav');
const sentinel = document.createElement('div');
sentinel.style.cssText = 'position:absolute;top:0;height:1px;width:1px;';
document.body.prepend(sentinel);
new IntersectionObserver(([e]) => nav.classList.toggle('is-collapsed', !e.isIntersecting), { threshold: 0 }).observe(sentinel);

// 他の端末やハブの変更を受け取ったら読み直す。入力中は画面を作り直さない(次に画面を移ったときに反映される)
async function onRemoteChange() {
  await load();
  const a = document.activeElement;
  const typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
  const editing = /^#(benefit|receipt|campaign)\//.test(location.hash) || location.hash.startsWith('#settings');
  if (!typing && !editing) { const y = scrollY; await route(); scrollTo(0, y); }
}

(async function start() {
  try { await seedIfEmpty(); } catch (e) { toast(e.message, 4000); }
  await load();
  db.requestPersist();
  // Safariのタブはホーム画面のアプリと保存場所が別で、使わないと7日で消える
  if (!(matchMedia('(display-mode: standalone)').matches || navigator.standalone)) document.getElementById('tab-warning').hidden = false;
  route();
  // 株主優待ハブとの同期: 開いたとき、アプリに戻ったときに差分をやり取りする
  await sync.initSync({ onRemoteChange });
  sync.schedule(300);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    sync.schedule(300);
    // 日付が変わっていれば残り日数を描き直す
    if (start.day !== todayStr()) { start.day = todayStr(); if (!/^#(benefit|receipt|campaign)\//.test(location.hash)) route(); }
  });
  start.day = todayStr();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();

// テスト用に公開
window.__app = { state, view, load };
