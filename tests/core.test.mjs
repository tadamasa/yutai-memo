// node --test tests/ で実行。画面に触れない計算と、ハブ(hub/Code.gs)の同期の約束を確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { loadHub } from './gas-mock.mjs';
import {
  daysUntil, recordMonths, joinHoldings, filterHoldings, monthCounts, expiryLevel, sortReceipts,
  campaignState, sortCampaigns, ms, isDeleted, SORTS,
} from '../js/yutai.js';

const seed = JSON.parse(fs.readFileSync(new URL('../seed.json', import.meta.url), 'utf8'));
const B = ['id', 'code', 'company_name', 'has_benefit', 'benefit_category', 'benefit_detail', 'tiers', 'record_dates', 'arrival_timing', 'validity_note', 'official_url', 'checked_at', 'benefit_status', 'memo', 'rev', 'mtime', 'deleted'];
const R = ['id', 'code', 'company_name', 'benefit_name', 'fiscal_year', 'received_at', 'expires_at', 'status', 'used_at', 'memo', 'rev', 'mtime', 'deleted'];
const C = ['id', 'code', 'company_name', 'title', 'deadline', 'conditions', 'apply_route', 'apply_url', 'status', 'memo', 'rev', 'mtime', 'deleted'];
const toRow = (cols, o) => cols.map(c => (c === 'deleted' ? (o.deleted ? '1' : '0') : String(o[c] ?? '')));

// いまのハブと同じ初期状態(seed.json と同じ中身)の表を作る
function hubLikeSheet() {
  return loadHub({
    initial: {
      benefits: [B, ...seed.benefits.map(b => toRow(B, b))],
      receipts: [R],
      campaigns: [C, ...seed.campaigns.map(c => toRow(C, c))],
    },
    portfolio: [
      ['日経平均底値ー天井'], [], ['銘柄コード', '銘柄名', '購入日', '株数', '購入金額', '現在株価'],
      ...seed.holdings.slice(0, 48).map(h => [h.code, h.name, '2026/01/01', h.shares.toLocaleString('en-US'), '1', String(h.price)]),
      [], ['貸株入金', 'https://example.com'], ['入金明細', 'https://example.com'],
      ...seed.holdings.slice(48).map(h => [h.code, h.name, '2026/01/01', h.shares.toLocaleString('en-US'), '1', String(h.price)]),
    ],
  });
}

// ---------- seed.json ----------

test('seed.json は保有51件・優待51件・特典1件で、証券コードがそろっている', () => {
  assert.equal(seed.holdings.length, 51);
  assert.equal(seed.benefits.length, 51);
  assert.equal(seed.campaigns.length, 1);
  assert.equal(seed.receipts.length, 0);
  const codes = new Set(seed.holdings.map(h => h.code));
  assert.equal(codes.size, 51);
  for (const b of seed.benefits) {
    assert.ok(codes.has(b.code), b.code);
    assert.equal(b.id, `ben-${b.code}`);
    assert.equal(b.has_benefit, '要確認');
    assert.deepEqual(Object.keys(b).sort(), B.slice().sort());
  }
  const c = seed.campaigns[0];
  assert.equal(c.id, 'camp-9434-bleague2027');
  assert.equal(c.deadline, '2026-11-17');
  assert.equal(seed.holdings.find(h => h.code === '9434').shares, 6000);
});

// ---------- 計算 ----------

test('日数の計算(今日=0、過ぎたら負)', () => {
  assert.equal(daysUntil('2026-11-17', '2026-11-13'), 4);
  assert.equal(daysUntil('2026-11-13', '2026-11-13'), 0);
  assert.equal(daysUntil('2026/11/12', '2026-11-13'), -1);
  assert.equal(daysUntil('2027-03-31', '2026-11-13'), 138);
  assert.equal(daysUntil('', '2026-11-13'), null);
});

test('権利確定月をいろいろな書き方から取り出す', () => {
  assert.deepEqual(recordMonths('3月末・9月末'), [3, 9]);
  assert.deepEqual(recordMonths('3・9月'), [3, 9]);
  assert.deepEqual(recordMonths('6月, 12月末日'), [6, 12]);
  assert.deepEqual(recordMonths('2027-03-31'), [3]);
  assert.deepEqual(recordMonths('毎年１２月末'), [12]);
  assert.deepEqual(recordMonths('100株以上を1年以上'), []);
  assert.deepEqual(recordMonths(''), []);
});

test('保有株式と優待を証券コードで結合し、絞り込む', () => {
  const rows = joinHoldings(seed.holdings, seed.benefits.concat([{ id: 'ben-9999', code: '9999', company_name: '売却済み', has_benefit: 'あり', record_dates: '3月末', deleted: false }]));
  assert.equal(rows.length, 52);
  const sb = rows.find(r => r.code === '9434');
  assert.equal(sb.shares, 6000);
  assert.equal(sb.benefit.id, 'ben-9434');
  assert.equal(rows.find(r => r.code === '9999').held, false);
  assert.equal(filterHoldings(rows, { q: 'ソフト' }).length, 1);
  assert.equal(filterHoldings(rows, { q: '9434' }).length, 1);
  assert.equal(filterHoldings(rows, { has: '要確認' }).length, 51);
  assert.equal(filterHoldings(rows, { month: 3 }).length, 1);
  assert.equal(filterHoldings(rows, { heldOnly: true }).length, 51);
  assert.equal(monthCounts(rows)[3], 1);
  const sorted = rows.slice().sort((a, b) => SORTS.record(a, b, 2));
  assert.equal(sorted[0].code, '9999');
});

test('受取は期限の近い順、期限切れと30日以内を見分け、使い終えたものは最後', () => {
  const today = '2026-11-13';
  const list = [
    { id: 'a', company_name: 'A', expires_at: '2027-06-30', status: '未使用' },
    { id: 'b', company_name: 'B', expires_at: '2026-11-30', status: '未使用' },
    { id: 'c', company_name: 'C', expires_at: '2026-11-01', status: '未使用' },
    { id: 'd', company_name: 'D', expires_at: '2026-11-20', status: '使用済', used_at: '2026-11-10' },
    { id: 'e', company_name: 'E', expires_at: '', status: '未使用', received_at: '2026-10-01' },
    { id: 'f', company_name: 'F', expires_at: '2026-12-01', status: '未使用', deleted: true },
  ];
  assert.deepEqual(sortReceipts(list, today).map(r => r.id), ['c', 'b', 'a', 'e', 'd']);
  assert.equal(expiryLevel(list[2], today), 'expired');
  assert.equal(expiryLevel(list[1], today), 'soon');
  assert.equal(expiryLevel(list[0], today), 'later');
  assert.equal(expiryLevel(list[3], today), 'used');
  assert.equal(expiryLevel(list[4], today), 'none');
});

test('特典の残り日数と並び順', () => {
  const today = '2026-11-13';
  const c = seed.campaigns[0];
  assert.deepEqual(campaignState(c, today), { days: 4, closed: false, level: 'soon' });
  assert.equal(campaignState({ deadline: '2026-11-13' }, today).level, 'today');
  assert.equal(campaignState({ deadline: '2026-11-01' }, today).closed, true);
  assert.equal(campaignState({ deadline: '2026-12-01', status: '応募済' }, today).level, 'done');
  const list = [
    { id: 'x', deadline: '2026-12-31', status: '未確認' },
    { id: 'y', deadline: '2026-11-15', status: '応募済' },
    c,
    { id: 'z', deadline: '2026-10-01', status: '未確認' },
  ];
  assert.deepEqual(sortCampaigns(list, today).map(x => x.id), [c.id, 'x', 'y', 'z']);
});

test('mtime と deleted の読み方', () => {
  assert.ok(ms('2026-11-13T09:00:00.000Z') > ms('2026-11-13'));
  assert.equal(ms(''), 0);
  assert.equal(ms(1700000000000), 1700000000000);
  assert.equal(isDeleted('1'), true);
  assert.equal(isDeleted('true'), true);
  assert.equal(isDeleted('0'), false);
  assert.equal(isDeleted(false), false);
});

// ---------- ハブ ----------

test('ping は合言葉なしで yutai-hub を返し、ほかの口は合言葉が要る', () => {
  const hub = hubLikeSheet();
  assert.deepEqual(hub.get({ action: 'ping' }), { ok: true, app: 'yutai-hub' });
  assert.deepEqual(hub.get({}), { ok: true, app: 'yutai-hub' });
  assert.equal(hub.get({ action: 'pull', since: '0' }).error, 'unauthorized');
  assert.equal(hub.get({ action: 'pull', since: '0', token: 'x' }).error, 'unauthorized');
  assert.equal(hub.get({ action: 'holdings', token: 'x' }).error, 'unauthorized');
  assert.equal(hub.post({ token: 'x' }).error, 'unauthorized');
  assert.equal(hub.get({ action: 'nope', token: hub.token }).error, 'unknown action');
});

test('いまの表をそのまま読み、最初の pull で seed.json と同じものが返る', () => {
  const hub = hubLikeSheet();
  const r = hub.get({ action: 'pull', since: '0', token: hub.token });
  assert.equal(r.ok, true);
  assert.equal(r.more, false);
  assert.equal(r.rev, 1);
  assert.equal(r.benefits.length, 51);
  assert.equal(r.campaigns.length, 1);
  assert.deepEqual(r.benefits.map(b => ({ ...b })), seed.benefits);
  assert.deepEqual(r.campaigns, seed.campaigns);
  // 何も変わっていなければ、次は空
  const r2 = hub.get({ action: 'pull', since: String(r.rev), token: hub.token });
  assert.equal(r2.benefits.length + r2.receipts.length + r2.campaigns.length, 0);
  // 初期の rev はそのまま(書き換えない)
  assert.equal(hub.rowOf('benefits', 'ben-1720').rev, '1');
});

test('POST で id ごとに upsert し、表より古い書き込みは捨てる', () => {
  const hub = hubLikeSheet();
  const t = hub.token;
  const edited = { ...seed.benefits.find(b => b.code === '2702'), has_benefit: 'あり', benefit_category: '食事券', benefit_detail: '食事優待券 1冊(6枚綴り)', record_dates: '6月末・12月末', mtime: '2026-11-13T10:00:00.000Z' };
  let r = hub.post({ token: t, benefits: [edited] });
  assert.equal(r.saved, 1);
  assert.equal(r.rev, 2);
  assert.equal(hub.rowOf('benefits', 'ben-2702').has_benefit, 'あり');
  assert.equal(hub.rowOf('benefits', 'ben-2702').record_dates, '6月末・12月末');
  // 古い書き込みは捨てる
  r = hub.post({ token: t, benefits: [{ ...edited, has_benefit: 'なし', mtime: '2026-11-13T09:00:00.000Z' }] });
  assert.deepEqual(r.skipped, ['ben-2702']);
  assert.equal(hub.rowOf('benefits', 'ben-2702').has_benefit, 'あり');
  // 新しい受取を追加
  const rc = { id: 'rcp-a', code: '2702', company_name: '日本マクドナルドホールディングス(株)', benefit_name: '食事優待券', fiscal_year: '2026年6月', received_at: '2026-09-20', expires_at: '2027-03-31', status: '未使用', used_at: '', memo: '', mtime: '2026-11-13T10:01:00.000Z' };
  r = hub.post({ token: t, receipts: [rc] });
  assert.equal(r.saved, 1);
  const p = hub.get({ action: 'pull', since: '1', token: t });
  assert.deepEqual(p.benefits.map(b => b.id), ['ben-2702']);
  assert.equal(p.receipts[0].expires_at, '2027-03-31');
  assert.equal(p.receipts[0].deleted, false);
  // 削除は墓標として残り、pull で deleted:true が返る
  hub.post({ token: t, receipts: [{ id: 'rcp-a', mtime: '2026-11-13T10:02:00.000Z', deleted: true }] });
  assert.equal(hub.rowOf('receipts', 'rcp-a').deleted, '1');
  assert.equal(hub.rowOf('receipts', 'rcp-a').benefit_name, '食事優待券'); // 中身は残す
  const p2 = hub.get({ action: 'pull', since: String(p.rev), token: t });
  assert.equal(p2.receipts[0].deleted, true);
});

test('さくら用合言葉では追加・更新はできるが、削除は受け付けない', () => {
  const hub = hubLikeSheet();
  const s = hub.setupSakura();
  let r = hub.post({ token: s, campaigns: [{ id: 'camp-x', code: '7974', company_name: '任天堂', title: '試し', deadline: '2026-12-01', status: '未確認', mtime: '2026-11-13T11:00:00.000Z' }] });
  assert.equal(r.saved, 1);
  r = hub.post({ campaigns: [{ id: 'camp-x', mtime: '2026-11-13T12:00:00.000Z', deleted: true }] }, { token: s });
  assert.deepEqual(r.skipped, ['camp-x']);
  assert.equal(hub.rowOf('campaigns', 'camp-x').deleted, '0');
  assert.equal(hub.get({ action: 'pull', since: '0', token: s }).ok, true);
  // 端末用の合言葉なら消せる
  r = hub.post({ campaigns: [{ id: 'camp-x', mtime: '2026-11-13T12:00:00.000Z', deleted: true }] }, { token: hub.token });
  assert.equal(r.saved, 1);
});

test('表を直接書き換えた行・id のない行・消した行は、次の pull で流れる', () => {
  const hub = hubLikeSheet();
  const t = hub.token;
  let p = hub.get({ action: 'pull', since: '0', token: t });
  const since = p.rev;
  // 人(やほかのAI)が表を直接直す
  hub.edit('benefits', 'ben-9434', 'has_benefit', 'あり');
  hub.edit('benefits', 'ben-9434', 'benefit_detail', 'PayPayポイント 1,000円相当');
  // id なしで行を足す
  hub.sheets.get('receipts').rows.push(['', '9434', 'ソフトバンク', 'PayPayポイント', '2026年3月', '2026-07-01', '2026-12-31', '未使用', '', '', '', '', '']);
  // 特典の行を消す
  hub.removeRow('campaigns', 'camp-9434-bleague2027');
  p = hub.get({ action: 'pull', since: String(since), token: t });
  assert.equal(p.benefits.length, 1);
  assert.equal(p.benefits[0].has_benefit, 'あり');
  assert.ok(ms(p.benefits[0].mtime) > ms('2026-11-13'));
  assert.equal(p.receipts.length, 1);
  assert.match(p.receipts[0].id, /^rcp-9434-/);
  assert.equal(p.campaigns.length, 1);
  assert.equal(p.campaigns[0].deleted, true);
  // 表にも id と rev が書き戻される
  const row = hub.sheets.get('receipts').rows[1];
  assert.match(row[0], /^rcp-9434-/);
  assert.equal(row[R.indexOf('deleted')], '0');
  // もう一度引いても同じものは出ない
  const p2 = hub.get({ action: 'pull', since: String(p.rev), token: t });
  assert.equal(p2.benefits.length + p2.receipts.length + p2.campaigns.length, 0);
  // 表で直された行に、それより古い端末の書き込みが来ても上書きしない
  const r = hub.post({ token: t, benefits: [{ ...seed.benefits.find(b => b.code === '9434'), has_benefit: 'なし', mtime: '2026-11-13T00:00:01.000Z' }] });
  assert.deepEqual(r.skipped, ['ben-9434']);
});

test('pull は400件ずつ返し、more で続きを知らせる', () => {
  const hub = hubLikeSheet();
  const t = hub.token;
  const many = Array.from({ length: 900 }, (_, i) => ({ id: `rcp-${i}`, code: '9434', company_name: 'ソフトバンク', benefit_name: `券${i}`, status: '未使用', mtime: '2026-11-13T10:00:00.000Z' }));
  hub.post({ token: t, receipts: many });
  let since = 0, more = true, got = 0, pages = 0;
  while (more) {
    const r = hub.get({ action: 'pull', since: String(since), token: t });
    got += r.benefits.length + r.receipts.length + r.campaigns.length;
    since = r.rev; more = r.more; pages++;
  }
  assert.equal(got, 952);
  assert.equal(pages, 3);
});

test('holdings はポートフォリオの保有株式を読むだけで返す(空行やリンクの行は飛ばす)', () => {
  const hub = hubLikeSheet();
  const r = hub.get({ action: 'holdings', token: hub.token });
  assert.equal(r.ok, true);
  assert.equal(r.holdings.length, 51);
  assert.deepEqual(r.holdings.find(h => h.code === '9434'), { code: '9434', name: 'ソフトバンク', shares: 6000, price: 240.1 });
  assert.deepEqual(r.holdings.map(h => h.code), seed.holdings.map(h => h.code));
  assert.deepEqual(hub.opened, ['15s_YBYsSbCHmGRGO8ZjP_9SdS_hqQqBmhjBJP9D4fsk']);
  // ポートフォリオには何も書かない
  const before = JSON.stringify([...hub.portfolioSheets.get('保有株式').rows]);
  hub.get({ action: 'holdings', token: hub.token });
  assert.equal(JSON.stringify([...hub.portfolioSheets.get('保有株式').rows]), before);
  // スクリプトプロパティで別のシートを指せる
  hub.props.PORTFOLIO_ID = 'other';
  hub.get({ action: 'holdings', token: hub.token });
  assert.equal(hub.opened.at(-1), 'other');
});

test('空のスプレッドシートでも setup で表を作って動く', () => {
  const hub = loadHub();
  assert.ok(hub.sheets.get('benefits'));
  assert.deepEqual(hub.sheets.get('benefits').rows[0], B);
  assert.deepEqual(hub.sheets.get('campaigns').rows[0], C);
  const r = hub.post({ token: hub.token, benefits: [{ id: 'ben-1', code: '1111', company_name: 'テスト', has_benefit: 'あり', mtime: '2026-11-13T10:00:00.000Z' }] });
  assert.equal(r.rev, 1);
  assert.equal(hub.get({ action: 'pull', since: '0', token: hub.token }).benefits[0].company_name, 'テスト');
  assert.equal(hub.get({ action: 'holdings', token: hub.token }).ok, false);
});
