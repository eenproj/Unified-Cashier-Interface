# APOTEK SMART POS — Hotfix 4.12

## Basis
- Backend source: `Code(20261123-045458).gs` (Hotfix 4.11 diagnostics), retained unchanged.
- Bridge source: `api-bridge (1).js` v1.4.8, updated to v1.4.9.

## Bridge changes
1. Keep a short-lived completed-request record (7 seconds) after first accepted response.
2. ACK duplicate deliveries from the exact response source and classify them as `MESSAGE_DUPLICATE_ACKED`, rather than `MESSAGE_UNKNOWN_REQUEST`.
3. Require `event.source` to match the iframe created for the matching pending request.
4. Keep the response iframe alive for the bounded duplicate-delivery window, then remove it.
5. Track `lastMessageStage` per request so one request's timeout is not attributed to another request's latest global log.
6. Preserve the existing 45-second timeout and lifecycle-only retry policy. No business/checkout requests are automatically replayed.

## Backend changes
No backend logic changed in this patch. The supplied backend already includes Hotfix 4.11 trace points (`DOPOST_ENTER`, dispatcher stages, backend method stages, and queue/revision traces). Keeping it unchanged avoids altering authentication, tenant isolation, queue locking, or transaction semantics while testing the bridge correction.

## Validation
- JavaScript syntax check performed separately.
- This is static validation only; live smartphone and Apps Script deployment tests remain required.
