# E2E Closure — 25 profiles

25 profiles 모두 W1–4 COMPLETE. Execution: RUNNABLE 25 / CONTINUATION BLOCKED 0. 각 profile의 실행 증거는 final E2E 결과로 판정한다. 외부 provider/Worker는 controlled peer이며 실제 모델·설치된 Chrome 확장 검증을 뜻하지 않는다. 원격 적용은 별도다.

공통 읽기 경로: public/app.js `refresh → request → session/state` → src/server.js routes → `DashboardController.snapshot` → `PreparationService.project` → `render/renderPreparation`. `/api/preflight`는 driver가 읽고 Dashboard는 state.preflight를 사용한다. 아래 경로는 코드 분석이며 실제 실행 증거는 profile artifact와 final gate 로그에 기록한다.

## UF-01A Fresh startup

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

main → loadConfig → listen → refresh → POST /api/dashboard/session → GET /api/state → DashboardController.snapshot → PreparationService.project → render

소스: `src/server.js`, `src/config.js`, `public/app.js`

## UF-01B Configured startup

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

loadConfig → createBridgeServer → WebExtensionTransport constructor → GET /api/state → getLiveRuntime → createLiveDiscussionRuntime → DashboardController.snapshot → PreparationService.project → refresh → render

소스: `src/config.js`, `src/server.js`, `src/runtime/live-discussion-runtime.js`

## UF-01C Connected startup

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

WebExtensionTransport.attach → authentication → GET /api/state → livePreflight → DashboardController.snapshot → PreparationService.project → refresh → render

소스: `src/runtime/web/session-adapter.js`, `src/server.js`, `public/app.js`

## UF-02 Runtime degraded

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

GET /api/state → DashboardController.snapshot → getLiveRuntime → createLiveDiscussionRuntime → ArtifactStore initialization failure → degraded snapshot → PreparationService.project → refresh → render

소스: `src/server.js`, `src/runtime/live-discussion-runtime.js`, `src/orchestration/dashboard-controller.js`

## UF-03 Extension disconnected

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

GET /api/state → livePreflight → DashboardController.snapshot → PreparationService.project → refresh → render → startRoot input → render

소스: `src/server.js`, `public/app.js`, `public/dashboard-health-presentation.js`

## UF-04 Extension connect

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

extension/background.js connect → WebSocket /ws/extension → server upgrade → WebExtensionTransport.attach → challenge/auth → livePreflight → GET /api/state → render

소스: `extension/background.js`, `src/server.js`, `src/runtime/web/session-adapter.js`

## UF-05 Preparation start

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

#startForm submit → beginPreparation → preparationMutation → POST /api/preparations → preparationRoute → PreparationService.execute → dispatch → reserve → generate → WebSessionAdapter.resume/submitTurn → extension background/content → provider DOM → complete → persistPreparation → GET /api/state → project → renderPreparation

소스: `public/app.js`, `src/server.js`, `src/orchestration/preparation-service.js`, `src/orchestration/preparation-persistence.js`, `src/runtime/web/session-adapter.js`, `extension/content.js`

## UF-06 Preparation revise

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

#reviseRequirements click → preparationMutation → POST /api/preparations/:id/reply → execute → dispatch → reserve → generate → WebSessionAdapter.submitTurn → provider DOM → complete → persistPreparation → project → renderPreparation

소스: `public/app.js`, `src/server.js`, `src/orchestration/preparation-service.js`

## UF-07 Approve to Worker

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

#projectForm submit → preparationMutation → POST /api/preparations/:id/approve → execute/dispatch → server approve callback → GitChangeWorkspace.prepareTarget → AuditProjectSettings.save → CodeChangeService.startPrepared → start → execute → executeIterations → createRegisteredCodeWorker → persist/capture → project → render

소스: `public/app.js`, `src/server.js`, `src/orchestration/preparation-service.js`, `src/orchestration/code-change-service.js`

## UF-08 Candidate independent review

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

executeIterations → workspace.assertCandidate → candidate/evidence persistence → ensureCandidateCodeSnapshots → performVerification → auditCandidate → reviewRole/submitRoleTurn → role provider → persisted review → snapshot → render

소스: `src/orchestration/code-change-service.js`, `src/orchestration/audit-round.js`, `public/app.js`

## UF-09 Rework

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

auditCandidate → planRework → persisted frozen AGREED_WORK_ORDER → executeIterations → assertReworkAuthority → Worker → new candidate → auditCandidate → snapshot → render

소스: `src/orchestration/audit-round.js`, `src/orchestration/code-change-service.js`, `public/app.js`

## UF-10 Pass and explicit apply

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

#applyCode click → command(code.apply) → POST /api/commands → DashboardController.executeDurable → execute → CodeChangeService.command → assertApprovalCandidate → GitChangeWorkspace.apply → store → snapshot → render

소스: `public/app.js`, `src/server.js`, `src/orchestration/dashboard-controller.js`, `src/orchestration/code-change-service.js`, `src/repository/git-change-workspace.js`

## UF-11 Restart recovery

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

SIGTERM → server.close → same workspace main → PreparationService constructor/SQLite read → CodeChangeService.recover → Dashboard new session → GET /api/state → project → renderPreparation/render

소스: `src/server.js`, `src/orchestration/preparation-service.js`, `src/orchestration/code-change-service.js`

## UF-12 Stale binding

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

provider navigation → extension content document-binding/ background current-target → WebSessionAdapter binding validation → PreparationService.webCommand → POST /api/preparations/web web.rebind → project → renderPreparation

소스: `extension/background.js`, `extension/runtime/document-binding.js`, `extension/runtime/current-target.js`, `src/runtime/web/session-adapter.js`, `src/orchestration/preparation-service.js`

## UF-13 State degradation

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

refresh → session → GET /api/state → preparations constructor SQLite failure → route catch 503 → request typed error → refresh catch → connection state reducer → health render → retry GET /api/state → actual recovered render

소스: `src/server.js`, `src/orchestration/preparation-service.js`, `public/app.js`, `public/dashboard-connection-state.js`, `public/dashboard-health-presentation.js`

## UF-14 Server transport down

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

production SIGTERM → server.close → existing browser poll → fetch rejection → request TRANSPORT failure → refresh catch → dashboard connection state → health render

소스: `src/server.js`, `public/app.js`, `public/dashboard-connection-state.js`, `public/dashboard-health-presentation.js`

## UF-15 SQLite contention

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

UI preparationMutation → real route → PreparationService.execute → saveReceipt/reserve → persistPreparation busy retry → independent /api/health/preflight/state → release lock → committed receipt → generate → extension → project → render

소스: `src/server.js`, `src/orchestration/preparation-service.js`, `src/orchestration/preparation-persistence.js`, `public/app.js`

## UF-16 Partial provider failure

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

auditCandidate → createReviewerProviderRouter.resolve → activateRole/reviewRole → Critic typed failure → HOLD/review evidence persistence → CodeChangeService.snapshot → DashboardController.snapshot → render role/health/action

소스: `src/orchestration/reviewer-provider-router.js`, `src/orchestration/audit-round.js`, `src/orchestration/code-change-service.js`, `public/app.js`

## UF-17 Dashboard authentication failure

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

refresh → request /api/dashboard/session or /api/state → verifyLocalBrowser/verifyDashboardAuthorization → LocalAuthError → sendDashboardAuthFailure → refresh catch → render

소스: `src/server.js`, `src/security/local-auth.js`, `public/app.js`

## UF-18 Reviewer free discussion

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

#sendReviewDiscussion click → command(code.review.discuss) → POST /api/commands → executeDurable/execute → CodeChangeService.command → discussReviewRole → provider → persist reviewDiscussions → snapshot → render

소스: `public/app.js`, `src/server.js`, `src/orchestration/code-change-service.js`, `src/orchestration/audit-round.js`

## UF-19 Operator note and decision

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

#addOperatorNote click → command(run.note.add) → POST /api/commands → executeDurable/execute → CodeChangeService.command → update/store → snapshot → render operatorNoteList

소스: `public/app.js`, `src/server.js`, `src/orchestration/code-change-service.js`

## UF-20 Applied follow-up lineage

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

#continueProject click → followUpSource → refresh start view → beginPreparation → POST /api/preparations followUpRunId → PreparationService.dispatch/findRun → followUpHandoffNotes → reserve → provider → project → render

소스: `public/app.js`, `src/server.js`, `src/orchestration/preparation-service.js`

## UF-21 Archive and restore

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

#archiveRun click → command(run.archive/run.unarchive) → POST /api/commands → executeDurable/execute → CodeChangeService.command → store archivedAt/event → snapshot → render/filter runList

소스: `public/app.js`, `src/server.js`, `src/orchestration/code-change-service.js`

## UF-22 Cancel and discard preparation

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

#closeProject/#discardDeliveryButton click → preparationMutation → POST /api/preparations/:id/cancel or discard → execute/dispatch → inspectDelivery/discardDelivery → persistPreparation → project → renderPreparation

소스: `public/app.js`, `src/server.js`, `src/orchestration/preparation-service.js`

## UF-23 Worker live intervention

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

#sendWorkerIntervention click → command(code.worker.intervene) → POST /api/commands → executeDurable/execute → CodeChangeService.command → worker.steer → update intervention → snapshot → render

소스: `public/app.js`, `src/server.js`, `src/orchestration/code-change-service.js`
