/* Just enough service worker to make this installable, and to let the page open
 * when the server is not running yet.
 *
 * Deliberately network-FIRST for the app's own files. A worker that serves the
 * cached copy first is how you edit something, reload, and see no change — a
 * miserable way to work on a tool you are meant to be able to edit. The cache is
 * only a fallback for when the network is not there.
 *
 * Nothing under /api is ever cached: those are real jobs running on your own
 * computer, and a stale answer would be worse than no answer.
 */
const CACHE = 'gif-lab-shell-v1';
const SHELL = ['/', '/index.html', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('/index.html'))),
  );
});
