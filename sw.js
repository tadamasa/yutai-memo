// アプリ本体をキャッシュして、電波がなくても開けるようにする。ハブ(Apps Script)への通信はキャッシュしない。
// 出すたびに VERSION を上げ、ファイルを足したら SHELL にも足す。
const VERSION = 'v1';
const PREFIX = 'yutai-memo-';
const CACHE = `${PREFIX}${VERSION}`;
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'seed.json',
  'css/hig-tokens.css', 'css/hig-components.css', 'css/app.css',
  'js/app.js', 'js/db.js', 'js/sync.js', 'js/yutai.js', 'js/words.js', 'js/backup.js',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

// 同じ github.io の別アプリのキャッシュは消さない
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// 同じオリジンのファイルは「ネット優先、だめならキャッシュ」。
// GitHub Pages は約10分ブラウザにキャッシュさせるので、{ cache: 'no-cache' } で毎回サーバーに確かめる。
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
