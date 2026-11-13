// バックアップ: 全データをJSONにして、iPhoneの共有シート(「ファイル」に保存→iCloud Drive等)へ渡す。
import * as db from './db.js';
import { ms } from './yutai.js';

// 合言葉と、端末ごとの同期の状態は書き出さない
const SECRET_KEYS = new Set(['syncUrl', 'syncToken', 'syncCursor', 'syncDirty', 'syncLastAt']);
const NAMES = ['holdings', 'benefits', 'receipts', 'campaigns'];

export async function exportData() {
  const [holdings, benefits, receipts, campaigns, meta] = await Promise.all([...NAMES, 'meta'].map(n => db.getAll(n)));
  const payload = {
    app: 'yutai-memo',
    version: 1,
    exportedAt: new Date().toISOString(),
    holdings, benefits, receipts, campaigns,
    meta: meta.filter(m => !SECRET_KEYS.has(m.key)),
  };
  const name = `yutai-memo-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
    } catch (e) {
      if (e.name === 'AbortError') return false;
      throw e;
    }
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  await db.setMeta('lastBackupAt', new Date().toISOString());
  return true;
}

// 取り込み: id が同じものは mtime が新しい方を残す。取り込んだ分は同期でハブにも送る
export async function importData(text) {
  const data = JSON.parse(text);
  if (data.app !== 'yutai-memo') throw new Error('このアプリのバックアップファイルではありません');
  let added = 0;
  for (const name of db.SYNCED) {
    const current = new Map((await db.getAll(name)).map(x => [x.id, x]));
    const toPut = (data[name] || []).filter(x => x && x.id && (!current.has(x.id) || ms(x.mtime) > ms(current.get(x.id).mtime)));
    added += toPut.length;
    // mtime を保ったまま書き、同期係には知らせる
    for (const x of toPut) await db.put(name, x, { silent: true });
    if (toPut.length) await db.markDirty(name, toPut);
  }
  if (Array.isArray(data.holdings) && data.holdings.length && !(await db.getAll('holdings')).length) await db.replaceAll('holdings', data.holdings);
  return added;
}
