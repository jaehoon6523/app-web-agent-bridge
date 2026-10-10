# Diagnostic safety (extension 0.2.9)

Diagnostic projection reads own data descriptors only. Accessor properties are
omitted without invoking their getters. There is no native-function heuristic:
bound functions and lazy native Error.stack accessors are both omitted. Stack
data properties are also excluded. Projection does not call toJSON or coerce
unknown values into strings. Reflection on a Proxy can execute its descriptor
trap; this is not a sandbox for arbitrary JavaScript objects.

Free-form error messages, stacks, cause strings and causeMessage are not emitted
through the diagnostic projection. Messages are replaced with a static summary
selected by error code; unknown codes receive a static generic summary. This
policy applies at every nested error level, on extension error responses, ping,
tab inspection, preparation persistence and stderr failure logs. Existing older
content ping responses are projected again at the background inspection boundary.
Error codes and structured evidence remain available. Raw message text and stack
traces are intentionally unavailable; the previous original-message guarantee
is replaced by error-code and structured-cause preservation.

Operational identifiers, canonical URLs, enumerated page state and known selector
metadata remain diagnostic fields. This is not a universal secret detector for
arbitrary text disguised as an identifier or CSS selector. Do not place prompt
or response text in those fields. Unknown fields, including response bodies,
shared secrets and tokens, are excluded at every level.

Requested and persisted binding records have their own narrow schema:
sessionId, runId, conversationUrl, conversationId, tabId, windowId, bindingStatus,
documentId and frameId. Recovery mode, matchStatus, storedTabId, persistedUrl and
persistedConversationId are retained in their surrounding recovery diagnostics.
The message selector is accepted only in selectorsUsed; it is not treated as an
error message. Unknown nested binding fields remain excluded.

Each projection is limited to depth 10, 256 visited objects/fields, 32 array
entries, 2,048 characters per string and 16,000 characters across strings.
Cycles become null; unsupported values including BigInt are omitted.

Failure state is persisted before emitting the failure log. Serialization and
console output are best effort. Logging failure does not replace the failure
code, release delivery ownership, send, acknowledge or discard a prompt. SQLite
restart tests verify retained state, ownership and static safe summaries.

The cumulative patch includes the previous guarded composer and reconnect work.
Real ChatGPT tabs, native extension loading and Windows remain unverified. A
separate authenticated extension occupying the controller (4409) still requires
the user to identify and disconnect that owner.
