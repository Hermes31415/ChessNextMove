// ChessNext service worker — offline app shell + fresh navigations.
// Network-first for the page (dev-friendly), cache-first for assets.
const CACHE = 'chessnext-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll([
      './', './index.html', './chess.min.js',
      './manifest.webmanifest', './apple-touch-icon.png',
      './icons/icon-192.png', './icons/icon-512.png'
    ])).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // let external APIs pass through
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => { cachePut(e.request, res.clone()); return res; })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request).then((res) => {
      cachePut(e.request, res.clone());
      return res;
    }))
  );
});

function cachePut(request, response) {
  if (response && response.ok) caches.open(CACHE).then((c) => c.put(request, response));
}
