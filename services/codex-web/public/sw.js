/**
 * Service Worker：只做一件事 —— 把 PWA 的静态素材（清单、图标）缓存起来，
 * 让应用可以"添加到主屏幕"并以独立窗口打开。
 *
 * 故意**不缓存**页面和接口：
 *   - `/` 永远走网络：这个项目改前端很频繁，缓存页面等于给自己制造"改了不生效"。
 *   - `/api/*` 是聊天流，缓存没有任何意义。
 */
const CACHE = "codex-web-static-v1";
const ASSETS = [
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/" || url.pathname === "/index.html") return;   // 页面走网络
  if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") return;

  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req)),
  );
});
