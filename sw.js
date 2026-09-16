"use strict";

// Replaced with the commit SHA at deploy time (see .github/workflows/pages.yml)
// so that every deploy ships a byte-different service worker — otherwise the
// browser sees no update and offline visitors keep the old precache forever.
const BUILD_VERSION = "__BUILD_VERSION__";

const CACHE_NAME = `ble-uart-webapp-${BUILD_VERSION}`;

// The versioned URLs must match the ones index.html requests, so that both
// files are stamped from the same commit at deploy time.
const PRECACHE_URLS = [
  "./",
  "index.html",
  `css/style.css?v=${BUILD_VERSION}`,
  `js/app.js?v=${BUILD_VERSION}`,
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

  // Navigations skip the HTTP cache. An index.html a few minutes old paired
  // with freshly fetched scripts is a version mismatch, and the page cannot
  // recover from one on its own.
  const networkRequest =
    request.mode === "navigate"
      ? new Request(request.url, { cache: "no-store", credentials: "same-origin" })
      : request;

  event.respondWith(
    fetch(networkRequest)
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
