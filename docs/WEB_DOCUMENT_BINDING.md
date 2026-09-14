# Web document binding

`ROOT_READY` selects a ChatGPT start tab without submitting or creating a conversation. Its first successful delivery promotes the binding to `BOUND` on the same tab and window. A first-send navigation may create a new document; the background then observes the submitted prompt on that document without resending. Changing the active browser tab does not change the delivery target.

Ready bindings include `documentId` and `frameId`. `documentId` is a random content-script lifetime token, **not** Chrome's navigation document ID. A reload creates a different token; only the top frame (`frameId: 0`) is accepted. Stored bindings without a token require preparation again, while unresolved deliveries remain available for recovery.

Before dispatch, the background pings the bound tab and compares its document token and conversation with the reserved binding. The receiver validates the expected token before handling the prompt. It checks the token and conversation again before editing the composer and immediately before clicking Send, including after asynchronous waits.

A successful result includes a persisted `trace` with `requestId`, `actionId`, `bindingId`, `tabId`, `documentId`, `frameId`, and `result: "success"`. The controller compares this trace and response evidence with the binding captured at dispatch. A bound conversation cannot replace its document using a self-consistent response. Only a `ROOT_READY` first turn may promote to a new document: session/run/tab/window/frame must remain bound, and trace, returned binding and message evidence must agree on the created conversation and observed document.

If validation fails before dispatch, the unsent delivery reservation is cleared. Once dispatch has started, the delivery remains unresolved for the existing recovery workflow; it is never automatically resent.

After updating, reload the unpacked extension and refresh the ChatGPT tab so the controller, service worker, and content script use the same contract. Prepare the session again before sending.

`npm run test:browser` exercises the full background and content scripts with the real Web adapter and Chromium DOM fixtures, including first-send document navigation. It does not install the extension or authenticate with ChatGPT. The fixture cannot certify Chrome service-worker suspension or current live provider DOM behavior.
