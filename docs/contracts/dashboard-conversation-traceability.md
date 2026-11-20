# 대시보드 대화·ID 추적성

2026-11-18 KST · [소스 기준 W와 증거 등급](dashboard-conversation-as-is.md) · [변경 이력](dashboard-conversation-changelog.md)

표의 흐름은 `FE 함수/DOM → HTTP → BE → 저장 → 테스트 → 결과`다. ‘없음’은 해당 단계가 읽기 또는 폼에서 끝나거나 실제로 값이 존재하지 않음을 가리킨다. 한 행의 증거는 기재한 접점에 한정된다.

| 계약 ID | FE 함수/DOM | API | BE 소유자 | 저장 구조 | 테스트 | 검증 결과 |
| --- | --- | --- | --- | --- | --- | --- |
| C-UI-01, RULE-01 | `startProjectDraft`, `#newRun`, `#newProjectTask`, `#startForm` | GET `/api/state?view=start` | `PreparationService.project`, 대시보드 시작 게이트 | 초안 DOM, 클릭 자체는 준비 저장 없음 | F, P, B | 인앱 새 작업·수동 URL 잔존 확인, 초안 변경은 TEST |
| C-UI-02, RULE-02/03 | `render`, `#conversationUrl`, `#reuseProjectConversation` | GET 상태 → POST 준비 | `dispatch("preparation.start")` | `projectConversations[targetRoot]`, 준비 `projectConversationSource` | B, F, P, S, H | 인앱 편집 가능/토글과 대역 요청 캡처, 서버 mismatch의 실제 409 |
| C-UI-03 | `renderProjectOverview`, `#overviewConversation`, `#overviewTasks`, `#runList` | GET 상태 | `DashboardController.snapshot`의 Run 요약, `PreparationService.project` | Run JSON의 `preparationId/conversationUrl`, 준비 JSON의 매핑 | B, P, H | 인앱 개요·불완전 매핑 확인, Run 카드 TEST 및 이전 B0 자료 |
| C-UI-04 | `renderInitialRequest`, `#planningUrl`, 준비 저장/복구 문구 | GET 상태 | `PreparationService.project` | `contexts[prepId]`, 활성 포인터 | F, H | DOM TEST 및 HTTP/DB에서 새 준비와 null Run 확인 |
| C-UI-05, RULE-07 | `refresh`, `startProjectDraft`, `selectProject`, `openRun` | GET 상태 `runId/view/requestId` | `DashboardController.snapshot` + `PreparationService.project` | 응답·권한 읽기, 초안/선택은 DOM·세션 | F, P, B | 늦은 조회·복원은 TEST, 인앱 프로젝트 전환 및 수동 URL 잔존 |
| C-API-01 | `beginPreparation`, `preparationMutation` | POST `/api/preparations` | `preparationRoute` → `execute` → `dispatch` / `reserve` | `contexts`, `receipts`, `deliveries` | F, P, H | FE body TEST, 실제 localhost HTTP 202/400/409와 행 확인 |
| C-API-02 | `refresh`, `normalizeDashboardState` | GET `/api/state` 및 세 조회 인자 | `DashboardController.snapshot` → `PreparationService.project` | Run/준비 영속 조회, 요청 영수증 | H, F, Q | 실제 HTTP·재시작, 브라우저 별도 UI |
| C-API-03, RULE-09 | `preparationMutation`, 승인·취소·복구 | POST `/api/preparations/:id/approve`/`reply`/`cancel`/`discard`, `/api/preparations/web`, GET 영수증 | `execute` / `checkVersion` / `webCommand` | 준비 `receipts`, 전송·준비 버전, 승인 예약 ID | H, S, R, F | 실제 승인 중복·재조회·ACK 복구, 취소/폐기 TEST |
| C-ACT-01, RULE-04, D-1 | `#continueProject` → `startProjectDraft` → `#followUpSource` | POST `followUpRunId` + URL + 재사용 여부 | `findRun`, `dispatch`, `followUpHandoffNotes` | 준비·Run `followUp`, 목록 `parentRunId` | H, S, F, P, B0 | APPLIED fixture의 정상 계보는 실제 HTTP, 거부는 TEST. 인앱 클릭 B0는 이전 수집 자료 |
| C-ACT-02 | `#saveProject`, `refresh` 자동 승인 시도 | POST `/api/preparations/:id/approve` | `dispatch` → `approveRun` → `startPrepared` | 예약/결과 ID, 새 Run 및 요건, 클라이언트의 세션 내 시도 표시 | H, F, S | 실제 HTTP 및 SQLite에서 하나의 새 실행, 자동 승인 TEST |
| C-TX-01, RULE-08, D-4 | `#conversationUrl` → `beginPreparation` | POST URL, 이후 Web 세션 준비·프롬프트·응답 | `generate`, `WebSessionAdapter.resume`, 확장 `conversation-bootstrap` | `contexts[…].webSession`, active delivery | F, S, E, H | 시작 URL FE body·가짜 Web의 신규 ID와 탭 논리 TEST. 실제 ChatGPT 발급 미기록 |
| C-TX-02, RULE-05/06, D-2/3 | `#projectConversationPanel`, `#projectConversationDetail` | GET 상태, POST 준비 | `dispatch` → `complete` → `persistPreparation` | `preparations.sqlite`의 `preparation_state.json` | H, R, S, P, B | 기존 매핑·ACK 실패·갱신·재시작 실제 DB. malformed truthy ID/URL 조합은 STATIC |
| C-TX-03 | `#runPanel`, `#overviewTasks`, `#applyCode` | 승인 POST, GET 상태, POST `/api/commands`의 `code.apply` | `startPrepared` → `start`; `initialBinding`; 적용 처리기 | `code_change_runs.record_json`, `code_change_history` | H, A, F | 준비–Run–SQLite는 HTTP 확인. Worker·Reviewer 대역을 쓴 격리 Git 적용을 확인. 운영 미기록 |

## 증거 실행 내역

| 표기 | 경계·재현 자료 | 이번 확인 |
| --- | --- | --- |
| B | Codex 인앱 브라우저 + 투입 데이터를 가진 별도 루프백 서버 `60042`. `productionProcess`와 준비 DB 단일행으로 `mapped-project`/`incomplete-project` 합성 매핑을 넣음 | 프로젝트 개요 → 새 작업 → 자동 체크/채움 → 해제/공란 → 선택 복구. ID null 개요 표시는 있으나 새 작업 재사용은 숨김. 전역 새 작업에 `…/c/manual-audit-fixture` 유지. 체크된 `…/c/audit-fixture`를 `…/c/edit-check`로 실제 입력 가능. 확장 미연결이라 POST는 이 브라우저에서 실행하지 않음 |
| B0 | 사용자가 작업 트리에 남긴 [격리 매핑 감사](../../evidence/mapping-audit-20261118/fix-report.md), [원본 이어서 캡처](../../evidence/mapping-audit-20261118/fix-continue.txt), [프로젝트 개요 캡처](../../evidence/mapping-audit-20261118/fix-tototest-overview.txt) | 파일과 시나리오 관련성 확인. 보고서의 원본/프로젝트 매핑 조합은 현재 P와 일치. 과거 캡처의 실행을 이번 운영·현재 브라우저 재실행으로 집계하지 않음 |
| F | [workflow-runtime](../../tests/public/workflow-runtime.test.js#L320), [dashboard-io-depth](../../tests/public/dashboard-io-depth.test.js), [dashboard-model](../../tests/public/dashboard-model.test.js) | 공란의 실제 JS body, 승인 버전 본문, 초기 실패·복원, 두 프로젝트/Run 경합, 새 초안 소유권. 대역 fetch·DOM 사용 |
| P | [project-mapping](../../tests/public/project-mapping.test.js) | 원본 Run URL 선택의 양쪽 분기, 프로젝트 분리, URL 삭제/전환, 체크 상태에서 편집한 URL이 true로 캡처되는 사례, 최신 매핑 갱신과 삭제 뒤 URL이 false로 전송되는 사례. 4/4 별도 재실행 |
| H | [preparation-api](../../tests/preparation-api.test.js) | 실제 localhost HTTP + 임시 SQLite/Git. 확장 Web 소켓과 Worker 실행 대역. 잘못된 URL/생략/null/공란 400, ID 없는 매핑·stale URL 409. 202에서 `prep_…` 및 Run null, 초기 매핑 보존. 첫 성공 ACK 후 준비 DB 읽기와 Snapshot 대조. 다음 ACK 실패와 재시작에도 매핑 유지, 같은 세션으로 reconcile. 중복 승인 후 `code_…` 한 건, Run 저장 값과 준비 `resultingRunId` 상호 대조, 재시작 후 같은 승인 영수증. 이전 Run을 APPLIED fixture 상태로 두고 계보와 정확 매핑을 함께 제출해 새 준비·Run null 확인. 성공 ACK 후 준비 취소와 재시작에서도 동일 매핑과 Run 한 건 유지 |
| S | [preparation-service](../../tests/preparation-service.test.js) | 실제 준비 SQLite + 대역 Web 및 Run 콜백. 원본 폴더 실경로·APPLIED·없는 ID 거부, 새 대화 ID, 저장 매핑 대조, 초기 취소, 준비와 승인 경계 |
| R | [preparation-recovery-write](../../tests/preparation-recovery-write.test.js) | 실제 임시 SQLite·대역 Web. ACK/쓰기 실패와 원본 문맥 유지, 재전송 금지, 다른 소유권·버전·동시 상태 변경 거부 |
| E | [conversation-bootstrap-tab](../../tests/conversation-bootstrap-tab.test.js), [web-root-start](../../tests/web-root-start.test.js) | 탭 생성·기존 탭 사용, inventory 변경·복수 탭, 시작 바인딩. 기존 `web-root-start`의 7건은 VM fixture가 `createDecisionEvidenceRelay`를 정의하지 않아 dispatch 전에 실패. 해당 실패 경로 증거 없음 |
| Q | [dashboard-controller](../../tests/dashboard-controller.test.js) | 실제 상태 인증·직접 시작 우회 410/거부 경계 및 Run별 요약의 준비/대화 매핑. 상태 Snapshot에서 다른 준비 분리 확인은 S/F도 적용 |
| A | [code-change-service](../../tests/code-change-service.test.js#L9) | H와 함께 실행한 호스트 테스트 15/15. Worker·리뷰 제공자는 대역, 실제 임시 Git/SQLite에서 구현·감사·후보 일치 검사·명시적 적용·재시작 확인. H와 A는 별도 실행이며 동일 Run 전체의 단일 종단 증거는 아님 |

첫 브라우저 연결 시도에서 `8787`은 연결을 거부했다. 이후 사용자 요청으로 빈 임시 작업공간의 격리 대시보드를 `8787`에 띄웠고 인앱에서 서버 응답·대시보드 인증 및 확장 대기를 확인했다. 이 응답은 운영 DB나 실제 확장과 연동한 증거가 아니다. 감사 중 UI 조작은 `60042`의 합성 데이터에서 수행했다.

### 재실행 명령

```powershell
node --experimental-sqlite --test --test-concurrency=1 tests/preparation-api.test.js tests/preparation-service.test.js tests/preparation-recovery-write.test.js tests/public/project-mapping.test.js tests/public/dashboard-model.test.js tests/public/dashboard-io-depth.test.js tests/public/workflow-runtime.test.js tests/conversation-bootstrap-tab.test.js tests/web-root-start.test.js tests/dashboard-controller.test.js
node --experimental-sqlite --test --test-concurrency=1 tests/preparation-api.test.js tests/code-change-service.test.js
```

첫 샌드박스 시도는 205/216 통과 및 11건 실패였다. 호스트에서 209/216이 통과해 루프백 HTTP의 `fetch failed` 4건이 사라졌고 위 7건이 남았다. 테스트 추가 후 첫 명령의 최종 호스트 결과는 **210/217 통과, 7 실패, 0 건너뜀**이다. 실패는 모두 E의 `web-root-start` VM 대역 경계에서 재현됐다. 입력별로 복구 성공/완료 재조회, recheck/details/owner 변경/reservation 오류, closed/throw 전송을 시험하려 했으나 공통 ReferenceError가 fixture 평가에서 발생해 각 예상 결과에 도달하지 못했다. 두 번째 명령은 **15/15 통과**이며 공통 H 한 건을 포함하므로 첫 명령과 합산하지 않는다.

`tests/platform/browser.contract.mjs`와 `scripts/e2e/helpers/initial-tab-selection.mjs`를 기존 브라우저 회귀로 확인했다. 독립된 인앱 검증을 수행했고 전체 브라우저 테스트 모음은 이 감사에 실행하지 않았다.

마지막으로 이어서 작업·취소 영속화 검증을 H에 추가한 뒤 H와 P를 다시 실행해 **5/5 통과**했다.

이전 실행에서는 실제 ChatGPT 대화 발급·전송이 미기록이었다. 후속 격리 실행에서는 인증된 확장으로 실제 신규 대화 한 건을 생성·전송하고, 응답 검증·ACK·SQLite 매핑과 대시보드 재조회까지 확인했다. 최초 미인증의 원인, 운영 연동, 격리 서버 재시작 후 같은 대화의 복원, 잘못된 매핑의 실환경 바인딩 및 실제 제공자 응답과 매핑 변경의 경합은 `NOT_RECORDED`다. [후속 실환경 검증과 조작별 관측](dashboard-extension-minimal-ux.md)
