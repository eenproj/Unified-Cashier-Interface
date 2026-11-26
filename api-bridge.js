/* APOTEK PWA API Bridge Client v1.8.1 — Gateway Response Delivery Diagnostics & Transport Recovery C3.2.
 * Adds response-delivery telemetry, robust duplicate ACK correlation, and bounded transport diagnostics.
 * Fast barcode lookup remains read-only and is never automatically retried.
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
  // Bounded lifecycle ledger preserves terminal-state evidence without retaining
  // payloads, credentials, or unbounded request history.
  const lifecycle = new Map();
  const MAX_LIFECYCLE_RECORDS = 160;
  const TERMINAL_STATES = new Set(["COMPLETED","FAILED","TIMED_OUT","CANCELLED","EXPIRED"]);
  function lifecycleTransition(id, next, detail) {
    const now = Date.now();
    let item = lifecycle.get(id);
    if (!item) {
      item = { requestIdPrefix:String(id).slice(0,12), state:"CREATED", createdAt:now, updatedAt:now, transitions:0 };
      lifecycle.set(id,item);
    }
    const previous = item.state;
    if (TERMINAL_STATES.has(previous) && previous !== next) {
      record("LIFECYCLE_TRANSITION_REJECTED", {requestIdPrefix:item.requestIdPrefix, previousState:previous, attemptedState:next});
      return false;
    }
    if (previous === next) {
      record("LIFECYCLE_DUPLICATE_TRANSITION", {requestIdPrefix:item.requestIdPrefix, state:next});
      return false;
    }
    item.state=next; item.updatedAt=now; item.transitions++;
    if (detail && detail.method) item.method=String(detail.method).slice(0,60);
    record("LIFECYCLE_TRANSITION", Object.assign({requestIdPrefix:item.requestIdPrefix,previousState:previous,nextState:next,transitionCount:item.transitions},detail||{}));
    while (lifecycle.size > MAX_LIFECYCLE_RECORDS) lifecycle.delete(lifecycle.keys().next().value);
    return true;
  }
  const COMPLETED_ACK_TTL_MS = 12000;
  const MAX_PENDING_REQUESTS = 8;
  const MAX_LATE_RESPONSE_WATCHES = 8;
  // A small pool reuses only idle, fully-reset iframes. One iframe is never
  // shared by concurrent requests; overflow uses a transient dedicated frame.
  const GATEWAY_FRAME_POOL_MAX = 4;
  const GATEWAY_FRAME_POOL_WARM = 2;
  const GATEWAY_FRAME_READY_TIMEOUT_MS = 12000;
  const gatewayFramePool = [];
  const LOOKUP_SOFT_TIMEOUT_MS = 12000;
  const LOOKUP_HARD_TIMEOUT_MS = 30000;
  const LOOKUP_FRAME_GRACE_MS = 12000;
  const LOOKUP_SOFT_WARNING_MS = LOOKUP_SOFT_TIMEOUT_MS;
  const GENERAL_REQUEST_TIMEOUT_MS = 60000;

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
  // Frames are preloaded at about:blank, leased exclusively, and reset only
  // after ACK duplicate protection has expired. A timeout frame stays quarantined
  // until its late-response watch ends. This prevents cross-request navigation.
  function makeFrameReadyPromise(frame) {
    let resolveReady;
    frame._apotekReadyPromise = new Promise(resolve => { resolveReady = resolve; });
    frame._apotekResolveReady = resolveReady;
  }
  function createFrame(requestId, pooled) {
    const frame = document.createElement("iframe");
    frame.name = "apotek_pwa_gateway_frame_" + makeId().slice(0,24);
    frame.title = "APOTEK API Gateway";
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.cssText = "position:absolute;width:1px;height:1px;left:-10000px;border:0";
    frame._apotekPooled = pooled !== false;
    frame._apotekTransport = { requestId:requestId||"", createdAt:Date.now(), leaseAt:Date.now(), loadCount:0, lastLoadAt:null, phase:"WAITING_INITIAL_BLANK", busy:!!requestId, ready:false };
    makeFrameReadyPromise(frame);
    frame.addEventListener("load", () => {
      const t=frame._apotekTransport||{};
      t.loadCount=(Number(t.loadCount)||0)+1;
      t.lastLoadAt=Date.now();
      if (t.phase === "WAITING_INITIAL_BLANK" || t.phase === "WAITING_RESET_BLANK") {
        t.ready=true;
        t.phase=t.busy?"RESERVED":"IDLE";
        record(t.phase === "IDLE" ? "FRAME_POOL_READY" : "FRAME_INITIAL_READY", {
          frameName:frame.name, requestIdPrefix:String(t.requestId||"").slice(0,12),
          loadCount:t.loadCount, sinceFrameCreatedMs:t.lastLoadAt-t.createdAt,
          sinceLeaseMs:t.lastLoadAt-t.leaseAt, pooled:!!frame._apotekPooled,
          connected:frame.isConnected, visibility:document.visibilityState
        });
        if (frame._apotekResolveReady) frame._apotekResolveReady(frame);
        return;
      }
      if (t.phase === "DISPATCHED") {
        t.phase="RESPONSE_DOCUMENT_LOADED";
        record("FRAME_RESPONSE_LOAD", { frameName:frame.name, requestIdPrefix:String(t.requestId||"").slice(0,12), loadCount:t.loadCount, sinceDispatchMs:t.lastLoadAt-(t.dispatchAt||t.leaseAt), connected:frame.isConnected, visibility:document.visibilityState });
      } else {
        record("FRAME_LOAD_UNEXPECTED", {frameName:frame.name,requestIdPrefix:String(t.requestId||"").slice(0,12),phase:String(t.phase||"unknown"),loadCount:t.loadCount});
      }
    });
    document.body.appendChild(frame);
    frame.src="about:blank";
    record("FRAME_CREATED", {frameName:frame.name,requestIdPrefix:String(requestId||"").slice(0,12),pooled:!!frame._apotekPooled,poolSize:gatewayFramePool.length,visibility:document.visibilityState});
    return frame;
  }
  function acquireFrame(requestId) {
    // Drop detached frames so stale DOM references cannot permanently consume pool capacity.
    for (let i=gatewayFramePool.length-1;i>=0;i--) {
      if (!gatewayFramePool[i] || !gatewayFramePool[i].isConnected) gatewayFramePool.splice(i,1);
    }
    let frame=gatewayFramePool.find(f => f.isConnected && !f._apotekTransport.busy && f._apotekTransport.ready && f._apotekTransport.phase === "IDLE");
    if (frame) {
      const t=frame._apotekTransport;
      t.requestId=requestId; t.busy=true; t.ready=true; t.phase="RESERVED";
      t.leaseAt=Date.now(); t.dispatchAt=null; t.lastLoadAt=null; t.loadCount=0;
      makeFrameReadyPromise(frame);
      // A reused blank frame is already ready; resolve without waiting for another load.
      if (frame._apotekResolveReady) frame._apotekResolveReady(frame);
      record("FRAME_POOL_REUSED", {frameName:frame.name,requestIdPrefix:requestId.slice(0,12),poolSize:gatewayFramePool.length});
      return frame;
    }
    const canPool=gatewayFramePool.length < GATEWAY_FRAME_POOL_MAX;
    frame=createFrame(requestId,canPool);
    if (canPool) gatewayFramePool.push(frame);
    else record("FRAME_POOL_OVERFLOW_TRANSIENT", {requestIdPrefix:requestId.slice(0,12),poolSize:gatewayFramePool.length,maxPool:GATEWAY_FRAME_POOL_MAX});
    return frame;
  }
  function resetOrRemoveFrame(frame, requestId, reason) {
    if (!frame) return;
    const t=frame._apotekTransport||{};
    if (!frame.isConnected) return;
    if (!frame._apotekPooled) {
      frame.remove();
      record("FRAME_TRANSIENT_REMOVED", {requestIdPrefix:String(requestId||t.requestId||"").slice(0,12),reason:String(reason||"released")});
      return;
    }
    t.requestId=""; t.busy=false; t.ready=false; t.phase="WAITING_RESET_BLANK"; t.dispatchAt=null; t.leaseAt=Date.now();
    makeFrameReadyPromise(frame);
    try {
      frame.src="about:blank";
      record("FRAME_POOL_RESET", {frameName:frame.name,requestIdPrefix:String(requestId||"").slice(0,12),reason:String(reason||"released")});
    } catch (error) {
      const i=gatewayFramePool.indexOf(frame); if(i>=0)gatewayFramePool.splice(i,1);
      frame.remove();
      record("FRAME_POOL_RESET_FAILED", {requestIdPrefix:String(requestId||"").slice(0,12),error:String(error&&error.message||error).slice(0,120)});
    }
  }
  // Warm two blank frames. They are not used until the browser confirms their
  // initial about:blank load; requests can still create additional pooled frames.
  for (let i=0;i<GATEWAY_FRAME_POOL_WARM;i++) {
    const warm=createFrame("",true);
    warm._apotekTransport.busy=false;
    gatewayFramePool.push(warm);
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
  function acknowledgeResponse(event, id, duplicate, deliveryTrace) {
    try {
      if (!event.source || typeof event.source.postMessage !== "function") throw new Error("Response source unavailable");
      const ackAt=Date.now();
      const delivery=deliveryTrace&&typeof deliveryTrace==="object"?deliveryTrace:{};
      event.source.postMessage({ channel:"APOTEK_PWA_GATEWAY_ACK_V1", requestId:id, ackVersion:"1.1", clientAckAt:ackAt, deliveryAttempt:Number(delivery.attempt)||null, deliveryElapsedMs:Number(delivery.elapsedMs)||null }, event.origin);
      record(duplicate ? "MESSAGE_DUPLICATE_ACKED" : "MESSAGE_ACK_SENT", { requestIdPrefix:id.slice(0,12), origin:event.origin, deliveryAttempt:Number(delivery.attempt)||null, deliveryElapsedMs:Number(delivery.elapsedMs)||null, clientAckAt:ackAt });
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
      if (done && done.expiresAt > Date.now() && trustedGoogleResponseOrigin(event.origin)) {
        // HtmlService can deliver a duplicate through a different nested sandbox
        // WindowProxy. The unguessable request ID plus strict Google origin check
        // is the correlation boundary; requiring identical event.source can leave
        // the response page retrying until its delivery window expires.
        const sourceChanged=done.source!==event.source;
        acknowledgeResponse(event, id, true, data.deliveryTrace);
        if (sourceChanged) record("MESSAGE_DUPLICATE_SOURCE_CHANGED_ACKED", { requestIdPrefix:id.slice(0,12), origin:event.origin });
        if (done.origin !== event.origin) record("MESSAGE_DUPLICATE_ORIGIN_CHANGED", { requestIdPrefix:id.slice(0,12), previousOrigin:done.origin, origin:event.origin });
        return;
      }
      const late = lateRequests.get(id);
      if (late && late.expiresAt > Date.now() && trustedGoogleResponseOrigin(event.origin)) {
        // A timed-out operation is terminal for the UI. ACK only to stop gateway
        // redelivery; never resolve the original Promise or apply its payload.
        const frameConnectedBeforeCleanup = !!(late.frame && late.frame.isConnected);
        const acked = acknowledgeResponse(event, id, true, data.deliveryTrace);
        late.responseObservedAt = Date.now();
        late.acknowledged = !!acked;
        lateRequests.delete(id);
        clearTimeout(late.cleanupTimer);
        resetOrRemoveFrame(late.frame, id, "late_response_acknowledged");
        record("LIFECYCLE_LATE_RESPONSE_RECONCILED", {requestIdPrefix:id.slice(0,12),terminalState:"TIMED_OUT",payloadApplied:false});
        record("MESSAGE_LATE_AFTER_TIMEOUT_ACKED", {requestIdPrefix:id.slice(0,12),method:late.method,elapsedMs:Date.now()-late.startedAt,origin:event.origin,acknowledged:!!acked,frameConnectedBeforeCleanup,payloadApplied:false});
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
      acknowledgeResponse(event, id, false, data.deliveryTrace);
      record("MESSAGE_REQUEST_IN_PROGRESS", { requestIdPrefix:id.slice(0,12), method:p.method, retryAfterMs:Number(data.result.retryAfterMs)||2000, elapsedMs:Date.now()-p.startedAt });
      if (p.retryTimer) clearTimeout(p.retryTimer);
      const delay = Math.max(1000, Math.min(5000, Number(data.result.retryAfterMs)||2000));
      p.retryTimer = setTimeout(() => { if (pending.has(id) && p.submitAttempt && p.attempts < 7) p.submitAttempt(true); }, delay);
      return;
    }
    const deliveryTrace=data.deliveryTrace&&typeof data.deliveryTrace==="object"?data.deliveryTrace:null;
    record("MESSAGE_DELIVERY_OBSERVED", { requestIdPrefix:id.slice(0,12), method:p.method, deliveryAttempt:deliveryTrace&&Number(deliveryTrace.attempt)||null, deliveryElapsedMs:deliveryTrace&&Number(deliveryTrace.elapsedMs)||null, responseOrigin:event.origin, nestedFrame:!sourceMatchesFrame });
    const responseAcked = acknowledgeResponse(event, id, false, deliveryTrace);
    p.responseObservedAt = Date.now();
    p.responseAcked = !!responseAcked;
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
      resetOrRemoveFrame(p.frame, id, "completed_ack_window_expired");
    }, COMPLETED_ACK_TTL_MS);
    const responseAt=Date.now();
    const bridgeTrace={requestIdPrefix:id.slice(0,12),method:p.method,elapsedMs:responseAt-p.startedAt,attempts:Number(p.attempts)||0,firstSubmitAt:p.firstSubmitAt||null,lastSubmitAt:p.lastSubmitAt||null,responseAt:responseAt,lastMessageStage:p.lastMessageStage||"MESSAGE_RECEIVED",nestedFrameAccepted:!sourceMatchesFrame,gatewayTrace:data.result&&data.result.gatewayTrace||data.result&&data.result.data&&data.result.data._gatewayTrace||null,transportTrace:data.transportTrace||null,deliveryTrace:deliveryTrace||null,frameLoadCount:Number(p.frame&&p.frame._apotekTransport&&p.frame._apotekTransport.loadCount)||0};
    if (!data.result || data.result.ok !== true) {
      const apiCode=String(data.result && data.result.code || "BACKEND_ERROR").slice(0,80);
      record("MESSAGE_API_ERROR", { requestIdPrefix:id.slice(0,12), method:p.method, code:apiCode, elapsedMs:bridgeTrace.elapsedMs, attempts:bridgeTrace.attempts, origin:event.origin });
      const apiError=new Error(String(data.result && data.result.message || "Permintaan API gagal."));apiError.code=apiCode;apiError.bridgeTrace=bridgeTrace;apiError.gatewayTrace=data.result&&data.result.gatewayTrace||null;
      lifecycleTransition(id, "FAILED", {method:p.method,code:apiCode});
      p.reject(apiError);
      return;
    }
    record("MESSAGE_ACCEPTED", { requestIdPrefix:id.slice(0,12), method:p.method, elapsedMs:bridgeTrace.elapsedMs, attempts:bridgeTrace.attempts, nestedFrameAccepted:bridgeTrace.nestedFrameAccepted, origin:event.origin });
    lifecycleTransition(id, "COMPLETED", {method:p.method,elapsedMs:bridgeTrace.elapsedMs,acknowledged:!!responseAcked});
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
    const isFastBarcodeLookup=String(method)==="getBarcodeProductFast";
    // Bound active work before creating an iframe or allocating a timer.
    if (pending.size >= MAX_PENDING_REQUESTS) {
      const capacityError = new Error("API sedang menangani terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.");
      capacityError.code = "GATEWAY_CAPACITY_LIMIT";
      record("REQUEST_REJECTED_CAPACITY", {method:String(method).slice(0,60),pendingCount:pending.size,maxPending:MAX_PENDING_REQUESTS});
      return Promise.reject(capacityError);
    }
    const id = requestIdOverride || makeId();
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(String(id))) return Promise.reject(new Error("Request ID tidak valid."));
    const frame = acquireFrame(id);
    const safeRetryEnabled = !isFastBarcodeLookup; // Lookup is read-only; avoid queue amplification.
    const timeoutMs=isFastBarcodeLookup?LOOKUP_HARD_TIMEOUT_MS:GENERAL_REQUEST_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      let attempts = 0;
      let retryTimer = null;
      const timer = setTimeout(() => {
        if (retryTimer) clearTimeout(retryTimer);
        if (p.retryTimer) clearTimeout(p.retryTimer);
        const frameConnectedBeforeCleanup = !!frame.isConnected;
        pending.delete(id);
        lifecycleTransition(id, "TIMED_OUT", {method:String(method),timeoutMs:timeoutMs});
        const elapsedMs=Date.now()-startedAt;
        const trace={requestIdPrefix:id.slice(0,12),method:String(method),elapsedMs:elapsedMs,attempts:attempts,firstSubmitAt:p.firstSubmitAt||null,lastSubmitAt:p.lastSubmitAt||null,responseAt:null,lastMessageStage:p.lastMessageStage||null,visibility:document.visibilityState};
        const frameTransport=frame&&frame._apotekTransport||{};
        record("REQUEST_TIMEOUT_CONTEXT", { requestIdPrefix:id.slice(0,12), method:String(method).slice(0,60), visibility:document.visibilityState, online:navigator.onLine, frameConnectedBeforeCleanup, frameLoadCount:Number(frameTransport.loadCount)||0, frameAgeMs:Date.now()-Number(frameTransport.createdAt||startedAt), lastFrameLoadAgeMs:frameTransport.lastLoadAt?Date.now()-frameTransport.lastLoadAt:null, pendingCount:pending.size, framePhase:frameTransport.phase||null, frameReady:!!frameTransport.ready, dispatchAt:frameTransport.dispatchAt||null });
        record("REQUEST_TIMEOUT", { requestIdPrefix:id.slice(0,12), method:String(method).slice(0,60), attempts, elapsedMs:elapsedMs, timeoutMs:timeoutMs, lastMessageStage:p.lastMessageStage || null, lateGraceMs:LOOKUP_FRAME_GRACE_MS });
        // Keep the named response frame alive briefly so a delayed HtmlService
        // response can be ACKed. Its data is deliberately discarded after timeout.
        // Keep the late-watch registry bounded even during repeated outages.
        if (lateRequests.size >= MAX_LATE_RESPONSE_WATCHES) {
          const oldestId = lateRequests.keys().next().value;
          const oldest = lateRequests.get(oldestId);
          if (oldest) { clearTimeout(oldest.cleanupTimer); resetOrRemoveFrame(oldest.frame, oldestId, "late_watch_evicted"); }
          lateRequests.delete(oldestId);
          record("LATE_RESPONSE_WATCH_EVICTED", {requestIdPrefix:String(oldestId).slice(0,12),maxLateWatches:MAX_LATE_RESPONSE_WATCHES});
        }
        const late = {method:String(method),startedAt,frame,expiresAt:Date.now()+LOOKUP_FRAME_GRACE_MS,cleanupTimer:null};
        late.cleanupTimer = setTimeout(() => {
          if (lateRequests.get(id) === late) lateRequests.delete(id);
          resetOrRemoveFrame(frame, id, "late_response_grace_expired");
          record("LATE_RESPONSE_GRACE_EXPIRED", {requestIdPrefix:id.slice(0,12),method:String(method).slice(0,60),graceMs:LOOKUP_FRAME_GRACE_MS});
        }, LOOKUP_FRAME_GRACE_MS);
        lateRequests.set(id, late);
        const timeoutError=new Error(isFastBarcodeLookup?"Pencarian barcode melewati batas waktu 30 detik. Status produk belum dapat dipastikan.":"Gateway tidak memberikan respons. Periksa koneksi sebelum mengulangi transaksi.");
        timeoutError.code=isFastBarcodeLookup?"LOOKUP_TIMEOUT":"GATEWAY_TIMEOUT";timeoutError.bridgeTrace=trace;reject(timeoutError);
      }, timeoutMs);
      const softTimer = isFastBarcodeLookup ? setTimeout(() => {
        if (pending.has(id)) record("REQUEST_SLOW_WARNING", {requestIdPrefix:id.slice(0,12),method:String(method),elapsedMs:Date.now()-startedAt,softTimeoutMs:LOOKUP_SOFT_WARNING_MS,finalTimeoutMs:timeoutMs});
      }, LOOKUP_SOFT_WARNING_MS) : null;
      const p = { resolve, reject, timer, softTimer, startedAt, method:String(method), frame, lastMessageStage:null, retryTimer:null, attempts:0, submitAttempt:null, firstSubmitAt:null, lastSubmitAt:null };
      pending.set(id, p);
      function submitAttempt(isRetry) {
        if (!navigator.onLine) return;
        attempts++;
        p.attempts=attempts;
        const submitAt=Date.now();if(!p.firstSubmitAt)p.firstSubmitAt=submitAt;p.lastSubmitAt=submitAt;
        const transport=frame._apotekTransport||{};transport.phase="DISPATCHED";transport.dispatchAt=submitAt;
        if (attempts > 1) record("LIFECYCLE_RESUBMIT_SAME_ID", {requestIdPrefix:id.slice(0,12),method:String(method).slice(0,60),attempt:attempts});
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
            clearTimeout(timer); if (softTimer) clearTimeout(softTimer); pending.delete(id);
            resetOrRemoveFrame(frame,id,"submit_failed");
            lifecycleTransition(id, "FAILED", {method:String(method),reason:"submit_failed"});
            record("REQUEST_SUBMIT_FAILED", { requestIdPrefix:id.slice(0,12), error:String(error && error.message || error).slice(0,180) });
            reject(error);
          }
          return;
        }
        setTimeout(() => form.remove(), 1000);
      }
      p.submitAttempt = submitAttempt;
      const frameReadyTimer=setTimeout(() => {
        if (!pending.has(id)) return;
        if (p.retryTimer) clearTimeout(p.retryTimer);
        clearTimeout(timer); if (softTimer) clearTimeout(softTimer);
        pending.delete(id);
        lifecycleTransition(id, "FAILED", {method:String(method),reason:"frame_initialization_timeout"});
        record("FRAME_INITIAL_READY_TIMEOUT", {requestIdPrefix:id.slice(0,12),method:String(method).slice(0,60),readyTimeoutMs:GATEWAY_FRAME_READY_TIMEOUT_MS,frameConnected:!!frame.isConnected,phase:frame._apotekTransport&&frame._apotekTransport.phase});
        resetOrRemoveFrame(frame,id,"frame_initialization_timeout");
        const e=new Error("Gateway belum siap menerima permintaan. Silakan coba kembali.");e.code="GATEWAY_FRAME_NOT_READY";reject(e);
      }, GATEWAY_FRAME_READY_TIMEOUT_MS);
      frame._apotekReadyPromise.then(() => {
        clearTimeout(frameReadyTimer);
        if (!pending.has(id)) return;
        const t=frame._apotekTransport||{};
        if (!t.ready || !frame.isConnected) {
          record("FRAME_READY_CHECK_FAILED", {requestIdPrefix:id.slice(0,12),frameConnected:!!frame.isConnected,phase:t.phase||null});
          return;
        }
        t.phase="DISPATCHED"; t.dispatchAt=Date.now();
        lifecycleTransition(id, "SUBMITTED", {method:String(method),frameReady:true});
        record("REQUEST_DISPATCH_READY", {requestIdPrefix:id.slice(0,12),method:String(method).slice(0,60),frameName:frame.name,frameReadyWaitMs:Date.now()-Number(t.leaseAt||startedAt),pooled:!!frame._apotekPooled});
        submitAttempt(false);
      });
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
    version:"1.9.0-gateway-iframe-pool-c3.3",
    getLifecycleSummary() {
      const counts = {};
      for (const item of lifecycle.values()) counts[item.state]=(counts[item.state]||0)+1;
      return {trackedCount:lifecycle.size, maxRecords:MAX_LIFECYCLE_RECORDS, stateCounts:counts, recent:Array.from(lifecycle.values()).slice(-30).map(x=>({requestIdPrefix:x.requestIdPrefix,method:x.method||null,state:x.state,transitions:x.transitions,ageMs:Date.now()-x.createdAt}))};
    },
    getDiagnostics() { return diagnostics.slice(); },
    getPersistentDiagnostics() { try { return JSON.parse(localStorage.getItem("apotek_pwa_bridge_diag_v1")||"[]"); } catch (_) { return []; } },
    getLastDiagnostic() { return lastDiagnostic; },
    getTransportDiagnostics() { return diagnostics.filter(x => /FRAME_|MESSAGE_DELIVERY|MESSAGE_ACK|MESSAGE_DUPLICATE|REQUEST_TIMEOUT_CONTEXT|LATE_RESPONSE/.test(String(x.stage||""))).slice(-100); },
    getFramePoolSummary() { return {poolSize:gatewayFramePool.length,maxPool:GATEWAY_FRAME_POOL_MAX,warmTarget:GATEWAY_FRAME_POOL_WARM,frames:gatewayFramePool.map(f=>({name:f.name,connected:!!f.isConnected,busy:!!(f._apotekTransport&&f._apotekTransport.busy),ready:!!(f._apotekTransport&&f._apotekTransport.ready),phase:f._apotekTransport&&f._apotekTransport.phase,loadCount:f._apotekTransport&&f._apotekTransport.loadCount}))}; },
    getPendingSummary() { return {pendingCount:pending.size,maxPending:MAX_PENDING_REQUESTS,requestIds:Array.from(pending.keys()).map(x=>x.slice(0,12)),completedCount:completed.size,lateDeliveryWatchCount:lateRequests.size,maxLateResponseWatches:MAX_LATE_RESPONSE_WATCHES,lateRequestIds:Array.from(lateRequests.keys()).map(x=>x.slice(0,12)),lifecycleCount:lifecycle.size,lifecycleStates:this.getLifecycleSummary().stateCounts}; },
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
  window.ApotekApiBridgeDiagnostics = Object.freeze({ lifecycle:() => bridge.getLifecycleSummary(), get:() => bridge.getDiagnostics(), getPersistent:() => bridge.getPersistentDiagnostics(), transport:() => bridge.getTransportDiagnostics(), frames:() => bridge.getFramePoolSummary(), last:() => bridge.getLastDiagnostic(), pending:() => bridge.getPendingSummary(), clear:() => { try { localStorage.removeItem("apotek_pwa_bridge_diag_v1"); } catch (_) {} return bridge.clearDiagnostics(); } });
  record("BRIDGE_INITIALIZED", { version:bridge.version, endpointConfigured:validEndpoint(endpoint), pageOrigin:location.origin });
})();
