/* APOTEK SMART POS PWA Runtime v1 — installability + safe local foundation.
 * This module deliberately does not submit offline sales. A transaction can only
 * be committed by the authenticated Apps Script backend.
 */
(() => {
  "use strict";
  const DB_NAME = "apotek-smart-pos-pwa";
  const DB_VERSION = 1;
  const STORES = ["tenant_meta", "catalog_snapshots", "cashier_drafts", "pending_sales", "sync_events"];
  const $ = id => document.getElementById(id);

  function openDB() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) return reject(new Error("IndexedDB tidak tersedia."));
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("tenant_meta"))
          db.createObjectStore("tenant_meta", { keyPath: "tenantKey" });
        if (!db.objectStoreNames.contains("catalog_snapshots"))
          db.createObjectStore("catalog_snapshots", { keyPath: "tenantKey" });
        if (!db.objectStoreNames.contains("cashier_drafts"))
          db.createObjectStore("cashier_drafts", { keyPath: "draftId" });
        if (!db.objectStoreNames.contains("pending_sales")) {
          const s = db.createObjectStore("pending_sales", { keyPath: "requestId" });
          s.createIndex("byTenantStatus", ["tenantKey", "status"], { unique: false });
          s.createIndex("byCreatedAt", "createdAt", { unique: false });
        }
        if (!db.objectStoreNames.contains("sync_events"))
          db.createObjectStore("sync_events", { keyPath: "eventId" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("Gagal membuka IndexedDB."));
    });
  }

  async function put(storeName, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = tx.onabort = () => { const e = tx.error; db.close(); reject(e); };
    });
  }

  async function getAll(storeName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => { const v = req.result || []; db.close(); resolve(v); };
      req.onerror = () => { const e = req.error; db.close(); reject(e); };
    });
  }

  // Explicitly queue a sale as PENDING only. This function never invokes a
  // backend write and never changes authoritative stock or displays success.
  async function stagePendingSale({ tenantKey, requestId, payload }) {
    if (!tenantKey || !requestId || !payload) throw new Error("Identitas tenant, requestId, dan payload wajib tersedia.");
    const record = {
      tenantKey: String(tenantKey).trim().toUpperCase(),
      requestId: String(requestId),
      payload,
      status: "PENDING_SERVER_VALIDATION",
      createdAt: new Date().toISOString(),
      attempts: 0,
      lastError: null
    };
    await put("pending_sales", record);
    return { status: record.status, requestId: record.requestId };
  }

  async function registerSW() {
    if (!("serviceWorker" in navigator)) return { supported: false };
    const reg = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    return { supported: true, scope: reg.scope, waiting: !!reg.waiting };
  }

  async function refreshStatus() {
    const online = navigator.onLine;
    const node = $("pwaConnectionStatus");
    if (node) node.textContent = online ? "Online · backend dapat dihubungi" : "Offline · transaksi server dinonaktifkan";
    const pendingNode = $("pwaPendingCount");
    try {
      const rows = await getAll("pending_sales");
      if (pendingNode) pendingNode.textContent = String(rows.filter(x => x.status === "PENDING_SERVER_VALIDATION").length);
    } catch (_) {
      if (pendingNode) pendingNode.textContent = "—";
    }
  }

  window.ApotekPWA = Object.freeze({
    version: "1.0.0",
    openDB,
    put,
    getAll,
    stagePendingSale,
    refreshStatus
  });

  window.addEventListener("online", refreshStatus);
  window.addEventListener("offline", refreshStatus);
  window.addEventListener("load", async () => {
    try { await registerSW(); }
    catch (e) { console.warn("[APOTEK PWA] Service Worker registration:", e); }
    await refreshStatus();
  });
})();
