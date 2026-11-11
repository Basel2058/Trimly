// Service worker: keeps the app opening on a weak or missing connection, and shows push notifications.
// Strategy: always try the network first (so updates arrive without any version juggling),
// fall back to the last good copy when the network is slow or down.
const CACHE = 'trimly-shell-v1';
const SHELL = ['/', '/barber', '/app.css', '/js/ui.js', '/js/i18n.js', '/js/customer.js', '/js/barber.js', '/js/i18n-barber.js', '/js/barber-settings.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function cacheKey(url) {
  // every customer path (/a/<token>, /) is the same page; never store a private link as a key
  if (url.pathname === '/' || url.pathname.startsWith('/a/')) return '/';
  if (url.pathname === '/barber' || url.pathname === '/barber/') return '/barber';
  return url.pathname;
}

async function networkFirst(request, key) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(key);
  const fromNet = fetch(request).then((res) => {
    if (res.ok && res.type === 'basic') cache.put(key, res.clone()).catch(() => {});
    return res;
  });
  if (!cached) return fromNet;
  // a slow network must not make the app feel broken: after 3s use the saved copy
  const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), 3000));
  return Promise.race([fromNet.catch(() => cached), timeout]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.endsWith('.webmanifest') || url.pathname === '/sw.js') return;
  if (req.mode === 'navigate' || /\.(js|css|png|svg)$/.test(url.pathname)) {
    e.respondWith(networkFirst(req, cacheKey(url)));
  }
});

self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = {};
  }
  e.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title || 'Trimly', {
        body: data.body || '',
        tag: data.tag || undefined,
        icon: '/icons/icon-192.png',
        badge: '/icons/badge.png',
        data: { url: data.url || '/barber' },
      }),
      // an open dashboard refreshes itself immediately
      self.clients.matchAll({ type: 'window' }).then((list) => list.forEach((c) => c.postMessage({ type: 'push' }))),
    ]),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/barber';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (new URL(c.url).pathname.startsWith('/barber')) return c.focus().then(() => c.postMessage({ type: 'push' }));
      }
      return self.clients.openWindow(target);
    }),
  );
});
