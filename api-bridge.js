/* APOTEK PWA API Bridge Client v1.5.2 — Scanner Lookup Latency & Failure Classification.
 * Preserves Hotfix 4.14 nested-frame correlation and requestId safeguards.
 * Fast barcode lookup is read-only: no automatic retry and a bounded 15s timeout.
 * Diagnostics contain no credentials, request payloads, or barcode values.
 */
(() => {
  "use strict";
  const cfg = window.APOTEK_PWA_CONFIG || {};
  const endpoint = String(cfg.gasWebAppUrl || "").trim();
  const pending = new Map();
  // Completed requests remain briefly addressable so duplicate gateway deliveries
  // can be ACKed instead of being misclassified as unknown requests.
  const completed = new Map();
  const lateRequests = new Map();
  const COMPLETED_ACK_TTL_MS = 12000;
  const MAX_PENDING_REQUESTS = 8;
  const LOOKUP_SOFT_TIMEOUT_MS = 12000;
  const LOOKUP_HARD_TIMEOUT_MS = 30000;
  const LOOKUP_FRAME_GRACE_MS = 12000;

  let lastDiagnostic = null;
  let refreshPromise = null;
  let restorePromise = null;
  const diagnostics = [];
  const MAX_DIAGNOSTICS = 120;
  let auth = { accessToken:"", refreshToken:"", accessDeadline:0, user:null, tenant:null };

  function record(stage, detail) {
    const item = Object.assign({ tag:"APOTEK_PWA_BRIDGE_DIAG", stage, at:new Date().toISOString() }, detail || {});
    diagnostics.push(item);
    if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.shift();
    lastDiagnostic = item;
    try { console.info("[APOTEK_PWA_BRIDGE]", JSON.stringify(item)); } catch (_) {}
    // Bounded diagnostics survive reloads and contain no credentials or request payloads.
    try { const k="apotek_pwa_bridge_diag_v1"; const a=JSON.parse(localStorage.getItem(k)||"[]"); a.push(item); while(a.length>120)a.shift(); localStorage.setItem(k,JSON.stringify(a)); } catch (_) {}
    return item;
  }
  function trustedGoogleResponseOrigin(origin) {
    try {
      const u = new URL(origin);
      const h = u.hostname.toLowerCase();
      return u.protocol === "https:" && (
        h === "script.google.com" ||
        h === "script.googleusercontent.com" ||
        h.endsWith(".script.googleusercontent.com") ||
        h.endsWith("-script.googleusercontent.com")
      );
    } catch (_) { return false; }
  }
  function validEndpoint(v) {
    return /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(v);
  }
  // Each in-flight request owns a dedicated iframe. Reusing one iframe lets
  // concurrent form submissions navigate over each other's response documents.
  function createFrame(requestId) {
    const frame = document.createElement("iframe");
    frame.name = "apotek_pwa_gateway_" + requestId;
    frame.title = "APOTEK API Gateway";
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.cssText = "position:absolute;width:1px;height:1px;left:-10000px;border:0";
    document.body.appendChild(frame);
    frame.addEventListener("load", () => record("FRAME_LOAD", { frameName:frame.name, requestIdPrefix:requestId.slice(0,12), connected:frame.isConnected, visibility:document.visibilityState }));
    record("FRAME_READY", { frameName:frame.name, requestIdPrefix:requestId.slice(0,12), visibility:document.visibilityState });
    return frame;
  }
  const REFRESH_STORAGE_KEY = "apotek_pwa_refresh_v12_persistent";
  const REFRESH_PENDING_KEY = "apotek_pwa_refresh_pending_v12_persistent";
  const LEGACY_REFRESH_STORAGE_KEY = "apotek_pwa_refresh_v12";
  const LEGACY_PENDING_KEY = "apotek_pwa_refresh_pending_v12";
  // Persistent storage is intentional: the user requested login continuity across
  // closing/reopening the PWA. Server-side refresh expiry remains authoritative (6h).
  function credentialStore() { return window.localStorage; }
  function clearPendingRefresh() {
    try { credentialStore().removeItem(REFRESH_PENDING_KEY); } catch (_) {}
  }
  function readPendingRefresh() {
    try {
      let raw = credentialStore().getItem(REFRESH_PENDING_KEY) || "";
      if (!raw) { raw = sessionStorage.getItem(LEGACY_PENDING_KEY) || ""; if (raw) credentialStore().setItem(REFRESH_PENDING_KEY, raw); }
      if (!raw) return null;
      const value = JSON.parse(raw);
      if (!value || value.version !== 1 || !/^[A-Za-z0-9_-]{16,100}$/.test(String(value.requestId||"")) || typeof value.refreshToken !== "string" || !value.refreshToken) return null;
      if (Date.now() - Number(value.createdAt||0) > 10*60*1000) return null;
      return value;
    } catch (_) { return null; }
  }
  function writePendingRefresh(refreshToken, requestId) {
    try {
      credentialStore().setItem(REFRESH_PENDING_KEY, JSON.stringify({version:1,refreshToken:String(refreshToken),requestId:String(requestId),createdAt:Date.now()}));
      return true;
    } catch (error) {
      record("REFRESH_RECOVERY_MARKER_UNAVAILABLE", {error:String(error && error.message || error).slice(0,120)});
      return false;
    }
  }
  function clearAuthStorage() {
    try { credentialStore().removeItem(REFRESH_STORAGE_KEY); } catch (_) {}
    try { credentialStore().removeItem(LEGACY_REFRESH_STORAGE_KEY); } catch (_) {}
    try { sessionStorage.removeItem(LEGACY_REFRESH_STORAGE_KEY); } catch (_) {}
    try { sessionStorage.removeItem(LEGACY_PENDING_KEY); } catch (_) {}
    clearPendingRefresh();
  }
  function persistRefreshToken(token) {
    try {
      if (token) credentialStore().setItem(REFRESH_STORAGE_KEY, String(token));
      else clearAuthStorage();
    } catch (error) {
      record("SESSION_STORAGE_UNAVAILABLE", { error:String(error && error.message || error).slice(0,120) });
    }
  }
  function makeId() {
    const b = new Uint8Array(24);
    crypto.getRandomValues(b);
    return Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
  }
  function acknowledgeResponse(event, id, duplicate) {
    try {
      if (!event.source || typeof event.source.postMessage !== "function") throw new Error("Response source unavailable");
      event.source.postMessage({ channel:"APOTEK_PWA_GATEWAY_ACK_V1", requestId:id }, event.origin);
      record(duplicate ? "MESSAGE_DUPLICATE_ACKED" : "MESSAGE_ACK_SENT", { requestIdPrefix:id.slice(0,12), origin:event.origin });
      return true;
    } catch (ackError) {
      record("MESSAGE_ACK_FAILED", { requestIdPrefix:id.slice(0,12), origin:event.origin, error:String(ackError && ackError.message || ackError).slice(0,160) });
      return false;
    }
  }
  function settleMessage(event, data) {
    const id = String(data.requestId || "");
    const p = pending.get(id);
    if (!p) {
      const done = completed.get(id);
      if (done && done.expiresAt > Date.now() && done.source === event.source && trustedGoogleResponseOrigin(event.origin)) {
        acknowledgeResponse(event, id, true);
        if (done.origin !== event.origin) record("MESSAGE_DUPLICATE_ORIGIN_CHANGED", { requestIdPrefix:id.slice(0,12), previousOrigin:done.origin, origin:event.origin });
        return;
      }
      const late = lateRequests.get(id);
      if (late && late.expiresAt > Date.now() && trustedGoogleResponseOrigin(event.origin)) {
        acknowledgeResponse(event, id, true);
        lateRequests.delete(id);
        record("MESSAGE_LATE_AFTER_TIMEOUT_ACKED", {requestIdPrefix:id.slice(0,12),method:late.method,elapsedMs:Date.now()-late.startedAt,origin:event.origin,frameConnected:!!(late.frame&&late.frame.isConnected)});
        return;
      }
      record("MESSAGE_UNKNOWN_REQUEST", { requestIdPrefix:id.slice(0,12), origin:event.origin });
      return;
    }
    // HtmlService may execute the response script in a nested sandbox frame.
    // In that case event.source is the nested response window, not the named
    // form-target iframe's contentWindow. Correlate using the unguessable
    // 192-bit requestId plus the strict Google response-origin allowlist.
    if (!trustedGoogleResponseOrigin(event.origin)) {
      record("MESSAGE_REJECTED_ORIGIN", { requestIdPrefix:id.slice(0,12), origin:event.origin });
      return;
    }
    const sourceMatchesFrame = !!(p.frame && p.frame.contentWindow && event.source === p.frame.contentWindow);
    if (!sourceMatchesFrame) {
      record("MESSAGE_SOURCE_NESTED_FRAME_ACCEPTED", { requestIdPrefix:id.slice(0,12), origin:event.origin });
    }
    if (data.result && data.result.code === "GATEWAY_REQUEST_IN_PROGRESS") {
      acknowledgeResponse(event, id, false);
      record("MESSAGE_REQUEST_IN_PROGRESS", { requestIdPrefix:id.slice(0,12), method:p.method, retryAfterMs:Number(data.result.retryAfterMs)||2000, elapsedMs:Date.now()-p.startedAt });
      if (p.retryTimer) clearTimeout(p.retryTimer);
      const delay = Math.max(1000, Math.min(5000, Number(data.result.retryAfterMs)||2000));
      p.retryTimer = setTimeout(() => { if (pending.has(id) && p.submitAttempt && p.attempts < 7) p.submitAttempt(true); }, delay);
      return;
    }
    acknowledgeResponse(event, id, false);
    clearTimeout(p.timer);
    if (p.softTimer) clearTimeout(p.softTimer);
    if (p.retryTimer) clearTimeout(p.retryTimer);
    pending.delete(id);
    // Keep the response frame alive for the backend's bounded retry window.
    // Duplicate deliveries are ACKed above; this avoids noisy UNKNOWN_REQUEST logs.
    const done = { origin:event.origin, source:event.source, frame:p.frame, expiresAt:Date.now()+COMPLETED_ACK_TTL_MS };
    completed.set(id, done);
    setTimeout(() => {
      if (completed.get(id) === done) completed.delete(id);
      if (p.frame && p.frame.isConnected) p.frame.remove();
    }, COMPLETED_ACK_TTL_MS);
    const responseAt=Date.now();
    const bridgeTrace={requestIdPrefix:id.slice(0,12),method:p.method,elapsedMs:responseAt-p.startedAt,attempts:Number(p.attempts)||0,firstSubmitAt:p.firstSubmitAt||null,lastSubmitAt:p.lastSubmitAt||null,responseAt:responseAt,lastMessageStage:p.lastMessageStage||"MESSAGE_RECEIVED",nestedFrameAccepted:!sourceMatchesFrame,gatewayTrace:data.result&&data.result.gatewayTrace||data.result&&data.result.data&&data.result.data._gatewayTrace||null};
    if (!data.result || data.result.ok !== true) {
      const apiCode=String(data.result && data.result.code || "BACKEND_ERROR").slice(0,80);
      record("MESSAGE_API_ERROR", { requestIdPrefix:id.slice(0,12), method:p.method, code:apiCode, elapsedMs:bridgeTrace.elapsedMs, attempts:bridgeTrace.attempts, origin:event.origin });
      const apiError=new Error(String(data.result && data.result.message || "Permintaan API gagal."));apiError.code=apiCode;apiError.bridgeTrace=bridgeTrace;apiError.gatewayTrace=data.result&&data.result.gatewayTrace||null;
      p.reject(apiError);
      return;
    }
    record("MESSAGE_ACCEPTED", { requestIdPrefix:id.slice(0,12), method:p.method, elapsedMs:bridgeTrace.elapsedMs, attempts:bridgeTrace.attempts, nestedFrameAccepted:bridgeTrace.nestedFrameAccepted, origin:event.origin });
    const payload=data.result.data;
    if(payload&&typeof payload==="object"&&!Array.isArray(payload))p.resolve(Object.assign({},payload,{__bridgeTrace:bridgeTrace}));
    else p.resolve(payload);
  }
  window.addEventListener("message", event => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.channel !== "APOTEK_PWA_GATEWAY_V1") return;
    const id = String(data.requestId || "");
    if (!trustedGoogleResponseOrigin(event.origin)) {
      record("MESSAGE_REJECTED_ORIGIN", { requestIdPrefix:id.slice(0,12), origin:String(event.origin || "").slice(0,180) });
      return;
    }
    const active = pending.get(id);
    const done = completed.get(id);
    if (active) active.lastMessageStage = "MESSAGE_RECEIVED";
    else if (done && done.expiresAt > Date.now()) done.lastMessageStage = "MESSAGE_DUPLICATE_RECEIVED";
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(id)) {
      record("MESSAGE_REJECTED_REQUEST_ID", { origin:event.origin });
      return;
    }
    settleMessage(event, data);
  });

  function rawPost(method, args, requestIdOverride) {
    if (!validEndpoint(endpoint)) return Promise.reject(new Error("URL Apps Script belum dikonfigurasi."));
    if (!navigator.onLine) return Promise.reject(new Error("Perangkat sedang offline. API server tidak dapat dipanggil."));
    const id = requestIdOverride || makeId();
    const frame = createFrame(id);
    const isFastBarcodeLookup=String(method)==="getBarcodeProductFast";
    const safeRetryEnabled = !isFastBarcodeLookup; // Lookup is read-only; avoid queue amplification.
    const timeoutMs=isFastBarcodeLookup?15000:60000;
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      let attempts = 0;
      let retryTimer = null;
      const timer = setTimeout(() => {
        if (retryTimer) clearTimeout(retryTimer);
        if (p.retryTimer) clearTimeout(p.retryTimer);
        pending.delete(id);
        if (frame.isConnected) frame.remove();
        record("REQUEST_TIMEOUT_CONTEXT", { requestIdPrefix:id.slice(0,12), method:String(method).slice(0,60), visibility:document.visibilityState, online:navigator.onLine, frameConnected:frame.isConnected, pendingCount:pending.size });
        const elapsedMs=Date.now()-startedAt;
        const trace={requestIdPrefix:id.slice(0,12),method:String(method),elapsedMs:elapsedMs,attempts:attempts,firstSubmitAt:p.firstSubmitAt||null,lastSubmitAt:p.lastSubmitAt||null,responseAt:null,lastMessageStage:p.lastMessageStage||null,visibility:document.visibilityState};
        record("REQUEST_TIMEOUT", { requestIdPrefix:id.slice(0,12), method:String(method).slice(0,60), attempts, elapsedMs:elapsedMs, timeoutMs:timeoutMs, lastMessageStage:p.lastMessageStage || null });
        const timeoutError=new Error(isFastBarcodeLookup?"Pencarian barcode melewati batas waktu tunggu. Status produk belum dapat dipastikan.":"Gateway tidak memberikan respons. Periksa koneksi sebelum mengulangi transaksi.");
        timeoutError.code="GATEWAY_TIMEOUT";timeoutError.bridgeTrace=trace;reject(timeoutError);
      }, timeoutMs);
      const p = { resolve, reject, timer, startedAt, method:String(method), frame, lastMessageStage:null, retryTimer:null, attempts:0, submitAttempt:null, firstSubmitAt:null, lastSubmitAt:null };
      pending.set(id, p);
      function submitAttempt(isRetry) {
        if (!navigator.onLine) return;
        attempts++;
        p.attempts=attempts;
        const submitAt=Date.now();if(!p.firstSubmitAt)p.firstSubmitAt=submitAt;p.lastSubmitAt=submitAt;
        record(isRetry ? "REQUEST_RETRY_SUBMIT" : "REQUEST_SUBMIT_START", { requestIdPrefix:id.slice(0,12), method:String(method).slice(0,60), attempt:attempts, frameName:frame.name, endpointHost:(new URL(endpoint)).host, visibility:document.visibilityState });
        const form = document.createElement("form");
        form.method = "POST";
        form.action = endpoint;
        form.target = frame.name;
        form.acceptCharset = "UTF-8";
        form.style.display = "none";
        const fields = { mode:"pwa_api_v1", payloadVersion:"1", method, requestId:id, origin:location.origin, args:JSON.stringify(args) };
        for (const [key, value] of Object.entries(fields)) {
          const input = document.createElement("input");
          input.type = "hidden"; input.name = key; input.value = String(value);
          form.appendChild(input);
        }
        document.body.appendChild(form);
        try {
          form.submit();
          record("REQUEST_SUBMIT_CALLED", { requestIdPrefix:id.slice(0,12), method:String(method).slice(0,60), attempt:attempts });
        } catch (error) {
          form.remove();
          if (safeRetryEnabled && attempts < 4) {
            retryTimer = setTimeout(() => { if (pending.has(id)) submitAttempt(true); }, 1200 * attempts);
            p.retryTimer = retryTimer;
          } else {
            clearTimeout(timer); pending.delete(id); if (frame.isConnected) frame.remove();
            record("REQUEST_SUBMIT_FAILED", { requestIdPrefix:id.slice(0,12), error:String(error && error.message || error).slice(0,180) });
            reject(error);
          }
          return;
        }
        setTimeout(() => form.remove(), 1000);
        if (safeRetryEnabled && attempts < 2) {
          // Allow normal mobile HtmlService delivery to complete before retrying.
          // A retry reuses the exact requestId and arguments; backend idempotency
          // or lifecycle replay remains the final duplicate-execution safeguard.
          const delay = 25000;
          if (p.retryTimer) clearTimeout(p.retryTimer);
          retryTimer = setTimeout(() => { if (pending.has(id) && attempts < 2) submitAttempt(true); }, delay);
          p.retryTimer = retryTimer;
        }
      }
      p.submitAttempt = submitAttempt;
      submitAttempt(false);
    });
  }

  function applyAuth(r) {
    if (!r || r.ok !== true || !r.accessToken || !r.refreshToken) throw new Error(r && r.message || "Respons autentikasi tidak valid.");
    auth = { accessToken:r.accessToken, refreshToken:r.refreshToken, accessDeadline:Date.now()+Math.max(30,Number(r.accessExpiresIn)||900)*1000, user:r.user||null, tenant:r.tenant||null };
    persistRefreshToken(auth.refreshToken);
    // Persist the replacement token before removing the crash-recovery marker.
    clearPendingRefresh();
    return { ok:true, user:auth.user, tenant:auth.tenant, profileComplete:r.profileComplete, profileMissing:r.profileMissing, expiresIn:r.accessExpiresIn*1000 };
  }
  async function refreshAccessSingleFlight() {
    if (auth.accessToken && Date.now() < auth.accessDeadline-30000) return auth.accessToken;
    if (!auth.refreshToken) throw new Error("Sesi tidak tersedia. Silakan login.");
    if (refreshPromise) return refreshPromise;
    const token = auth.refreshToken;
    const existingPending = readPendingRefresh();
    const requestId = existingPending && existingPending.refreshToken === token ? existingPending.requestId : makeId();
    // Write-ahead marker: if this tab reloads while GAS rotates the token,
    // the next page load repeats the exact same lifecycle request ID + payload.
    writePendingRefresh(token, requestId);
    refreshPromise = (async () => {
      const r = await rawPost("pwaRefreshV12", [token], requestId);
      applyAuth(r);
      record("ACCESS_TOKEN_REFRESHED", { accessExpiresIn:Number(r.accessExpiresIn)||0 });
      return auth.accessToken;
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }
  async function ensureAccess() {
    if (auth.accessToken && Date.now() < auth.accessDeadline-30000) return auth.accessToken;
    return refreshAccessSingleFlight();
  }
  async function restoreSession(options) {
    options = options || {};
    if (restorePromise) return restorePromise;
    restorePromise = (async () => {
      if (!options.forceRefresh && auth.accessToken && Date.now() < auth.accessDeadline-30000) {
        return { ok:true, user:auth.user, tenant:auth.tenant };
      }
      let saved = auth.refreshToken || "";
      if (!saved) {
        try {
          saved = credentialStore().getItem(REFRESH_STORAGE_KEY) || "";
          if (!saved) {
            // Migrate a still-live Hotfix 4.7 tab token if available.
            saved = sessionStorage.getItem(LEGACY_REFRESH_STORAGE_KEY) || "";
            if (saved) credentialStore().setItem(REFRESH_STORAGE_KEY, saved);
          }
        } catch (_) {}
      }
      if (!saved) return { ok:false, authenticated:false };
      // Force a fresh access handle on an explicit recovery attempt. Keep the
      // newest rotated refresh token; never fall back to an older stored token.
      auth.accessToken = "";
      auth.accessDeadline = 0;
      auth.refreshToken = saved;
      try {
        const access = await refreshAccessSingleFlight();
        record("SESSION_RESTORED", { tenantPresent:!!auth.tenant, userPresent:!!auth.user, forced:!!options.forceRefresh });
        return { ok:true, user:auth.user, tenant:auth.tenant, accessToken:access };
      } catch (error) {
        const message = String(error && error.message || error);
        if (/berakhir|kedaluwarsa|telah digunakan|tidak valid|tidak cocok|silakan login/i.test(message)) {
          auth = { accessToken:"", refreshToken:"", accessDeadline:0, user:null, tenant:null };
          clearAuthStorage();
          record("SESSION_REJECTED", { reason:"refresh_token_invalid" });
          return { ok:false, authenticated:false, expired:true, message };
        }
        record("SESSION_RESTORE_DEFERRED", { reason:"transport_or_server_unavailable", forced:!!options.forceRefresh });
        throw error;
      }
    })().finally(() => { restorePromise = null; });
    return restorePromise;
  }
  const bridge = {
    version:"1.6.0-resilient-gateway-recovery",
    getDiagnostics() { return diagnostics.slice(); },
    getPersistentDiagnostics() { try { return JSON.parse(localStorage.getItem("apotek_pwa_bridge_diag_v1")||"[]"); } catch (_) { return []; } },
    getLastDiagnostic() { return lastDiagnostic; },
    getPendingSummary() { return {pendingCount:pending.size,maxPending:MAX_PENDING_REQUESTS,requestIds:Array.from(pending.keys()).map(x=>x.slice(0,12)),completedCount:completed.size,lateDeliveryWatchCount:lateRequests.size}; },
    clearDiagnostics() { diagnostics.length=0; lastDiagnostic=null; return true; },
    getUser() { return auth.user; },
    getTenant() { return auth.tenant; },
    async getAccessToken() { return ensureAccess(); },
    isAuthenticated() { return !!auth.accessToken; },
    async restoreSession(options) { return restoreSession(options); },
    async login(email,password) { const r=await rawPost("pwaLoginV12", [String(email||""),String(password||"")]); return applyAuth(r); },
    async refresh() { return ensureAccess(); },
    async logout() {
      const access=auth.accessToken, refresh=auth.refreshToken;
      try { if (access || refresh) await rawPost("pwaLogoutV12", [access,refresh]); }
      finally { auth={accessToken:"",refreshToken:"",accessDeadline:0,user:null,tenant:null}; clearAuthStorage(); }
    },
    async call(method,args) {
      method=String(method); args=Array.isArray(args)?args.slice():[];
      if (method==="login") return this.login(args[0],args[1]);
      if (method==="logout") return this.logout();
      if (["requestPasswordReset","validatePasswordResetToken","completePasswordReset"].includes(method)) return rawPost(method,args);
      const access=await ensureAccess();
      if (method==="validateSession") return rawPost("validateSession",[access]);
      if (args.length) args[0]=access; else args.unshift(access);
      return rawPost(method,args);
    }
  };
  window.ApotekApiBridge = Object.freeze(bridge);
  window.ApotekApiBridgeDiagnostics = Object.freeze({ get:() => bridge.getDiagnostics(), getPersistent:() => bridge.getPersistentDiagnostics(), last:() => bridge.getLastDiagnostic(), pending:() => bridge.getPendingSummary(), clear:() => { try { localStorage.removeItem("apotek_pwa_bridge_diag_v1"); } catch (_) {} return bridge.clearDiagnostics(); } });
  record("BRIDGE_INITIALIZED", { version:bridge.version, endpointConfigured:validEndpoint(endpoint), pageOrigin:location.origin });
})();
