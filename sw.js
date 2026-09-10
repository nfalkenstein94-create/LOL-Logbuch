/* Arena Logbuch – Service Worker
   HTML kommt aus dem Netz (mit Rückfall auf den Zwischenspeicher),
   alles andere aus dem Zwischenspeicher und wird im Hintergrund erneuert.
   Dadurch bekommt ihr neue Fassungen automatisch – die App meldet sich,
   sobald eine bereitsteht. */
const VERSION = 'arena-logbuch-v5';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './firebase-config.js',
  './icon-180.png', './icon-192.png', './icon-512.png', './icon-maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => Promise.all(
    ASSETS.map(u => c.add(u).catch(() => null))
  )));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function fromNetwork(req, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(req).then(res => { clearTimeout(t); resolve(res); }, err => { clearTimeout(t); reject(err); });
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // Firebase & Schriften direkt durchlassen

  const isDoc = req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('index.html') || url.pathname.endsWith('firebase-config.js');

  if (isDoc) {
    e.respondWith(
      fromNetwork(req, 3500)
        .then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {}); return res; })
        .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
