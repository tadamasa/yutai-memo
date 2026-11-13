// Apps Script の最小限の模擬。hub/Code.gs を Node で動かして確かめるためのもの(読書メモの tests/gas-mock.mjs を広げた版)。
import fs from 'fs';
import vm from 'vm';

function makeBook() {
  const sheets = new Map();
  const makeSheet = (name, rows = []) => {
    const sh = { name, rows: rows.map(r => r.slice()), maxRows: Math.max(1000, rows.length), maxCols: 26, frozen: 0 };
    const width = () => sh.rows.reduce((m, r) => Math.max(m, (r || []).length), 0);
    const range = (r, c, nr = 1, nc = 1) => {
      if (r + nr - 1 > sh.maxRows) throw new Error(`範囲外 ${r + nr - 1} > ${sh.maxRows}`);
      const get = () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => ((sh.rows[r - 1 + i] || [])[c - 1 + j] ?? '')));
      const api = {
        getValues: get,
        getDisplayValues: () => get().map(row => row.map(v => String(v))),
        setValues: v => {
          if (v.length !== nr || v.some(row => row.length !== nc)) throw new Error('setValues の大きさが範囲と合いません');
          v.forEach((row, i) => { sh.rows[r - 1 + i] = sh.rows[r - 1 + i] || []; row.forEach((x, j) => { sh.rows[r - 1 + i][c - 1 + j] = x; }); });
          return api;
        },
        clearContent: () => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (sh.rows[r - 1 + i]) sh.rows[r - 1 + i][c - 1 + j] = ''; return api; },
        setNumberFormat: () => api,
        setFontWeight: () => api,
      };
      return api;
    };
    sh.api = {
      getRange: range,
      getLastRow: () => { let n = sh.rows.length; while (n > 0 && !(sh.rows[n - 1] || []).some(v => v !== '' && v != null)) n--; return n; },
      getLastColumn: () => width(),
      getMaxRows: () => sh.maxRows,
      getMaxColumns: () => sh.maxCols,
      insertRowsAfter: (_, n) => { sh.maxRows += n; },
      insertColumnsAfter: (_, n) => { sh.maxCols += n; },
      setFrozenRows: n => { sh.frozen = n; },
    };
    sheets.set(name, sh);
    return sh.api;
  };
  return {
    sheets,
    makeSheet,
    api: { getSheetByName: n => (sheets.get(n) || {}).api || null, insertSheet: n => makeSheet(n) },
  };
}

// initial: { benefits: [[見出し], [行]…], … } で最初の表を置ける。portfolio: 保有株式シートの行(1行目から)
export function loadHub({ initial = {}, portfolio = null } = {}) {
  const book = makeBook();
  for (const [name, rows] of Object.entries(initial)) book.makeSheet(name, rows);
  const pf = makeBook();
  if (portfolio) pf.makeSheet('保有株式', portfolio);
  const opened = [];
  const props = {};
  const ctx = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => book.api,
      openById: id => { opened.push(id); if (!portfolio) throw new Error('not found'); return pf.api; },
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = String(v); } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { createTextOutput: s => ({ text: s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    Utilities: { getUuid: () => `${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}` },
    Logger: { log() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../hub/Code.gs', import.meta.url), 'utf8'), ctx);
  ctx.setup();
  const parse = o => JSON.parse(o.text);
  return {
    token: props.TOKEN,
    props,
    sheets: book.sheets,
    portfolioSheets: pf.sheets,
    opened,
    get: parameter => parse(ctx.doGet({ parameter })),
    post: (body, parameter = {}) => parse(ctx.doPost({ postData: { contents: JSON.stringify(body) }, parameter })),
    setupSakura: () => { ctx.setupSakura(); return props.SAKURA_TOKEN; },
    // 人が表を直接書き換える(見出しの名前で)
    edit: (kind, id, col, value) => {
      const rows = book.sheets.get(kind).rows;
      const head = rows[0];
      const r = rows.find((row, i) => i > 0 && row[head.indexOf('id')] === id);
      r[head.indexOf(col)] = value;
    },
    removeRow: (kind, id) => {
      const rows = book.sheets.get(kind).rows;
      const head = rows[0];
      const i = rows.findIndex((row, k) => k > 0 && row[head.indexOf('id')] === id);
      rows.splice(i, 1);
    },
    rowOf: (kind, id) => {
      const rows = book.sheets.get(kind).rows;
      const head = rows[0];
      const r = rows.find((row, i) => i > 0 && row[head.indexOf('id')] === id);
      return r ? Object.fromEntries(head.map((h, i) => [h, r[i]])) : null;
    },
  };
}
