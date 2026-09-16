# Web document binding

`ROOT_READY` selects a ChatGPT start tab without submitting or creating a conversation. Immediately before each delivery reservation, the extension resolves the single active ChatGPT tab in the last-focused window and captures its current document. This current user target replaces a stale tab locator while preserving the Controller-owned session and run identity. If no single active ChatGPT tab can be proven, dispatch fails without changing the previous binding or delivery.

Ready bindings include `documentId` and `frameId`. `documentId` is a random content-script lifetime token, **not** Chrome's navigation document ID. A reload creates a different token; only the top frame (`frameId: 0`) is accepted. Stored bindings without a token require preparation again, while unresolved deliveries remain available for recovery.

Before dispatch, the background pings the current target, atomically persists that binding, and then reserves the delivery. The receiver validates the expected token before handling the prompt. It checks the token and conversation again before editing the composer and immediately before clicking Send, including after asynchronous waits. A reload completed before target capture uses the new document; a reload after capture fails instead of sending to an unproven document.

The first send from `ROOT_READY` can navigate the same tab from `/` to `/c/{id}` before the content result returns. A tab-update event is accepted as a provisional root promotion only when the tab and active request ID match the reserved delivery. The returned binding and success trace must still authenticate the promoted conversation before it is committed as `BOUND`; unrelated navigation remains `AMBIGUOUS`.

A successful result includes a persisted `trace` with `requestId`, `actionId`, `bindingId`, `tabId`, `documentId`, `frameId`, and `result: "success"`. The controller compares this trace and response evidence with the current binding returned by the authenticated extension. Session and run identity cannot change. A self-consistent current target may replace stale tab, conversation, and document locators; an identity change or mismatched trace fails closed.

If validation fails before dispatch, the unsent delivery reservation is cleared. Once dispatch has started, the delivery remains unresolved for the existing recovery workflow; it is never automatically resent.

After updating, reload the unpacked extension and refresh the ChatGPT tab so the controller, service worker, and content script use the same contract. Prepare the session again before sending.

`npm run test:browser` exercises the full background and content scripts with the real Web adapter and Chromium DOM fixtures, including first-send document navigation and `/c/WEB:*` to durable conversation URL settlement. It does not install the extension or authenticate with ChatGPT. The fixture cannot certify Chrome service-worker suspension or current live provider DOM behavior.

Stored `AMBIGUOUS` recovery uses a closed code-to-message contract. One exact, ready, idle root tab maps to `STORED_AMBIGUOUS_ROOT_RECOVERED` and `ROOT_READY`. An unresolved delivery maps to `STORED_AMBIGUOUS_DELIVERY_REVIEW_REQUIRED` and remains blocked. All other mismatches map to `STORED_AMBIGUOUS_REBIND_REQUIRED`. The popup renders the mapped message supplied by this contract instead of interpreting raw topology details independently.
