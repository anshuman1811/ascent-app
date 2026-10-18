// Ascent service worker — offline app shell for the browser.
// • Page loads: network first (so a new deploy is picked up immediately), cached
//   index.html when the server can't be reached.
// • /assets/* (content-hashed JS/CSS/wasm): cache first.
// • /exercises/*, /uploads/*, icons: cache first, filled as they are viewed.
// • /api/* is never touched — offline data comes from the app's local replica.
const SHELL = 'ascent-shell-v1';
const MEDIA = 'ascent-media-v1';

// Cache index.html and the hashed assets it references.
async function precacheShell() {
  const cache = await caches.open(SHELL);
  const res = await fetch('/index.html', { cache: 'reload' });
  if (!res.ok) return;
  await cache.put('/index.html', res.clone());
  const html = await res.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(m => m[1]);
  await Promise.all(assets.map(a => cache.add(a).catch(() => {})));
}

self.addEventListener('install', event => {
  event.waitUntil(precacheShell().catch(() => {}));
  self.skipWaiting();
});

// The page sends what it already loaded before this worker took control (JS, wasm…).
self.addEventListener('message', event => {
  const { type, urls } = event.data || {};
  if (type !== 'precache' || !Array.isArray(urls)) return;
  event.waitUntil((async () => {
    for (const u of urls) {
      if (typeof u !== 'string' || !u.startsWith('/')) continue;
      const cache = await caches.open(u.startsWith('/assets/') ? SHELL : MEDIA);
      if (!(await cache.match(u))) await cache.add(u).catch(() => {});
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== SHELL && key !== MEDIA) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function cacheFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

async function shell(request) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(request);
    if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
      cache.put('/index.html', res.clone());
      // Drop hashed assets the new index.html no longer references.
      res.clone().text().then(async html => {
        for (const req of await cache.keys()) {
          const p = new URL(req.url).pathname;
          if (p.startsWith('/assets/') && !html.includes(p) && !p.endsWith('.wasm')) cache.delete(req);
        }
      }).catch(() => {});
    }
    return res;
  } catch {
    return (await cache.match('/index.html')) || Response.error();
  }
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') { event.respondWith(shell(request)); return; }
  if (url.pathname.startsWith('/assets/')) { event.respondWith(cacheFirst(SHELL, request)); return; }
  if (url.pathname.startsWith('/exercises/') || url.pathname.startsWith('/uploads/') || /\.(svg|png|ico|webmanifest)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(MEDIA, request));
  }
});
