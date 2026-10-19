// Offline support: app files cached on install; pages network-first, other app files cache-first.
const CACHE = 'sr-app-v12';
const FILES = ['./', 'index.html', 'app.css', 'manifest.json', 'icon-192.png', 'icon-512.png',
  'js/app.js', 'js/store.js', 'js/auth.js', 'js/sync.js', 'js/sched.js', 'js/text.js', 'js/lookup.js', 'js/merge.js', 'js/starter.js', 'js/config.js', 'vendor/ts-fsrs.mjs'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || location.hostname === 'localhost') return;
  if (url.origin === location.origin) {
    if (e.request.mode === 'navigate') {
      e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put('./', copy)); return r; }).catch(() => caches.match('./')));
      return;
    }
    e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => {
      const net = fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; });
      return hit || net;
    }));
  } else if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })));
  }
});
