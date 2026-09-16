"use strict";

// Replaced with the commit SHA at deploy time (see .github/workflows/pages.yml)
// so that every deploy ships a byte-different service worker — otherwise the
// browser sees no update and offline visitors keep the old precache forever.
const BUILD_VERSION = "__BUILD_VERSION__";

const CACHE_NAME = `ble-uart-webapp-${BUILD_VERSION}`;

const PRECACHE_URLS = [
  "./",
  "index.html",
  "css/style.css",
  "js/app.js",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];

// Deliberately no skipWaiting() here: a new worker stays in "waiting" until
// the page asks for it. Taking over mid-session would mean reloading the page
// to avoid mixing versions, and a reload drops the live BLE connection.
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
});

// The page sends this once the user accepts the update.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)))
      )
      .then(() => self.clients.claim())
  );
});

// Network-first so a deploy is picked up immediately; the cache is only
// a fallback for offline use.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) => {
          if (cached) return cached;
          return request.mode === "navigate" ? caches.match("./") : Response.error();
        })
      )
  );
});
