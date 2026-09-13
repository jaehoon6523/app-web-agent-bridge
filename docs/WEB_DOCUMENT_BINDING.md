# Web document binding

`ROOT_READY` selects a ChatGPT start tab without submitting or creating a conversation. Its first successful delivery promotes the binding to `BOUND` on the same tab and document. Changing the active browser tab does not change the delivery target.

Ready bindings include `documentId` and `frameId`. `documentId` is a random content-script lifetime token, **not** Chrome's navigation document ID. A reload creates a different token; only the top frame (`frameId: 0`) is accepted. Stored bindings without a token require preparation again, while unresolved deliveries remain available for recovery.

Before dispatch, the background pings the bound tab and compares its document token and conversation with the reserved binding. The receiver validates the expected token before handling the prompt. It checks the token and conversation again before editing the composer and immediately before clicking Send, including after asynchronous waits.

A successful result includes a persisted `trace` with `requestId`, `actionId`, `bindingId`, `tabId`, `documentId`, `frameId`, and `result: "success"`. The controller compares this trace and response evidence with the binding captured at dispatch. A self-consistent response from another document cannot replace that binding.

If validation fails before dispatch, the unsent delivery reservation is cleared. Once dispatch has started, the delivery remains unresolved for the existing recovery workflow; it is never automatically resent.

After updating, reload the unpacked extension and refresh the ChatGPT tab so the controller, service worker, and content script use the same contract. Prepare the session again before sending.
