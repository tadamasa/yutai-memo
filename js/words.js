// 画面の言葉と選択肢。言い回しを直すときはここだけを触る。

export const APP = '株主優待メモ';

export const TABS = { benefits: '優待', receipts: '受取・使用', campaigns: '特典', settings: '設定' };

export const HAS = ['あり', 'なし', '要確認'];

// 優待の種類(自由に書けるが、よく使うものを候補に出す)
export const CATEGORIES = ['自社製品', '食事券', '買物券・割引券', 'QUOカード', 'カタログギフト', 'ポイント', '乗車券・航空券', '施設利用券', '寄付・社会貢献', '抽選・イベント', 'その他'];
export const BENEFIT_STATUS = ['継続', '新設', '内容変更', '拡充', '縮小', '廃止予定', '廃止', '休止'];

export const RECEIPT_STATUS = ['未使用', '一部使用', '使用済', '失効'];
export const CAMPAIGN_STATUS = ['未確認', '応募予定', '応募済', '当選', '落選', '見送り', '対象外'];

// 表の列の見出し(フォームのラベル)
export const LABEL = {
  has_benefit: '優待',
  benefit_category: '種類',
  benefit_detail: '内容',
  tiers: '条件(株数・保有期間)',
  record_dates: '権利確定',
  arrival_timing: '届く時期',
  validity_note: '有効期限の目安',
  official_url: '公式ページ',
  checked_at: '確かめた日',
  benefit_status: '状況',
  memo: 'メモ',
  code: '銘柄',
  benefit_name: '優待の名前',
  fiscal_year: '何期の分',
  received_at: '届いた日',
  expires_at: '使用期限',
  status: '状態',
  used_at: '使った日',
  title: '特典',
  deadline: '応募期限',
  conditions: '条件',
  apply_route: '応募の方法',
  apply_url: '応募ページ',
};

export const PLACEHOLDER = {
  benefit_detail: '例: 食事優待券 1冊(6枚綴り)',
  tiers: '例: 100株以上 1冊 / 300株以上 3冊\n長期保有(1年以上)で増量',
  record_dates: '例: 6月末・12月末',
  arrival_timing: '例: 3月下旬・9月下旬',
  validity_note: '例: 発行から約半年',
  official_url: 'https://…',
  memo: '気づいたこと、使い道の案など',
  benefit_name: '例: 食事優待券',
  fiscal_year: '例: 2026年6月',
  title: '例: 観戦招待',
  conditions: '例: 9月末に5,000株以上',
  apply_route: '例: 公式LINEから応募',
};

export const EMPTY = {
  benefits: '条件に合う銘柄はありません。',
  receiptsOpen: 'いま使える優待の記録はありません。届いたら「＋」から記録します。',
  receiptsUsed: '使い終えた記録はまだありません。',
  campaigns: '応募できる特典はいまありません。',
  ribbon: '権利確定月が入ると、ここに一年の暦が浮かびます。',
};

// 設定に置く物語(このアプリをどう使うか)
export const STORY = [
  '株主優待は、株を持っていることへの小さな贈り物です。けれど届く時期も、使える期限も、応募のしかたも銘柄ごとにばらばらで、気づくと引き出しの奥で期限が切れていたりします。',
  '「優待」では、持っている銘柄に優待があるのか、いつ権利が確定し、いつ届くのかを書きとめます。最初はすべて「要確認」です。公式ページで確かめたら、内容と権利確定月を入れてください。上の暦に、その月の印が灯ります。',
  '封筒が届いたら「受取・使用」に記録します。使用期限の近いものから並び、30日を切ると金色に、過ぎると紅色になります。使ったら「使用済」に。',
  '「特典」には、応募しないともらえない株主特典(観戦招待や抽選など)を置きます。残りの日数が大きく出るので、締切の前に気づけます。',
  '書いた内容はこの端末に保存され、株主優待ハブ(自分のスプレッドシート)とつないでおけば、ほかの端末やほかのAIとも同じものを見られます。株数はポートフォリオのシートから読むだけで、ここでは書き換えません。',
];
