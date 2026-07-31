/* sw.js —— 极简离线缓存（network-first，避免开发期旧缓存） */
const CACHE = "dance-wb-v44";
const CORE = ["./index.html", "./style.css", "./js/vendor/qrcode.min.js", "./js/vendor/ffmpeg/ffmpeg.js", "./js/vendor/ffmpeg/814.ffmpeg.js", "./js/util.js", "./js/store.js", "./js/player.js", "./js/favorites.js", "./js/calendar.js", "./js/split.js", "./js/home.js", "./js/app.js", "./manifest.webmanifest", "./icon.svg", "./cover.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  // API 与媒体代理不缓存
  if (req.url.includes("/api/")) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
  );
});
