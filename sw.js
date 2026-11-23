/* APOTEK PWA SW v1.4.9 — mutable shell assets are network-first; never cache API/auth responses. */
const CACHE='apotek-pwa-shell-v1.4.9-4.8';
const ASSETS=['./','./index.html','./app.html','./offline.html','./manifest.webmanifest','./pwa-config.js','./api-bridge.js','./diagnostics.html','./production-check.html'];
const MUTABLE=new Set(['app.html','index.html','pwa-config.js','api-bridge.js']);
self.addEventListener('install',event=>event.waitUntil((async()=>{
 const cache=await caches.open(CACHE);
 // Install the shell opportunistically; a transient asset failure must not block activation.
 await Promise.all(ASSETS.map(async asset=>{try{const response=await fetch(asset,{cache:'no-store'});if(response.ok)await cache.put(asset,response);}catch(_){}}));
 await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
 const keys=await caches.keys();
 await Promise.all(keys.filter(key=>key.startsWith('apotek-pwa-shell-')&&key!==CACHE).map(key=>caches.delete(key)));
 await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
 const request=event.request;
 if(request.method!=='GET')return;
 const url=new URL(request.url);
 if(url.origin!==self.location.origin)return;
 if(url.pathname.endsWith('/api')||url.searchParams.has('token'))return;
 const file=url.pathname.split('/').pop()||'index.html';
 const isMutable=MUTABLE.has(file);
 if(request.mode==='navigate'||isMutable){
  event.respondWith((async()=>{
   const cache=await caches.open(CACHE);
   try{
    const response=await fetch(request,{cache:'no-store'});
    if(response&&response.ok){const key=isMutable?('./'+file):request;await cache.put(key,response.clone());}
    return response;
   }catch(error){
    const hit=await caches.match(request)||await caches.match('./'+file)||await caches.match('./app.html')||await caches.match('./offline.html');
    if(hit)return hit;
    throw error;
   }
  })());
  return;
 }
 event.respondWith(caches.match(request).then(hit=>hit||fetch(request)));
});
