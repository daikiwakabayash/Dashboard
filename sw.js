// NAORU ダッシュボード Service Worker
// 目的: (1) PWAインストール可能化 (2) Webプッシュ通知の受信・クリック処理
// ⚠️ HTML/JS はキャッシュしない（常に最新をネットワークから取得＝古いビルドが残らない）。
//     fetch はパススルーのみ。オフライン対応は行わない。
const SW_VERSION = 'naoru-sw-v1';

self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

// パススルー（キャッシュしない）。インストール可能要件のために fetch ハンドラだけ置く。
self.addEventListener('fetch', () => {});

// プッシュ受信 → 通知表示
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
  event.waitUntil(self.registration.showNotification(title, options));
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
