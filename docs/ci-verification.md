# Bridge CI verification

## Pull requests

Mark the PR ready for review when you want `pr-focused` to run. The job checks
the PR merge checkout on Windows with Node 22.14. Its summary records the base,
head, actual checkout, changed paths, and selected tests. Mixed changes take the
union of matching suites. Unclassified source, dependency, or configuration
changes use the shared smoke and contract tests. New or modified Node test files
can be selected directly.

After reviewing the new check, update any existing branch protection that
requires the former full matrix jobs to require `pr-focused`.

## Before release

Manually run **Bridge gates** with the full 40-character candidate SHA. The
workflow checks out that commit in the full Windows and Ubuntu verification
matrix and in the Node 22.5 minimum-runtime job. A failing full run blocks the
release decision. The workflow performs verification and saves its artifacts.

GitHub requires the workflow with manual dispatch to be available on the
default branch. If this change lands on a non-default deployment branch first,
adopt the workflow on the default branch before relying on manual dispatch.
Until then, run `npm run verify:all` from a clean checkout of the candidate.

## Known baseline failure

On Windows with Node 22.14.0, `UF-12 Stale binding` failed on both the verified
deployment base `bc5be505af5b209f44be36e1090145e2e0bf833d` and
[PR #7](https://github.com/jaehoon6523/app-web-agent-bridge/pull/7) at
`f56e636e85023b9cfc445740d6ad197cf7643c82`. The server recorded
`RESPONSE_TIMEOUT` after dispatch and the expected dashboard state did not
appear within 20 seconds. Both runs covered the full suite and reported the
same 16 failing profiles. The underlying cause remains unconfirmed. UF-12
keeps its existing failure semantics in full verification.
