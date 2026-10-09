# Composer and unresolved delivery diagnostics

This change adds evidence collection. It does not establish the cause of a live
ChatGPT composer failure. Composer selectors, visibility acceptance, readiness
deadlines, dispatch, durable response receipts, ACK, and discard conditions are
unchanged. Extension/content version is 0.2.5.

## Capture without sending or discarding

1. Reload the unpacked extension after applying the patch. Inspect the pending
   delivery before reloading its owner tab; a reload can invalidate that document.
2. Use **모든 탭 상태 다시 확인** and select the failing new tab. Copy its complete
   diagnostic text. If this separate idle tab still has an older content version,
   manually reload only that idle tab and inspect again.
3. Use **전송 상태 확인** for the existing delivery. Copy its server classification,
   transport status, stored/observed content document IDs, and content version.
4. Check the pages directly with the existing tab-open actions. Report whether
   the composer is actually visible, whether login/security/error UI is visible,
   and whether the UI is still loading. Do not include prompt or response text.

These inspection actions send only read-only pings and metadata queries. They
do not inject content, rebind the conversation, clear a delivery, or send a prompt.
An unresolved delivery does not need a new preparation attempt for this capture.

If the composer is visibly present but all registered selectors have zero matches,
use Chrome DevTools' element picker on that input and run this expression for the
selected element. Send only this result and the diagnostic snapshot; never send
`innerHTML`, `textContent`, `value`, a whole DOM dump, or conversation text.

```js
({
  tag: $0.tagName,
  id: $0.id || null,
  role: $0.getAttribute('role'),
  contenteditable: $0.getAttribute('contenteditable'),
  testid: $0.getAttribute('data-testid'),
  root: $0.getRootNode() === document ? 'document' : 'shadow',
  topFrame: window === top
})
```

## Interpret the snapshot

| Observation | What it establishes |
| --- | --- |
| Composer selector `matched=0` | No match for that registered selector in the top-frame light DOM at inspection time |
| `matched>0`, `visible=0` | Matching elements rejected by the existing visibility rule |
| `display=none`, `visibility=hidden`, or zero width/height | Specific measured reasons for that visibility rejection |
| Generic editable candidates present, composer matches absent | Possible selector coverage gap; confirm the actual composer element before changing selection |
| Inspection exception, composer presence unknown | The inspection failed; absence has not been established |
| `readyState=complete` | Document loading completed; application hydration and login are not certified |
| `authenticationSignal` | Existing provider heuristic detected a login/security/error signal; page contents are not included |
| `TAB_NOT_FOUND` | Chrome reported that the tab no longer exists |
| `RECEIVER_MISSING` with tab lookup `FOUND` | The tab exists but no receiving content listener was found at that moment |
| `PORT_CLOSED`, `CONTEXT_INVALIDATED`, `MESSAGE_TIMEOUT` | Distinct transport observations, not proof of document replacement or completion |
| `INVALID_RESPONSE` | The ping did not return a successful content reply |
| `TAB_LOOKUP_FAILED` / `TAB_LOOKUP_TIMEOUT` | Tab lookup could not establish existence; a separate content ping may still respond |
| Document match `null` | A comparable content token was not obtained; mismatch is not established |

Content document IDs are content-script lifetime tokens, not Chrome navigation
documentIds. Selection counts do not inspect shadow roots or cross-origin frames.
Generic textarea/contenteditable/textbox counts are diagnostic only and never
become fallback composer selectors. No selector change is justified by counts
alone if the counted element has not been identified as the actual composer.

## Recovery boundary

Keep the existing delivery owner while its outcome is unknown. Server `MISSING`
is different from `UNAVAILABLE` or `MISMATCH`. An extension-only discard still
requires a fresh server `MISSING` result, exact owner identity, an idle gate,
existing operator confirmations, a reason, and the extra confirmation when page
state cannot be established. Matched server records use the existing controller
recovery actions. ACK recovery still verifies durable response evidence before
ACK and finishes ownership only after the exact ACK reply is confirmed.

## Verification routes

`npm run check` runs the repository's code and node:test checks. These tests use
controlled DOM and Chrome API fixtures; they do not prove live ChatGPT behavior.
`npm run test:extension:native` loads the unpacked extension in actual Chromium
against a routed fixture page. It now also checks hidden, invisible, and zero-size
composers through the native content/background/popup path, while preserving a
pending owner and verifying zero prompt clicks during inspection.

The native suite requires an installed compatible browser. A launch failure is
UNVERIFIED, not PASS. Windows requires a Windows runner. Live user DOM requires
the read-only capture above. Never reuse a previous version's test counts as
evidence that this version resolves the user's live failure.
