// NAORU ダッシュボード Service Worker
// 目的: (1) PWAインストール可能化 (2) Webプッシュ通知の受信・クリック処理
// ⚠️ HTML/JS はキャッシュしない（常に最新をネットワークから取得＝古いビルドが残らない）。
//     fetch はパススルーのみ。オフライン対応は行わない。
const SW_VERSION = 'naoru-sw-v1';

self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

// パススルー（キャッシュしない）。インストール可能要件のために fetch ハンドラだけ置く。
self.addEventListener('fetch', () => {});

// ── アプリアイコンのバッジ（未読の赤丸＋数字） ──
// SWは再起動でメモリが消えるため、件数は Cache Storage に保存して永続化する。
// 開いている間はクライアントが正確な合計を postMessage で同期し、閉じている間は
// プッシュ受信ごとに +1 する（次にアプリを開くと正確な値に補正される）。
async function readBadge() {
  try { const c = await caches.open('naoru-badge'); const r = await c.match('count'); return r ? (Number(await r.text()) || 0) : 0; } catch (_) { return 0; }
}
async function writeBadge(n) {
  try { const c = await caches.open('naoru-badge'); await c.put('count', new Response(String(Math.max(0, n)))); } catch (_) {}
}
async function applyBadge(n) {
  n = Math.max(0, Number(n) || 0);
  await writeBadge(n);
  try { if (self.navigator && 'setAppBadge' in self.navigator) { if (n > 0) await self.navigator.setAppBadge(n); else await self.navigator.clearAppBadge(); } } catch (_) {}
}

// クライアント（アプリ表示中）から正確な合計を受け取り、バッジ基準を最新化
self.addEventListener('message', (event) => {
  const d = event.data || {};
  if (d.type === 'badge') event.waitUntil(applyBadge(d.count));
});

// プッシュ受信 → 通知表示 ＋ バッジを1件増やす
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { title: 'NAORU', body: (event.data && event.data.text()) || '' }; }
  const title = data.title || 'NAORU ダッシュボード';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.kind === 'chat' ? ('chat-' + (data.roomId || '')) : (data.kind || 'naoru'),
    renotify: true,
    data: { url: data.url || '/' },
  };
  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    const cur = await readBadge();
    await applyBadge(cur + 1);
  })());
});

// 通知クリック → 既存タブがあればフォーカス、なければ開く
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { try { await c.focus(); if ('navigate' in c && url) c.navigate(url); } catch (_) {} return; }
    }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});
