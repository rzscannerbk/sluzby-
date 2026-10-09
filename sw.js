// Služby MP Blansko – service worker
// Klepnutí na notifikaci – zaregistrováno PŘED knihovnou Firebase, aby se použilo i pro zprávy FCM.
// Odkaz „?open=vymeny“ otevře okno výměn: běžící stránce pošle zprávu, jinak ji otevře s parametrem.
self.addEventListener("notificationclick", e => {
  const n = e.notification, d = n.data || {}, f = d.FCM_MSG;
  const link = f ? ((f.fcmOptions && f.fcmOptions.link) || (f.notification && f.notification.click_action)) : d.link;
  e.stopImmediatePropagation();
  n.close();
  const url = new URL(link || "./", self.registration.scope);
  const open = url.searchParams.get("open");
  e.waitUntil(clients.matchAll({type:"window", includeUncontrolled:true}).then(list => {
    const mine = list.filter(c => c.url.startsWith(self.registration.scope));
    const w = mine.find(c => c.focused) || mine.find(c => !c.url.includes("desktop")) || mine[0];
    if (w){
      if (open) w.postMessage({type:"open", open, t:url.searchParams.get("t")});
      return w.focus ? w.focus() : null;
    }
    return clients.openWindow(url.href);
  }));
});

// --- notifikace (Firebase Cloud Messaging) ---
self.window = self; // firebase-config.js zapisuje do window
try {
  importScripts(
    "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js",
    "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js",
    "./firebase-config.js"
  );
  const cfg = self.FIREBASE_CONFIG;
  if (cfg && cfg.apiKey && cfg.apiKey !== "DOPLNIT"){
    firebase.initializeApp(cfg);
    firebase.messaging(); // zprávy s „notification“ zobrazí knihovna sama
  }
} catch (e) { /* bez notifikací stránka funguje dál */ }



// Při každé změně souborů zvyš verzi, aby se stará cache smazala.
const VERSION = "sluzby-v87";
const LIB_CACHE = "sluzby-knihovny";
const CORE = [
  "./",
  "./index.html",
  "./desktop.html",
  "./sluzby-core.js",
  "./sluzby-core.js?v=4.46",
  "./sluzby-chat.js",
  "./sluzby-chat.js?v=4.56",
  "./firebase-config.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./badge-96.png",
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
