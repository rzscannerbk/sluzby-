// Služby MP Blansko – service worker
// Při každé změně souborů zvyš verzi, aby se stará cache smazala.
const VERSION = "sluzby-v6";
const LIB_CACHE = "sluzby-knihovny";
const CORE = [
  "./",
  "./index.html",
  "./firebase-config.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./maskable-512.png",
  "./apple-touch-icon.png"
];
// písma a knihovny Firebase – z cache, na pozadí obnovit
const LIB_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "www.gstatic.com"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== LIB_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (LIB_HOSTS.includes(url.hostname)){
    e.respondWith(caches.open(LIB_CACHE).then(async cache => {
      const hit = await cache.match(req);
      const net = fetch(req).then(res => { if (res.ok || res.type === "opaque") cache.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }

  // vlastní soubory: nejdřív síť, bez signálu z cache
  // (data z Firestore sem nepatří – ta si offline ukládá Firestore sám)
  if (url.origin === self.location.origin){
    e.respondWith(
      fetch(req).then(res => {
        if (res.ok){ const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
        return res;
      }).catch(async () => (await caches.match(req)) || (req.mode === "navigate" ? caches.match("./index.html") : Response.error()))
    );
  }
});
