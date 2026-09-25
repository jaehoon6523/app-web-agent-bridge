# Start → Prepare → Work → Result Contract

이 문서는 사용자 요청 하나의 canonical workflow, WebSession, Delivery,
agreement, repository 및 UI projection 계약이다. UI 표시 상태나 DOM 상태는
workflow의 근거가 아니다. 서버 canonical state가 항상 우선한다.

## 1. PreparationContext

사용자가 `준비로 이동`을 누르는 순간 하나의 `PreparationContext`를 만든다.
작업이 시작되거나 사용자가 명시적으로 취소할 때까지 유지한다.

```js
PreparationContext = {
  preparationId, version, stage, objective, targetRoot,
  webSession, discussion, agreement, repository,
  resultingRunId, createdAt, updatedAt
}
```

질문 답변, 요구사항 수정, 재제안, 웹 상태 확인, focus, delivery recovery는
새 context가 아니라 같은 `preparationId`에 대한 mutation이다.

## 2. Workflow

화면 전환은 요청 접수나 버튼 클릭이 아니라 확인된 결과로 결정한다.
- START: 최초 연결·전송·응답 대기를 포함한다. 첫 웹 응답의 검증·저장·ACK 확인 전에는 PREPARE로 이동하지 않는다. 실패와 복구도 이 화면에서 처리한다.
- PREPARE: 확인된 첫 응답을 표시한다. 후속 답변 대기와 승인 처리는 같은 화면에 머문다. 실제 run 생성이 확인되면 WORK로 이동한다.
- WORK: 구현·감사·중단 처리·보류·복구 확인을 표시한다. STOPPING을 종료로 간주하지 않는다.
- RESULT: 적용 대기 또는 종료 결과를 표시한다. COMPLETE를 APPLIED로 추정하지 않는다. 적용 요청 후 APPLYING은 WORK로 표시한다.
- 새로고침도 동일한 서버 상태와 단계별 프론트 검증 규칙을 사용한다.

최상위 stage는 네 개뿐이다.

```text
START → PREPARE → WORK → RESULT
```

세부 state는 별도 필드로 관리한다.

```js
{ stage: "PREPARE", state: "WAITING_WEB_RESPONSE" }
```

금지:

```js
projectPanel.hidden === false ? "PREPARE" : showStart ? "START" : ...
```

UI는 `GET /api/state`가 반환한 `workflow.stage`와 `workflow.state`를
그대로 projection한다.

## 3. START

START는 외부 시스템을 변경하지 않고 다음 입력만 받는다.

```js
{ objective, targetRoot, conversationUrl }
```

사용자가 입력한 `objective` 원문은 그대로 보존한다. START에서는 `git init`,
`git add`, `git commit`, 파일 수정, 프로젝트 설정 저장을 하지 않는다.

## 4. START → PREPARE

서버는 다음 순서로 하나의 PreparationContext를 만든다.

```text
입력 검증
→ PreparationContext 생성
→ Web conversation binding
→ 첫 설계 메시지 전송
→ stage=PREPARE 반환
```

첫 메시지는 구현을 요구하지 않는 implementation designer 역할이다.
프롬프트 순서는 역할, 행동 규칙, 응답 계약, 기존 준비 문맥, 사용자의 첫
부탁 순서다. 모호한 요청에서 acceptance criteria를 억지로 만들지 않고
질문 또는 선택지를 반환할 수 있어야 한다.

## 5. PREPARE state

```text
INITIALIZING
→ WAITING_WEB_RESPONSE
→ DISCUSSING
→ AGREEMENT_READY
→ APPROVING
```

오류 state:

```text
WEB_BLOCKED | RECOVERY_REQUIRED | FAILED
```

첫 웹 요청을 기다리는 동안 별도의 최상위 대기 stage를 만들지 않는다.
대기는 `stage=PREPARE`, 세부 `state=WAITING_WEB_RESPONSE`다.

## 6. WebSession

PreparationContext는 하나의 logical WebSession만 가진다.

```js
webSession = {
  sessionId, conversationId, conversationUrl,
  tabId, windowId, bindingState, activeDelivery,
  lastObservedUserMessageId, lastObservedAssistantMessageId
}
```

`draftId` 변경으로 sessionId를 새로 만들지 않는다.

Binding 상태:

```text
UNBOUND | BINDING | BOUND | STALE | RECOVERY_REQUIRED
```

정상 전송은 `BOUND`에서만 가능하다. conversation URL 변경은 조용한 재사용이
아니라 `STALE → BINDING → BOUND` 전이여야 한다.

## 7. Delivery

Delivery lifecycle은 workflow와 독립적이다.

Delivery record lifecycle:

```text
RESERVED
→ DISPATCHING
→ SUBMITTED
→ RESPONSE_STARTED
→ RESPONSE_COMPLETED
→ ACKNOWLEDGED
```

Terminal/error:

```text
FAILED | AMBIGUOUS | RECOVERY_REQUIRED
```

Active pointer:

```text
WebSession.activeDeliveryId = null | deliveryId
```

ACKNOWLEDGED 후에는 Delivery record를 보존하고 `WebSession.activeDeliveryId = null`로 만든다.

오류:

```text
FAILED | AMBIGUOUS | RECOVERY_REQUIRED
```

`currentDeliveryId` 존재만으로 busy 또는 generating을 판단하지 않는다.
동시에 active delivery는 최대 하나이며, 반드시 하나의 preparation, session,
conversation에 귀속되어야 한다.

Delivery 완료에는 conversation 일치, user message 확인, assistant response
확인, `generating=false`, content worker idle, deliveryId 일치가 모두 필요하다.
ACK 후에만 active delivery를 비운다.
대시보드의 종료 확정 표시는 `processingState=COMPLETE`에서만 허용한다. response가 저장됐거나 `canRecover=true`여도 `ACK_PENDING`이면 전송 정리 미확정으로 표시하고 raw 응답은 보존한다.

## 8. Delivery Recovery

Recovery는 새 메시지를 보내는 기능이 아니라 기존 delivery의 실제 상태를
확정하는 기능이다.

```js
{ deliveryId, preparationId, sessionId, conversationId, conversationUrl }
```

식별자가 현재 상태와 다르면 거부한다.

상태별 처리:

| 상태 | 처리 |
|---|---|
| conversation/delivery 일치, generating=true | ACTIVE. 대화 열기·상태 확인·생성 종료 |
| response 존재, generating=false, ACK 누락 | RECOVERABLE_COMPLETED. 재전송 없이 정리 |
| 탭 없음·conversation 불일치·content script 무응답·delivery 불명 | AMBIGUOUS. 자동 stop/clear/resend 금지 |

Recovery UI는 작업, 대화, sessionId, deliveryId, 탭 도달 가능 여부,
정확한 conversation 여부, pageBusy, generating, extensionBusy, pageStatus,
canFocus, canStop, canRecover를 표시한다. 진단 정보가 없으면 추측하지 않는다.

## 9. Agreement

```js
agreement = {
  status, summary, unresolvedQuestions, requirements
}
```

status는 `DISCUSSING | READY | APPROVED`다. `AGREEMENT_READY`는 질문이 없고,
요구사항이 하나 이상이며, 모든 statement와 acceptanceCriteria가 유효하고,
응답이 같은 PreparationContext에서 발생한 경우에만 가능하다.

## 10. 승인과 Repository

`합의 승인하고 작업 시작`은 하나의 `approve preparation` 명령이다.
클라이언트가 다음을 독립적으로 조합해서는 안 된다.

```text
/api/project/prepare
/api/project PUT
run.start
```

현재 외부 API는 다음과 같다.

```http
POST /api/preparations/{preparationId}/approve
```

서버 순서:

```text
context version 확인
→ agreement READY 확인
→ active delivery IDLE 확인
→ targetRoot 재검증
→ repository 준비
→ agreement/project snapshot 저장
→ Run 생성
→ resultingRunId 기록
→ stage=WORK
```

PREPARE까지는 read-only다. 승인 이전에 Git 변경을 하지 않는다. WORK 시작
순간 `run.baseCommit`이 반드시 존재해야 한다. 기존 저장소의 사용자 변경을
임의로 commit/reset/stash하지 않는다.

승인 재요청은 idempotent해야 한다. `PreparationContext.resultingRunId`가
이미 있으면 기존 Run을 반환하고 두 번째 Run을 만들지 않는다.

## 11. WORK와 RESULT

WORK부터 기존 Run state machine을 사용한다. PreparationContext와 Run은
`resultingRunId === run.runId`로 연결한다.

RESULT 여부는 terminal set이나 DOM으로 계산하지 않는다. 서버가 반환한
presentation stage를 사용한다.

```js
workflow: { stage: "RESULT", state: "AWAITING_APPLY" }
```

RESULT에는 `AWAITING_APPLY`, `APPLIED`, `CANCELLED`, `INCONCLUSIVE`, `FAILED`,
`RECOVERY_REQUIRED`, `HOLD`가 포함될 수 있다.

## 12. UI 계약

UI는 서버 상태를 projection하며 workflow state를 만들지 않는다.

```js
switch (workflow.stage) {
  case "START": ...
  case "PREPARE": ...
  case "WORK": ...
  case "RESULT": ...
}
```

local state는 details, 선택 탭, textarea draft, dialog, scroll, loading
animation 같은 순수 표시 상태만 담당한다. `showStart`, `proposalDraft`,
`proposalPending`, `projectPanel.hidden`, `selected`로 workflow를 복구하지 않는다.

전역 `pending` 하나로 모든 작업을 잠그지 않는다. operation별 상태를 둔다.

```js
operations = {
  folderPicker: "IDLE",
  preparationStart: "IDLE",
  webTurn: "IDLE",
  approval: "IDLE",
  runCommand: "IDLE"
}
```

`proposalDraft`는 합의 데이터, 오류, 세션 복구 기준, 승인 가능 여부를
동시에 담당하지 않는다. `PreparationContext`, `WebSessionState`,
`DeliveryState`, `Agreement`, `UIState`를 분리한다.

## 13. Canonical Dashboard State

`GET /api/state`는 최소 다음을 제공해야 한다.

```js
{
  workflow: { stage, state, preparationId, runId },
  preparation,
  run,
  sessions,
  deliveries,
  commandCapabilities,
  preflight
}
```

페이지 새로고침 후 local JS state가 모두 사라져도 이 응답 하나로 동일 화면을
복원할 수 있어야 한다.

## 14. Capability, Error, Timeout, Version

버튼 활성화는 서버 capability가 결정한다.

```text
preparation.start | preparation.reply | preparation.approve
web.focus | web.stop | web.recover
run.stop | code.apply | evidence.export
```

오류는 문자열만 전달하지 않고 다음 구조를 사용한다.

```js
{
  code, message, retryable, workflowStage,
  preparationId, runId, details
}
```

HTTP timeout은 작업 실패가 아니라 `UNKNOWN_RESULT`다. 자동 재전송하지 않고
canonical state와 requestId를 조회해 처리됨·처리 중·없음을 판단한다.

모든 mutation에는 `requestId`와 `expectedVersion`이 필요하다. 같은 requestId는
기존 결과를 반환한다. PreparationContext도 optimistic version을 가진다.

## 15. 새 작업과 새로고침

미완료 PreparationContext를 `새 작업`으로 암묵적으로 삭제하지 않는다. 폐기,
새 준비, 취소 중 하나를 명시적으로 선택한다. WORK 중이면 기존 Run 정책을
따른다.

새로고침 후 서버 state만으로 START/PREPARE/WORK/RESULT를 복원한다.

## 16. 핵심 불변조건

```text
INV-01 PreparationContext 하나에는 conversation 하나만 존재한다.
INV-02 PreparationContext 하나에는 active delivery가 최대 하나다.
INV-03 active delivery는 정확히 하나의 session과 preparation에 속한다.
INV-04 PREPARE 중에는 repository를 수정하지 않는다.
INV-05 WORK 시작 전에 agreement가 승인되어 있어야 한다.
INV-06 WORK 시작 전에 baseCommit이 존재해야 한다.
INV-07 PreparationContext 하나에서 Run은 최대 하나 생성된다.
INV-08 UI DOM은 canonical workflow state가 아니다.
INV-09 timeout만으로 command 실패를 확정하지 않는다.
INV-10 delivery 존재만으로 generating 여부를 판단하지 않는다.
INV-11 conversation 불일치 시 stop/recovery를 자동 수행하지 않는다.
INV-12 새로고침 후 서버 state만으로 workflow를 복원할 수 있다.
```

## 17. 최소 E2E Acceptance Test

```text
TEST-01 정상 흐름
START → 입력 → PREPARE → 실제 ChatGPT 전송 → 응답 → 수정 대화
→ agreement READY → 승인 → Git baseline → Run 정확히 1개 → WORK → RESULT

TEST-02 "아무거나"
구현 강행·임의 acceptance criteria 확정 없이 질문 또는 선택지를 제시한다.

TEST-03 PREPARE 도중 refresh
동일 preparationId, conversation, discussion, PREPARE 화면을 복원한다.

TEST-04 active Web response
중복 전송·강제 rebind 없이 정확한 이전 conversation과 생성 중 상태를 표시한다.

TEST-05 completed but unacknowledged
재전송 없이 response를 확인하고 delivery를 정리한다.

TEST-06 ambiguous recovery
자동 stop·clear·resend 없이 진단 정보를 표시한다.

TEST-07 approve retry
같은 requestId 재전송 시 Run 하나와 같은 runId를 반환한다.

TEST-08 Git timing
PREPARE까지 mutation이 없고 승인 후에만 baseline을 생성한다.
```

## 18. 리팩터링 우선순위

```text
1. PreparationContext 도입
2. workflow.stage/state를 서버 canonical state로 추가
3. START → PREPARE API를 하나의 명령으로 통합
4. planning draft마다 WebSession을 새로 만드는 구조 제거
5. WebSession과 Delivery state 분리
6. agreement 구조 분리
7. PREPARE approve를 단일 서버 command로 통합
8. Git preparation을 approve transaction 내부로 이동
9. UI stage 계산을 workflow.stage 기반으로 교체
10. 전역 pending을 operation state로 분리
11. 새로고침 recovery 테스트
12. 실제 extension + 실제 ChatGPT tab E2E 테스트
```

## 19. 완료 정의

사용자가 START에서 요청을 입력한 뒤 하나의 PreparationContext 안에서 같은
ChatGPT conversation과 설계 대화를 유지하고, 합의 승인 전에는 저장소를
변경하지 않으며, 승인 후 정확히 하나의 Run을 생성하고, 새로고침이나 전송
복구가 발생해도 서버 canonical state만으로 START → PREPARE → WORK → RESULT를
정확하게 복원할 수 있어야 한다.

이 계약과 충돌하는 기존 구현은 기존 동작 보존을 이유로 유지하지 않는다.
계약이 기존 코드보다 우선한다.

## 보완 규칙

### INV-13. 승인 이후 PreparationContext 불변성

`agreement.status === APPROVED`가 된 순간 `objective`, `targetRoot`,
`conversationUrl`, `agreement`는 immutable snapshot으로 고정한다. WORK 이후
변경이 필요하면 기존 PreparationContext를 수정하지 않고 새 context를 생성한다.

### Stage/state discriminated union

`workflow.stage`와 `workflow.state`는 임의의 문자열 조합이 아니다. 허용 조합은
다음과 같다.

```text
START: START_IDLE | VALIDATING
PREPARE: INITIALIZING | WAITING_WEB_RESPONSE | DISCUSSING | AGREEMENT_READY
          | APPROVING | WEB_BLOCKED | RECOVERY_REQUIRED | FAILED
WORK: RUN_CREATED | PROVISIONING | WORKER_RUNNING | VERIFYING
      | REVIEW_RUNNING | REWORK | APPLYING
RESULT: AWAITING_APPLY | APPLIED | HOLD | RECOVERY_REQUIRED
        | CANCELLED | INCONCLUSIVE | FAILED
```

예를 들어 `START/WAITING_WEB_RESPONSE`와 `WORK/AGREEMENT_READY`는 유효하지 않다.

### Preparation lifecycle 분리

PREPARE의 `FAILED`는 presentation state이며 context의 terminal 여부를
단독으로 뜻하지 않는다. context lifecycle은 별도로 관리한다.

```text
ACTIVE | ABANDONED | FAILED | COMPLETED
```

`PREPARE/FAILED`는 retry 가능한 context일 수 있다.

### Delivery record와 active pointer 분리

ACK 이후에도 Delivery record는 보존한다. `IDLE`은 Delivery.state가 아니라
WebSession의 active pointer 상태다.

```js
Delivery.state = RESERVED | DISPATCHING | SUBMITTED | RESPONSE_STARTED
  | RESPONSE_COMPLETED | ACKNOWLEDGED | FAILED | AMBIGUOUS | RECOVERY_REQUIRED

WebSession.activeDeliveryId = deliveryId | null
```

`ACKNOWLEDGED` delivery는 기록으로 남고 `activeDeliveryId`만 `null`이 된다.

### Recovery·Stop·Reconcile 책임 분리

`recover` 하나에 서로 다른 동작을 묶지 않는다.

```text
web.inspect     현재 탭·conversation·delivery 상태 조회
web.stop        실제 생성 중인 delivery 종료 요청 및 종료 확인
web.reconcile   완료·ACK 누락·stale 상태를 식별자 검증 후 정리
```

`reconcile`은 새 메시지를 보내거나 임의로 rebind하지 않는다. 각 명령은
deliveryId, preparationId, sessionId, conversationId를 검증한다.

### 비동기 START → PREPARE

첫 Web 응답을 기다리는 동안 HTTP 요청을 붙잡아 두지 않는다.

```text
POST preparation.start
→ 입력 검증
→ PreparationContext 생성
→ PREPARE/INITIALIZING 저장
→ first delivery 예약
→ preparationId와 version 즉시 반환

비동기 orchestration:
binding → delivery dispatch → WAITING_WEB_RESPONSE
→ response parse → DISCUSSING 또는 AGREEMENT_READY
```

HTTP timeout과 Web delivery 결과를 분리하고 requestId로 canonical state를 조회한다.

### DiscussionTurn canonical model

```js
DiscussionTurn = {
  turnId,
  preparationId,
  sequence,
  actor, // USER | WEB_DESIGNER
  content,
  deliveryId,
  createdAt
}
```

`sequence`는 preparation 안에서 strictly increasing이고, `turnId`는 중복되지
않으며, WEB_DESIGNER turn은 대응 deliveryId를 가진다. 모든 turn은 동일한
preparationId에 속한다.

### Dashboard version contract

`GET /api/state`의 workflow projection에는 mutation에 사용할 version을 직접
포함한다.

```js
{
  workflow: {
    stage,
    state,
    preparationId,
    preparationVersion,
    runId,
    runVersion
  }
}
```

UI는 mutation 직전에 다른 객체를 탐색해 version을 추론하지 않는다. 모든
reply, approve, stop, reconcile mutation은 해당 version을 expectedVersion으로 보낸다.

### 추가 불변조건

```text
INV-14 stage/state는 허용 조합 표에 있는 discriminated union이어야 한다.
INV-15 ACKNOWLEDGED delivery record는 보존되고 activeDeliveryId만 null이 된다.
INV-16 inspect, stop, reconcile은 서로 다른 명령 책임을 가진다.
INV-17 preparation.start은 첫 Web 응답을 기다리지 않고 preparationId를 반환한다.
INV-18 DiscussionTurn sequence는 preparation 내에서 strictly increasing이다.
INV-19 workflow projection은 preparationVersion과 runVersion을 직접 제공한다.
```

## 테스트 위치와 계약 매핑

현재 저장소의 관련 테스트는 다음 위치에 있다.

| 계약 영역 | 테스트 위치 |
|---|---|
| UI projection, 시작 안내, proposal 흐름 | `tests/public/audit-console.test.js` |
| preparation API와 proposal lifecycle | `tests/planning-session-api.test.js`, `tests/preparation-service.test.js` |
| WebSession, binding, delivery lifecycle | `tests/web-runtime-core.new.test.js`, `tests/web-delivery-recovery.test.js` |
| Web extension 저장 상태와 turn guard | `tests/web-extension-storage.new.test.js`, `tests/web-extension-turn-guard.new.test.js` |
| discussion turn/dispatcher/response atomicity | `tests/discussion-loop.test.js`, `tests/discussion-dispatcher.test.js`, `tests/discussion-response-atomicity.test.js`, `tests/discussion-response-links.test.js` |
| PreparationContext에 해당하는 project preparation/settings | `tests/project-preparation.test.js`, `tests/project-settings.test.js` |
| Run state, version, limits, outcomes | `tests/run-state-machine.test.js`, `tests/run-service.test.js`, `tests/run-policy.test.js`, `tests/run-limits-persistence.new.test.js`, `tests/run-outcomes-persistence.test.js` |
| repository mutation timing과 baseline | `tests/git-change-workspace.test.js`, `tests/code-change-e2e.test.js`, `tests/audit-boundaries.test.js` |
| persistence, outbox, projection/rebuild | `tests/sqlite-store.test.js`, `tests/sqlite-outbox.test.js`, `tests/projection-rebuild.test.js`, `tests/projection-rebuild-command.new.test.js` |
| protocol failure와 recovery scan/reconcile | `tests/protocol-failure.test.js`, `tests/recovery-scan.test.js`, `tests/recovery-reconcile.test.js` |

구현 순서는 다음과 같다.

```text
1. 위 테스트 위치에서 현재 계약 위반 목록 작성
2. INV-01~19별 회귀 테스트 추가 또는 기존 테스트 연결
3. 현재 구현을 순차 리팩터링
4. TEST-01~08의 실제 extension + 실제 ChatGPT tab E2E 증명
```

테스트 파일이 존재한다는 사실만으로 계약 준수를 인정하지 않는다. 각 테스트는
PreparationContext, workflow stage/state, delivery record, active pointer,
version, idempotency 및 refresh 복구의 canonical state를 검증해야 한다.
