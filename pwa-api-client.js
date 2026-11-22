/* APOTEK PWA API Client v1.1
 * Uses hidden iframe + form POST (simple cross-origin form; no CORS fetch).
 * Credentials are posted in the body, never in query strings or SW cache.
 */
(() => {
  "use strict";
  const pending = new Map();
  const gasUrl = String(window.APOTEK_PWA_CONFIG?.gasWebAppUrl || "");
  const origin = location.origin;
  const validGas = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(gasUrl);
  const id = () => (crypto?.randomUUID ? crypto.randomUUID().replace(/-/g,"") : "pwa"+Date.now()+Math.random().toString(36).slice(2));

  function ensureTransport() {
    if (!validGas) throw new Error("URL Web App Apps Script belum dikonfigurasi.");
    if (!navigator.onLine) throw new Error("Koneksi internet tidak tersedia.");
  }
  function api(fn, args, token, options={}) {
    ensureTransport();
    if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,99}$/.test(String(fn))) return Promise.reject(new Error("Nama metode tidak valid."));
    const requestId=id();
    const frame=document.createElement("iframe");
    frame.name="apotek_pwa_api_"+requestId;
    frame.hidden=true;
    frame.setAttribute("aria-hidden","true");
    const form=document.createElement("form");
    form.method="POST"; form.action=gasUrl; form.target=frame.name;
    form.acceptCharset="UTF-8"; form.style.display="none";
    const fields={mode:"pwa_api",origin,requestId,fn:String(fn),args:JSON.stringify(args||[]),token:String(token||"")};
    Object.entries(fields).forEach(([name,value])=>{
      const input=document.createElement("input"); input.type="hidden"; input.name=name; input.value=value; form.appendChild(input);
    });
    return new Promise((resolve,reject)=>{
      let done=false;
      const timeout=setTimeout(()=>finish(new Error("Timeout menunggu respons Apps Script.")),Number(options.timeoutMs)||60000);
      function finish(error,value){
        if(done)return; done=true; clearTimeout(timeout); window.removeEventListener("message",onMessage);
        try{form.remove();frame.remove();}catch(_){}
        pending.delete(requestId);
        error?reject(error):resolve(value);
      }
      function onMessage(event){
        if(event.source!==frame.contentWindow) return;
        if(!(event.origin==="https://script.google.com" ||
          (event.origin.startsWith("https://") && event.origin.includes("script") && event.origin.endsWith(".googleusercontent.com")))) return;
        const msg=event.data;
        if(!msg||msg.channel!=="APOTEK_PWA_API_V1"||msg.requestId!==requestId)return;
        if(!msg.result||msg.result.ok!==true) return finish(new Error(msg.result?.message||"API Apps Script gagal."));
        finish(null,msg.result.data);
      }
      pending.set(requestId,{finish});
      window.addEventListener("message",onMessage);
      document.body.append(frame,form);
      form.submit();
    });
  }
  window.ApotekPWAApi = Object.freeze({api, isConfigured:()=>validGas});
})();
