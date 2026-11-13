# 株主優待メモ 仕様 v0.1

2026-11-13 版。読書メモ(tadamasa/reading-memo)の構成を下敷きにする。

## 1. 目的

保有51銘柄について、次の三つを一か所で管理する。

1. 優待マスタ: 優待の有無・種類・内容・条件(株数・保有期間)・権利確定月・届く時期・有効期限の目安・公式ページ・確認日・状況。
2. 受取・使用: 実際に届いた優待と、その使用期限・使用状況。
3. 特典・キャンペーン: 応募しないともらえない株主特典と、その締切・条件・応募方法・応募ステータス。

この機能で本人に感じてほしいこと: **届いた贈り物を、取りこぼさず気持ちよく受け取りきれる**。点数・連続記録・通知・「損している」表示は置かない。

## 2. 構成

| 層 | 選んだもの |
|---|---|
| 配信 | GitHub Pages(main / root)。公開されるのは画面とプログラムだけで、中身・ハブURL・合言葉はシートと端末にしかない |
| 画面 | ビルドなしの ES Modules、ハッシュでのルーティング、相対パスのみ。外部の文字は必ずエスケープ。外部CDN・外部フォントなし |
| 見た目 | Apple HIG 近似のトークンと部品(読書メモと共通)+主題「熨斗紙と水引」 |
| データ | IndexedDB(`yutai-memo`)。ストア benefits / receipts / campaigns(同期)、holdings(読むだけ)、meta |
| 同期 | スプレッドシート「株主優待ハブ」+ Apps Script(hub/Code.gs) |
| オフライン | sw.js(ネット優先→キャッシュ、`cache: 'no-cache'`、キャッシュ名 `yutai-memo-<VERSION>`) |

## 3. データ

### 3.1 正本の場所

| データ | 正本 | アプリでの扱い |
|---|---|---|
| 保有銘柄・株数 | ポートフォリオ(id `15s_YBYs…`)のタブ「保有株式」。見出し3行目、データ4行目から。A=証券コード、B=銘柄名、D=株数(F=現在株価) | ハブの `action=holdings` で読むだけ。証券コードで結合し、ハブには複製しない |
| 優待マスタ | 株主優待ハブ(id `1CCEWH7G…`)のタブ `benefits` | 同期 |
| 受取・使用 | 同 `receipts` | 同期 |
| 特典 | 同 `campaigns` | 同期 |

### 3.2 列

`benefits`: id, code, company_name, has_benefit, benefit_category, benefit_detail, tiers, record_dates, arrival_timing, validity_note, official_url, checked_at, benefit_status, memo, rev, mtime, deleted
`receipts`: id, code, company_name, benefit_name, fiscal_year, received_at, expires_at, status, used_at, memo, rev, mtime, deleted
`campaigns`: id, code, company_name, title, deadline, conditions, apply_route, apply_url, status, memo, rev, mtime, deleted

- id: benefits は `ben-<証券コード>`(1銘柄1行)。receipts は `rcp-<コード>-<時刻36進+乱数>`、campaigns は `camp-<コード>-…`。端末で採番する。
- rev: ハブが振る通し番号。端末は送らない。
- mtime: 最後に書いた時刻(ISO 8601)。初期データは `2026-11-13`(日付だけ=その日0時UTC)。
- deleted: 表では `0` / `1`、アプリと API では `false` / `true`。
- 日付の列(checked_at, received_at, expires_at, used_at, deadline)は `YYYY-MM-DD`。

### 3.3 選択肢(js/words.js)

- has_benefit: あり / なし / 要確認(既定)
- benefit_category(候補、自由入力可): 自社製品、食事券、買物券・割引券、QUOカード、カタログギフト、ポイント、乗車券・航空券、施設利用券、寄付・社会貢献、抽選・イベント、その他
- benefit_status(候補、自由入力可): 継続、新設、内容変更、拡充、縮小、廃止予定、廃止、休止
- receipts.status: 未使用(既定)/ 一部使用 / 使用済 / 失効。「使用済」にしたとき used_at が空なら今日を入れる
- campaigns.status: 未確認(既定)/ 応募予定 / 応募済 / 当選 / 落選 / 見送り / 対象外

### 3.4 初期データ(seed.json)

2026-11-13 に株主優待ハブとポートフォリオを読み取って作成。holdings 51件(code, name, shares, price)、benefits 51件(すべて has_benefit=要確認、rev=1、mtime=2026-11-13)、receipts 0件、campaigns 1件(camp-9434-bleague2027、ソフトバンク B.LEAGUEオールスター観戦特典、期限 2026-11-17)。テストで、ハブの初期状態の pull 結果と一致することを確かめている。

初回起動時(meta `seededAt` がなく、ストアが空のとき)だけ読み込む。初期データは同期の「未送信」には載せない(ハブと同じ中身なので)。

## 4. ハブ(hub/Code.gs)

読書メモの hub/Code.gs と同じ同期プロトコル。違いは、表そのものが正(json 列なし)で、表の直接編集を拾うこと。

| 口 | 内容 |
|---|---|
| `GET action=ping` | `{ ok: true, app: "yutai-hub" }`。合言葉不要 |
| `GET action=pull&since=<rev>&token=` | since より新しい行を rev 順に最大400件。`more` で続きを知らせ、`rev` が次の since |
| `GET action=holdings&token=` | ポートフォリオ「保有株式」を読み取り専用で返す |
| `POST { token, benefits, receipts, campaigns }` | id で upsert。表の mtime 以上の古さの書き込みは捨てる(`skipped`)、その行の表の今の中身を `current` で返す。deleted は墓標 |

- 合言葉は二本立て: `TOKEN`(端末用、`setup` で発行)と `SAKURA_TOKEN`(さくら用、`setupSakura` で発行)。SAKURA_TOKEN では削除を受け付けない。
- 排他: LockService のスクリプトロック(20秒)。
- 表の直接編集: 同期のたびに、各行の指紋(rev・mtime を除く列のハッシュ)を台帳 `_sync`(kind, id, rev, hash, gone)と比べる。違えば新しい rev と mtime=今 を振る。id のない行には id を振る。表から消えた行は gone として削除を流す。初回は表の rev(=1)をそのまま採用し、書き換えない。
- 列は見出しの名前で読み書きし、ハブが書くのは自分の列だけ(人が足した列や数式は残る)。書く範囲は書式なしテキスト。
- ポートフォリオの id はスクリプト プロパティ `PORTFOLIO_ID` で上書きできる。

## 5. 同期(js/sync.js)

1. 端末で書くと(db.put / db.del)、その id を「未送信」に記録し、4秒後に同期する。開いたとき・アプリに戻ったとき(visibilitychange)にも同期する。
2. 同期は、未送信を POST で送る(200件ずつ)→ `pull` を more がなくなるまで → `holdings` で保有株式を取り直す、の順。
3. POST で捨てられた行(`skipped`)は、応答の `current` で手元を表に合わせる(端末の cursor がその行の rev を越えていても取りこぼさない)。
4. 受け取った行は、手元の未送信や手元の行のほうが mtime が新しければ捨てる。削除は手元から消す。受け取った書き込みは silent にして送り返さない。
5. 接続時は `ping` で `yutai-hub` であることを確かめる(読書ハブのURLを入れる取り違えを防ぐ)。
6. `holdings` の取得に失敗したときは手元の一覧をそのまま使う。成功して空の一覧が返ったときは、全部売ったものとして空にする。

## 6. 画面

### 6.1 優待(#benefits)

- 暦帯: 1〜12月。record_dates から読み取った権利確定月の銘柄数を点で示す(3つまで、それ以上は数)。今月は金字。押すとその月で絞り込み、もう一度押すと解除。
- 検索: 証券コード・銘柄名・種類・内容・条件・メモ・状況。空白区切りで AND。全角半角は区別しない。日本語の変換中も入力が途切れないよう、一覧だけを差し替える。
- 絞り込み: すべて / あり / 要確認 / なし(件数つき)。並び: コード順 / 名前順 / 権利確定が近い順。絞り込みと並びは端末に覚える。
- 各行: 銘柄名(明朝)、優待バッジ、コード・株数・権利確定月、種類と内容(2行)、条件(2行)。ハブにあってポートフォリオにない銘柄は「保有なし」で薄く出す。
- record_dates の読み取り: 「3月末・9月末」「3・9月」「6月, 12月末日」「2027-03-31」「毎年１２月末」などから月を取り出す。

### 6.2 銘柄の詳細(#benefit/<code>)

- 株数・確認日、公式ページを開く(なければ「優待を検索する」= Google 検索)。
- 優待の有無(三択)と、benefits の全項目の編集フォーム。確かめた日に「今日」ボタン。URL は http(s) だけ受け付ける。
- その銘柄の受取と特典、「受取を記録」「特典を追加」(銘柄を選んだ状態で開く)。

### 6.3 受取・使用(#receipts, #receipt/<id>, #receipt/new/<code>)

- 並び: 使い終えていないものを使用期限の近い順(期限切れも含む)→ 期限なし(届いた日の新しい順)→ 使用済・失効(使った日の新しい順)。
- 強調: 期限切れ=紅の帯と「期限切れ」、30日以内=金の帯と「あと◯日」。上部に件数の札。
- 表示の切り替え: 使える / 使い終えた / すべて。
- フォーム: 銘柄(保有+優待マスタから選ぶ)、優待の名前、何期の分、届いた日(既定=今日)、使用期限、状態、使った日、メモ。削除は確認のうえ。

### 6.4 特典(#campaigns, #campaign/<id>, #campaign/new/<code>)

- 札(カード): 会社名・特典名・応募期限・条件・応募の方法・メモ、右の半券に残り日数(あと◯日 / 今日が締切 / ◯日前に締切)。7日以内と当日は紅。
- 応募ステータスは札の上で直接変えられ、すぐ同期に載る。応募ページへのリンク。
- 並び: 動けるもの(締切前、かつ 応募済/当選/落選/見送り/対象外 でない)を締切の近い順。終わったものは「終わった特典」に畳む。

### 6.5 設定(#settings)

- 株主優待ハブ: URL、合言葉、接続して同期する / 今すぐ同期 / 同期をやめる、最終同期日時、未送信件数、保有株数の更新日時。
- バックアップ: JSON を共有シートへ(合言葉と同期の状態は除く)。読み込みは id ごとに mtime の新しい方を残し、取り込んだ分はハブにも送る。
- 使い方の物語、件数。

## 7. PWA

- manifest: name 株主優待メモ、short_name 優待メモ、start_url `./#benefits`、scope `./`、standalone、アイコン 180/192/512 と maskable。
- index.html: apple-mobile-web-app-* の meta、viewport-fit=cover、theme-color(ライト/ダーク)。
- Safari のタブで開いたときは「ホーム画面のアイコンから開いて」と警告する(タブとホーム画面アプリは保存場所が別)。

## 8. テスト

`npm test`(node --test)。

- 計算: 日数、権利確定月の読み取り、結合と絞り込み、受取の並び、特典の状態と並び、mtime / deleted の読み方。
- seed.json: 件数、証券コードの一致、列のそろい。
- ハブ: 模擬の SpreadsheetApp で Code.gs をそのまま動かす。ping と認証、初回 pull が seed.json と一致、upsert と古い書き込みの破棄、墓標、さくら用合言葉の削除拒否、表の直接編集・id なし行・行の削除の検出、400件ずつの more、holdings の読み取り専用と PORTFOLIO_ID の上書き、空のシートからの setup。
- 画面: Playwright で iPhone 幅(390×844)、ライト/ダークを撮影し、ハブを模擬して接続・編集・受取の追加・ステータス変更が表に届くことを確かめた(開発時の確認で、リポジトリには含めない)。

## 9. まだ確かめていないこと・次の候補

- 本物の Apps Script と iPhone 実機での動作(クラウドの作業環境から Google に届かないため、模擬で確認)。
- 優待利回り(優待の金額換算 ÷ 株価×最低株数)。holdings は株価(price)を返しているので、画面を足すだけで出せる。
- 権利確定月の前月に「暦帯」でその月を目立たせる(通知はしない)。
