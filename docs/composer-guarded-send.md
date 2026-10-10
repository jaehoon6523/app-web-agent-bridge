# Guarded composer fallback and occupied-controller handling

Baseline: master `e7ef442a326f7f67321122c28736ba89969c4b6c` (extension 0.2.5).
Candidate: extension 0.2.10, selector registry `2026-10-10.3`.

When registered composer selectors find nothing, the provider can use one visible
editable textbox in a known composer container or a main-area form with recognized
prompt controls. Dialogs, navigation and message editors are excluded. Multiple
eligible editors remain blocked. This does not establish that the actual user DOM
has such a container; the diagnosis reports why a candidate was eligible.

Fallback dispatch requires exactly one distinct visible send control in that same
container. Only the registered explicit test ID or exact send labels are accepted.
A generic submit button never authorizes fallback dispatch, even when voice or
stop controls allow the textbox to be recognized. Selector aliases referring to the
same button count once; two distinct matching buttons remain blocked.

Immediately before clicking, the provider rechecks the original editor, fallback
container, unique send button, visibility and enabled state. Existing caller-side
document and ownership checks remain in effect. Registered composer handling
continues to use the existing selector path.

A 4409 or 4403 close cancels retries in the current service worker lifetime.
Reconnect and Save & reconnect explicitly reset this block. Restarting the service
worker can attempt a new connection; this patch does not persist a controller
occupancy lock, identify the current holder, replace its connection, or discard any
delivery. The server continues enforcing the existing connection ownership rules.

## Observed Korean composer

The user-reported form contains one visible editable textbox and a visible
button with the exact aria-label "음성 입력". Extension 0.2.9 omitted this label
from its dictation selectors, so the form did not qualify as a fallback composer.
The exact label now identifies the form. It does not identify a send button.
The observed form has no confirmed explicit send control; dispatch remains
blocked until one distinct explicit send control appears. Multiple editors,
excluded containers and hidden controls retain their existing restrictions.

## Applying

The Korean dictation add-on patch targets the previously reviewed cumulative
0.2.9 patch (`diagnostic-safety-full-e7ef442(1).patch`) applied to e7ef442.
It is not a cumulative replacement and must not be applied directly to e7ef442.

```powershell
git apply --check .\korean-composer-0.2.9-to-0.2.10.patch
if ($LASTEXITCODE -eq 0) {
  git apply .\korean-composer-0.2.9-to-0.2.10.patch
}
```

Reload the extension, then confirm both extension and content version 0.2.10 and
selector version 2026-10-10.3 in a fresh tab inspection. Existing content scripts
may retain their previous registry until the document is reloaded. Before any
page reload, verify that generation is finished and preserve the original
unresolved delivery. Do not discard or resend it to refresh selectors.

## Verification boundaries

`tests/composer-guarded-send.test.js` executes the production selector modules and
provider in a controlled DOM model. It verifies generic-submit rejection, alias
deduplication, multiple-control rejection, click-time changes and reconnect races.
It is not a native browser or real ChatGPT validation. Actual user DOM, native
extension loading and Windows validation remain outstanding.

The Korean regression uses the supplied button labels in both the controlled
DOM model and a Chromium DOM fixture. Chrome APIs and provider HTML remain
fixtures; this is not native extension or live ChatGPT verification.

On Windows, run the static checks and complete unit-test gate while overwriting
one latest console log:

```powershell
npm run check *> .\test-latest.log; $checkExit = $LASTEXITCODE; Get-Content .\test-latest.log -Tail 25; if ($checkExit -ne 0) { throw "check failed ($checkExit)" }
```

Browser fixtures, native extension loading and live ChatGPT acceptance are
separate verification layers. A passing check gate does not certify them.
