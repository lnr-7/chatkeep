// Offline support: cache the app files, serve from cache first, refresh in the background.
const CACHE = "chatkeep-v1";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./importers.js",
  "./zip.js",
  "./markdown.js",
  "./db.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./fonts/ibm-plex-sans-400.woff2",
  "./fonts/ibm-plex-sans-600.woff2",
  "./fonts/ibm-plex-serif-600.woff2",
  "./fonts/ibm-plex-mono-400.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: true });
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => null);
      if (cached) return cached;
      const fresh = await network;
      if (fresh) return fresh;
      return (await cache.match("./index.html")) || Response.error();
    }),
  );
});
