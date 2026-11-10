# Read-only message DOM inspection

`GET /api/message-dom-inspection` uses the existing dashboard Bearer authorization and authenticated extension transport. It accepts exactly one `tabId`, `conversationUrl`, `controllerMessageId` (`delivery_<UUID>`) and `runId` (`prep_<UUID>`) as query parameters. The conversation URL must be an exact `https://chatgpt.com/c/<UUID>` URL.

The extension checks the tab URL before and after a fixed, isolated-world DOM reader in frame 0. There is no arbitrary JavaScript input, navigation, focus change, content submission, session binding or receipt access. No content-script installation or replacement is attempted. The route does not initialize the live runtime or persist the observation; normal HTTP/transport diagnostics still apply.

The response includes the tab/window/Chrome document IDs, actual page URL, observation time, selectors and fallbacks used, current DOM message counts and bounded matching-message structures. `FOUND` requires both exact marker lines exactly once in the same message and explicit DOM user-role proof. An assistant match, unknown/conflicting/nested role, split markers or repeated markers cannot establish `FOUND`. Only the current DOM is inspected; older or unmounted messages are not searched or loaded. At most 20 matching structures are returned; truncation prevents `FOUND`.

No conversation text or HTML is returned. `data-message-id`, `data-testid`, `data-message-content` and other identity/role attributes are reported with presence, length and value type. Values containing content or exceeding 160 characters are redacted. Empty/absent attributes are distinguished; attribute values are evidence, not assumed semantic message IDs.

Failures include `INVALID_DOM_INSPECTION_REQUEST` (400), and `EXTENSION_NOT_AUTHENTICATED`, `EXTENSION_DISCONNECTED`, `TAB_CHANGED`, `MESSAGE_DOM_INSPECTION_FAILED`, `INVALID_DOM_OBSERVATION`, or `MESSAGE_DOM_INSPECTION_TIMEOUT` (503). An older extension may time out because it does not implement this RPC. These failures do not establish marker absence.

This change is source-only until the server and extension load it. Installing/reloading/restarting them, querying a real conversation, and running B08 require separate authorization and were not performed during implementation.
