# Initial tab selection regression

This gate loads the production Dashboard (`public/index.html`, `app.js`, CSS),
starts `src/server.js` against a disposable workspace, and uses the production
HTTP projection, preparation service, SQLite store, WebSocket transport,
extension background, and content scripts. Chrome APIs and the provider DOM
and response are controlled by the existing extension harness. It does not
certify an installed extension, Windows, or the live ChatGPT service.

## Execute

Install dependencies and the browser, then run the focused gate:

```sh
npm ci
npx playwright-core install chromium
npm run test:e2e:tabs
```

`UI_BROWSER_EXECUTABLE` can select an existing Chromium executable. The focused
command runs UF-12, UF-24, UF-25, and UF-26. The profiles are also discovered by
`npm run test:e2e`, `npm run test:e2e:wave`, and `npm run test:e2e:ci` through
`scripts/e2e/flows.json`. The existing `browser` job in
`.github/workflows/bridge-gates.yml` invokes `test:e2e:ci` on Linux and Windows.
Being wired into CI is not a claim that a remote CI run passed.

`npm run check` remains the non-browser gate. The standalone
`test:tab-ux-browser` fixture checks component behavior and layout separately;
it cannot substitute for this Dashboard regression.

## Oracles

| Profile | Setup and user action | Required result |
| --- | --- | --- |
| UF-12 | Existing PREPARE conversation becomes ambiguous; select a matching tab | Existing conversation selection remains visible; correct description; selected document sends once; other candidate sends zero |
| UF-24 | Three root tabs exist before first request; blank URL; reload; refresh; select; continue | START candidates and controls visible under actual parents/CSS; radio selection plus a polling cycle sends nothing; original preparation/session/delivery/command identity retained; chosen tab sends once, others zero; valid response stored, ACK observed, PREPARE shown; reload sends nothing |
| UF-25 | Close one stale candidate, navigate another to a different conversation; try each; cancel isolated request | Both continuations rejected visibly; no prompt sent; original request retained; unsent cancellation clears START controls |
| UF-26 | Continue selected initial request; restart server after the actual provider click and before response | Same request enters RECOVERY_REQUIRED; recovery panel remains visible even if historical `unsent` remains true; no automatic resend |

All Dashboard mutations use normal Playwright clicks/checks/fills. No forced
click, DOM reparenting, direct preparation API call, or fabricated Dashboard
snapshot is used to pass a profile. A closed provider page is removed from the
Chrome API shim's tab inventory. Production rebind performs candidate validation.

The ACK frame observer is read-only. It takes a separate SQLite readback when
the browser observes the incoming ACK and verifies stored response/validation.
Browser event scheduling may allow that observation to see `ACK_PENDING` or
`COMPLETE`; final `COMPLETE`, the exact ACK identity, cleared ownership, and
one provider result are checked separately. This is not a crash-window test.

## Evidence and failure semantics

Each invocation writes its current result beneath
`.agent-controller/ui-qa/e2e-wave/<profile>/` and the selected/full suite summary
beneath `.agent-controller/ui-qa/`. UF-24 records `initial-tab-blocked.json` and
`initial-tab-complete.json`; UF-25 records `initial-tab-stale.json`; UF-26 records
`initial-tab-interrupted.json`. Normal Dashboard cleanup records the DOM,
screenshot, HTTP boundary, server logs, and lifecycle outcome.

An unfixed c2fddc58 Dashboard must fail UF-24 at actual choice visibility:
`.preparation-tab-choice` exists inside hidden `#projectPanel`. The previous
`initial-tab-selection-c2fddc58.patch` repairs that path but fails UF-26 because
its discard visibility check trusts a historical `unsent` flag irrespective of
the delivery's current state. The integrated fix hides discard only for an
actual `FAILED` unsent delivery, matching the service's recovery classification.

Baseline comparison must use the same test files and environment with the
production UI restored to the baseline. Preserve negative-control artifacts
before another run overwrites that profile. Browser launch/download failures
are environment failures and provide no product E2E verdict.
