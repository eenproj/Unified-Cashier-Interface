/* APOTEK PWA SW v1.4 — static shell only; never cache API/authenticated responses. */
const CACHE='apotek-pwa-shell-v1.4.4-4.5';
const ASSETS=['./','./index.html','./app.html','./offline.html','./manifest.webmanifest','./pwa-config.js','./api-bridge.js','./diagnostics.html','./production-check.html'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('apotek-pwa-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==self.location.origin)return;if(u.pathname.endsWith('/api')||u.searchParams.has('token'))return;if(e.request.mode==='navigate'){e.respondWith(fetch(e.request).catch(()=>caches.match(e.request).then(hit=>hit||caches.match('./app.html')||caches.match('./offline.html'))));return;}e.respondWith(caches.match(e.request).then(hit=>hit||fetch(e.request)));});
