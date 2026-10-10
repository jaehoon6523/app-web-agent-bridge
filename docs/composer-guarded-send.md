# Guarded composer fallback and occupied-controller handling

Baseline: master `e7ef442a326f7f67321122c28736ba89969c4b6c` (extension 0.2.5).
Candidate: extension 0.2.7, selector registry `2026-10-10.2`.

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

## Applying

Apply the cumulative patch only to clean e7ef442. It includes the guarded fallback
and 4409 behavior discussed in the unapplied 0.2.6 proposal, plus stricter send
selection. Do not apply it over that proposal or another dirty tree.

```powershell
git apply --check ..\composer-guarded-send-e7ef442.patch
if ($LASTEXITCODE -eq 0) {
  git apply ..\composer-guarded-send-e7ef442.patch
}
```

Reload the extension, confirm 0.2.7, and inspect the actual ChatGPT tab. Check the
original delivery and generation state before manually reloading its page. A
fallback can identify an editor while its send control remains UNKNOWN; this is
expected when only voice or generic submit controls are visible.

## Verification boundaries

`tests/composer-guarded-send.test.js` executes the production selector modules and
provider in a controlled DOM model. It verifies generic-submit rejection, alias
deduplication, multiple-control rejection, click-time changes and reconnect races.
It is not a native browser or real ChatGPT validation. Actual user DOM, native
extension loading and Windows validation remain outstanding.
