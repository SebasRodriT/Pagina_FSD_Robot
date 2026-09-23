// Service worker.
//  - Archivos propios: red primero, caché como respaldo (siempre la versión más
//    nueva si hay internet; funciona sin conexión en el campo).
//  - MediaPipe (librería, wasm y modelo): caché primero. Son archivos con versión
//    fija que no cambian, así que la segunda vez el modo gestos arranca al instante.
const CACHE = 'robot-fsd-v3';
const MP_CACHE = 'robot-fsd-mediapipe-v1';
const ASSETS = [
  './', 'index.html', 'minimo.html', 'bitacora.html', 'css/styles.css',
  'js/app.js', 'js/ble.js', 'js/voice.js', 'js/mp.js', 'js/gestures.js', 'js/face.js',
  'icon.svg', 'manifest.webmanifest',
];
const IMMUTABLE = [
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@',
  'https://storage.googleapis.com/mediapipe-models/',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== MP_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  if (IMMUTABLE.some((p) => req.url.startsWith(p))) {
    e.respondWith(
      caches.open(MP_CACHE).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  if (new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req))
  );
});
