# 대시보드 대화·ID 현행 계약

2026-11-18 KST · 감사 상태 `CONTRACT_MISMATCH_FOUND` · UX 결정 `CONTRACT_DECISIONS_PENDING`

## 기준과 증거

- **W**는 `forensics-20261110`의 로컬 HEAD `bef58bccead1f9a205ae9044940655044dabe304` 위에서 관찰한 작업 트리다. 시작 시 수정 92개, 삭제 1개, 미추적 항목 29개였다(기본 porcelain, 디렉터리 묶음 포함). 표의 SHA 열은 이 커밋과 작업 트리를 함께 가리킨다. 변경 전 커밋 자체의 재현 결과로 해석하면 안 된다. 작성 범위는 이 계약 문서와 격리 테스트다.
- 원격 `HEAD`는 `refs/heads/master`, `6f69b710cc6267d80fdc2b922f731289a88fc3cb`로 `git ls-remote --symref origin HEAD`에서 확인했다. 이전 검토 PR #6의 head는 `bc5be505af5b209f44be36e1090145e2e0bf833d`다. [PR #6](https://github.com/jaehoon6523/app-web-agent-bridge/pull/6)
- `STATIC_CONFIRMED`는 소스, `TEST_CONFIRMED`는 대역 DOM·서비스·브라우저 API 테스트, `INTEGRATION_CONFIRMED`는 해당 행의 격리 HTTP/SQLite 또는 실제 인앱 DOM 관측, `OPERATION_CONFIRMED`는 운영 증거를 뜻한다. `NOT_RECORDED`는 주장에 해당하는 실행이나 자료가 없고, `NOT_OBSERVABLE`은 그 관측 지점에 값이 없다는 뜻이다. `USER_REPORTED`는 제출된 출처 표기다. 인앱 `8787` 첫 연결은 거부됐고 이후 사용자 요청으로 같은 포트에서 임시 DB에 연결한 격리 서버를 열었다. 운영 수준 판정은 없다.
- 상태는 `현행 구현 확인`(현재 코드 확인), `확정`(정책 승인 및 해당 범위의 증거 확보), `검토 필요`(정책 결정 전), `미검증`(정의된 정책의 실행 증거 부족), `불일치`(명시된 계약 또는 UI 의도와 실행이 다름), `폐기`(공식 효력 종료)로 구분한다. 이번 감사에서 새 정책을 확정하거나 기존 정책을 공식 폐기한 항목은 없다.
- 기존 계약표 전체를 확보하지 못했다. 아래 ID의 주제 배정은 제출 지시의 기능 범위에 따른 감사 인덱스다. 이전 문장과의 동일성을 보증하지 않는다. 과거 출처와 집계 기준은 [변경 이력](dashboard-conversation-changelog.md)에 있다.

## 독립된 세 경로

1. **작업 계보**는 `followUpRunId`로 지정한다. 서버가 기존 Code Run의 `APPLIED`와 두 폴더의 native realpath 일치를 확인한다. 원본 ID·목표·후보 ID·요구사항과 제한된 사용자 `NOTE`/`DECISION`을 새 준비에 저장한다. 준비 프롬프트는 원본 목표·요구사항·메모를 참고로 전달한다. 서버는 원본 URL을 읽어 새 URL을 정하지 않는다. 새 목표, 준비, 동의와 실행은 독립적이다.
2. **저장 매핑 재사용**은 `reuseProjectConversation === true`일 때 시작 요청에서 검증한다. 대상은 정규화된 폴더 키의 레코드이고, 조건은 저장 ID가 truthy이며 trim한 요청 URL 문자열이 저장 URL과 정확히 같다는 것이다. 매핑 ID를 세션에 복사하지 않는다. 초기 세션 ID는 입력 URL에서 도출하고, 브라우저 바인딩·응답 소유권은 후속 단계에서 검증한다.
3. **신규 대화**는 프런트 공란을 표준 시작 URL `https://chatgpt.com/`로 보낼 때 선택된다. 시작 시 URL·Conversation ID가 null인 세션이다. 시작 탭은 `ROOT_READY`에서 ID가 없다. 전송 후 정확 대화로 바뀐 바인딩이 관측되고 완료·소유권과 ACK가 확인되면 매핑을 저장한다. 대화 URL 직접 입력은 별도 경로이며, 체크박스 해제 상태에서도 기존 대화로 연결될 수 있다.

## 구현 계약

| ID | 기능 | 조건 | 실제 입력 | 실제 결과 | 코드 위치 | 테스트 | 증거 수준 | 확인 SHA |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C-UI-01 | 시작·새 작업 | START, 목록/권한 확인 | `#newRun`, `#newProjectTask`, `#startForm` | 프로젝트 새 작업은 폴더를 채우고 목표·URL 초기화 후 매핑 적용. 전역 새 작업은 수동 URL과 목표·폴더가 남을 수 있음. 입력은 확장 미인증에도 가능, 제출은 차단 | [app.js](../../public/app.js#L1182), [시작 게이트](../../public/dashboard-start-actions.js) | F, P, B | INTEGRATION_CONFIRMED 폼 | W |
| C-UI-02 | 대화 선택 | START의 trim된 폴더 문자열 일치, truthy 저장 ID | `#conversationUrl`, `#reuseProjectConversation` | 자동 체크·URL, 해제 시 공란. 렌더 후 기존 대화 입력이 편집 가능하며 체크 상태도 유지됨. 동일 루트 최신 매핑 교체 시 자동 변경, 매핑 삭제 시 URL 잔존 가능 | [app.js](../../public/app.js#L486), [preparation-view.js](../../public/preparation-view.js#L40) | F, P, B | INTEGRATION_CONFIRMED 토글·편집, TEST_CONFIRMED 교체·삭제 | W |
| C-UI-03 | 프로젝트 개요·이력 | 프로젝트 선택, 해당 프로젝트 Run/매핑 존재 | `#runList`, `#projectOverview` | `#overviewConversation`은 저장 URL·출처 준비 ID, `#overviewTasks`는 Run별 URL·준비 ID·Run ID. 없는 매핑은 ‘저장된 프로젝트 대화 없음’, 카드의 빈 값은 ‘기록 없음’. 개요에는 불완전 매핑도 표시될 수 있음 | [project-overview-view.js](../../public/project-overview-view.js#L24), [app.js](../../public/app.js#L423) | P, B, H | INTEGRATION_CONFIRMED 개요, TEST_CONFIRMED Run 카드 | W |
| C-UI-04 | 준비 식별자 표시 | 준비 Snapshot, 시작 연결/준비 화면 | `preparation.preparationId`, `webSession.conversationUrl` | 저장/활성 복구 문구의 준비 ID, 시작 연결은 입력에 현재 준비 값, `#planningUrl`은 세션·준비 URL 또는 공란. `resultingRunId:null`이면 Code Run 표시 없음 | [app.js](../../public/app.js#L306), [app.js](../../public/app.js#L929), [preparation-view.js](../../public/preparation-view.js#L1) | F, H | TEST_CONFIRMED DOM, INTEGRATION_CONFIRMED 상태·DB | W |
| C-UI-05 | 작업 계보 표시 및 최신 응답 | 원본 APPLIED·미보관 UI, 새 폼 및 Run 전환 | `#continueProject`, `#followUpSource`, `#planningFollowUp`, `#runFollowUp` | 원본 ID와 새 승인 안내, URL 우선순위는 RULE-02/04. 늦은 GET은 sequence/selected, 복구에는 프로젝트·준비 ID/버전도 대조. 최신 매핑 변경은 별도의 방어 경계 | [app.js](../../public/app.js#L190), [app.js](../../public/app.js#L1190), [app.js](../../public/app.js#L1244) | F, P | TEST_CONFIRMED | W |
| C-API-01 | 준비 생성 | 런타임·활성 작업 게이트, 입력 검증 | POST `/api/preparations` | 202 준비 Snapshot, `prep_…`, `resultingRunId:null`. 잘못된 입력 400, 충돌 409. 새 레코드와 전송 의도를 저장한 뒤 비동기 전송 | [server.js](../../src/server.js#L530), [preparation-service.js](../../src/orchestration/preparation-service.js#L184) | H, F | INTEGRATION_CONFIRMED | W |
| C-API-02 | 상태 조회 | 인증된 dashboard GET | `/api/state`, `?runId=…`, `?view=start`, `?requestId=…` | 코드/디스커션 조회 후 `workflow`, `preparation`, `activePreparation`, `run`, `runs`, `projectConversations`, `deliveries`, `commandCapabilities`, `preflight`, 선택 `requestResult`. 선택 Run에는 연결된 준비만 투영 | [server.js](../../src/server.js#L645), [dashboard-controller.js](../../src/orchestration/dashboard-controller.js#L85), [preparation-service.js](../../src/orchestration/preparation-service.js#L935) | H, F | INTEGRATION_CONFIRMED | W |
| C-API-03 | 준비 변경·승인 | URL의 준비 ID 및 현재 정수 버전 | POST `/api/preparations/:id/{reply,approve,cancel,discard}`, Web 명령 `/api/preparations/web` | 승인 200 `{runId}`, 답변 202 Snapshot, 취소·폐기 200. 동일 요청 ID/내용 재조회로 중복 실행 제한. 버전·소유권이 다르면 충돌. URL ID는 body ID보다 우선 | [server.js](../../src/server.js#L530), [preparation-service.js](../../src/orchestration/preparation-service.js#L110) | H, S, R | INTEGRATION_CONFIRMED 승인·답변·재조회, TEST_CONFIRMED 나머지 | W |
| C-ACT-01 | 이어서 작업 | 원본 Code Run `APPLIED`, 같은 프로젝트 실제 경로 | `followUpRunId` 생략/null 또는 원본 ID | null/생략은 계보 없음. 빈 ID, 미발견/미적용, 폴더 불일치는 각각 `INVALID_FOLLOW_UP`, `FOLLOW_UP_UNAVAILABLE`, `FOLLOW_UP_PROJECT_MISMATCH`. 신규 준비에 원본 맥락만 연결 | [preparation-service.js](../../src/orchestration/preparation-service.js#L201), [handoff](../../src/orchestration/preparation-follow-up.js) | H, S, F, P | INTEGRATION_CONFIRMED 정상 계보, TEST_CONFIRMED 거부 | W |
| C-ACT-02 | 새 준비 승인 | READY, 확정 전송·서버 권한 | 수동 승인 또는 최초 1회 옵션의 자동 시도 | 별도 `code_…` 예약 후 생성. 이전 Run 승인 미승계. 준비 재승인/재시작 시 예약 ID로 같은 실행 확인 | [app.js](../../public/app.js#L273), [preparation-service.js](../../src/orchestration/preparation-service.js#L329), [server.js](../../src/server.js#L345) | H, F, S | INTEGRATION_CONFIRMED 수동·중복, TEST_CONFIRMED 자동 조건 | W |
| C-TX-01 | 새 대화 및 바인딩 | 정확한 시작 URL 또는 명시적 기존 URL | `conversationUrl`, 확장 세션·전송 증거 | 최초 표준 시작 URL에서 unbound → ROOT_READY(null ID) → BOUND. 기존 URL의 ID는 초기 입력 기반, BOUND 및 응답 증거 이후 확인. 외부 탭 생성 예외/실패 범위는 결정표 | [preparation-service.js](../../src/orchestration/preparation-service.js#L225), [generate](../../src/orchestration/preparation-service.js#L421), [extension/background.js](../../extension/background.js#L434) | S, E, H | TEST_CONFIRMED 신규, INTEGRATION_CONFIRMED 정확 URL Mock Web 경로, 실계정 NOT_RECORDED | W |
| C-TX-02 | 프로젝트 대화 영속화 | 완료 증거·ACK 재확인·버전 대조 및 DB 커밋 | 세션의 확정 URL·ID, 준비 ID, 폴더 | 준비 SQLite `preparation_state.json` 안 `projectConversations[targetRoot]`에 URL·ID·준비 ID·갱신시각을 원자 갱신. 질문만 있는 응답도 가능. 초기 실패·ACK 실패·취소는 기존 매핑을 보존하며 성공 후 취소도 성공 매핑을 롤백하지 않음 | [preparation-service.js](../../src/orchestration/preparation-service.js#L513), [완료 커밋](../../src/orchestration/preparation-service.js#L604) | H, R, S | INTEGRATION_CONFIRMED ACK 실패·저장·승인 전 취소·재시작, 나머지 분기는 TEST/STATIC | W |
| C-TX-03 | 준비–Run 연결·후속 단계 | 승인된 준비, 명시적 적용 | 준비 ID·예약 `code_…`·확정 URL | Code Run `record_json`에 `preparationId`, `preparationSnapshot`, `conversationUrl`, `conversationId`, `followUp` 저장. 준비에는 `resultingRunId`. Worker·감사·적용은 같은 Run ID. 리뷰어 세션은 별도 | [code-change-service.js](../../src/orchestration/code-change-service.js#L234), [저장](../../src/persistence/code-change-store.js#L300), [review binding](../../src/orchestration/audit-round.js#L71) | H, A | INTEGRATION_CONFIRMED Run 생성·재시작, A의 증거 범위는 추적표 | W |

판정은 C-UI-02에 `불일치`(렌더러 잠금 의도와 실제 편집), 나머지 구현 행에는 `현행 구현 확인`을 적용한다. RULE과 D의 구현·정책 판정은 [의사결정표](dashboard-conversation-decision-table.md)에 있다. 대역, HTTP, UI의 실행 범위는 [추적성](dashboard-conversation-traceability.md)에 있다.

## 실제 요청과 저장

- 시작 body는 `{requestId, objective, targetRoot, conversationUrl, reviewers:{JUDGE:{provider},CRITIC:{provider}}, autoApproveOnReady, acceptPlainTextDiscussion, reuseProjectConversation, followUpRunId?}`다. `followUpRunId`는 원본을 선택했을 때 포함된다. 결과 바인딩의 Conversation ID·새 Preparation ID·Run ID를 브라우저가 미리 보내지 않는다. 수동/자동 승인 body는 `{requestId, expectedVersion}`, 답변은 `content` 추가, 복구는 해당 준비·세션·대화·전송 소유권 필드와 `command`를 보낸다. UI는 POST 결과로 화면 상태를 직접 확정하지 않고 GET/영수증을 재조회한다.
- 시작 Snapshot은 `preparationId/version/stage/state/lifecycle/objective/targetRoot/conversationUrl/followUp/projectConversationSource/webSession/discussion/agreement/deliveries/resultingRunId` 등을 담는 준비 객체다. 예시 `202 {preparationId:"prep_…", state:"INITIALIZING", resultingRunId:null, …}`. 서버 오류는 `{code,message,retryable:false,workflowStage,preparationId,runId,details}`이고, 이때 준비·Run ID는 현재 레코드의 값 또는 null이다. 응답 유실 상태는 `GET /api/state?requestId=…`로 조회하고 POST를 자동 재전송하지 않는다.
- 준비 DB는 런타임 프로젝트 설정 파일 디렉터리의 `preparations.sqlite`다. `preparation_state`의 `id=1` 행 `json`에 `currentId`, `contexts`, `receipts`, `projectConversations`가 있다. Code Run은 SQLite `code_change_runs(run_id,version,record_json,record_hash)`와 버전별 `code_change_history`에 기록된다. `run.conversationUrl`은 투영된 JSON 속성이다. 코드 내 `runs.conversation_url`, `project_default.conversation_url`을 해당 데이터 출처로 쓰지 않는다. [저장 코드](../../src/persistence/code-change-store.js#L46)
- `POST /api/runs`와 `GET /api/runs/:id`는 이 대시보드 경로가 아니다. `POST /api/runs/start`는 410 `PREPARATION_API_REQUIRED`다. `form#create`, `ConversationCell`, `PreparationCell`, `RunCell` 대신 실제 ID와 렌더러를 위 표에 기록했다. [라우팅](../../src/server.js#L642)

## 수명주기

| 상태 | 준비 ID / Code Run ID | 대화 URL·ID와 매핑 | 원본·UI·전송·영속 증거 |
| --- | --- | --- | --- |
| 1. 새 폼 진입 | 새 ID 없음 / 없음 | URL은 선택·자동입력·기존 필드에 따라 다름. 매핑 시각은 `updatedAt`의 마지막 성공 커밋 시각 | `#startForm`. 개요에 원본 작업 카드가 남아도 새 ID가 아님. GET에 이전 닫힌 준비가 남을 수 있으므로 `lifecycle`로 구분 |
| 2. 생성 전 | 없음 / 없음 | trim 및 공란 정규화, 저장 매핑 검사 전 | POST body의 계보·재사용 플래그는 각각 선택. 게이트/검증 실패에는 새 컨텍스트 없음 |
| 3. 생성 완료 | `prep_…` / null | 초기 준비 URL은 입력. 표준 루트 세션 URL·ID null, 기존 URL ID는 입력 기반 | `202`, 전송 `RESERVED`와 준비 저장, Snapshot `START/CONNECTING_WEB` 가능 |
| 4. 대화 준비·응답 | 동일 / null | `ROOT_READY`는 시작 URL+null ID. 새 정확 URL·ID는 BOUND 응답에 생김. 소유권·ACK 전에는 매핑 유지 | `WAITING_WEB_RESPONSE`, 첫 응답 전 START 투영 가능. 준비 ID가 Web 프로토콜의 `runId` 슬롯에 들어가지만 Code Run은 아님 |
| 5. 승인 대기 | 동일 / null | 성공 응답 및 ACK 처리마다 매핑 갱신. 질문 시 `DISCUSSING`, 질문 없이 READY면 `AGREEMENT_READY` | `#planningUrl`, 저장된 준비 ID, 요구사항. 답변은 같은 준비 ID·버전 및 새 요청/전송 ID |
| 6. 승인 처리 | 동일 / `reservedRunId` 예약, `resultingRunId`는 아직 null 가능 | 대화 바인딩 유지. 서버가 Git 준비 및 새 작업 요구사항 설정 | 내부 `APPROVING`. `POST …/approve`, 예약 값만으로 실행 존재 판정 금지 |
| 7. Code Run 저장 | 준비 연결 / 새 `code_…` | 정확 URL 정규화·대화 ID 저장. 프로젝트 매핑과 별도 레코드 | Run `CREATED` → workflow `RUN_CREATED`. 승인 200, 준비 `COMPLETED/WORK`, Snapshot Run·준비 상호 연결. 중간 쓰기 실패 시 예약 ID로 재연결 가능 |
| 8. Worker | 동일 / 동일 | 구현 작업과 코드 변경 기록은 해당 Run에 귀속 | `WORKER_RUNNING`/`VERIFYING` 등, Run 및 역할 UI. `GET /api/state` 확인 |
| 9. JUDGE·CRITIC | 동일 / 동일 | ChatGPT JUDGE만 최초 Run의 준비 대화 URL·ID로 시작. CRITIC 및 다른 provider의 초기 바인딩은 null, 후속 검토는 역할별 세션 확인 | `conversationBindings`, `REVIEW_RUNNING`/`HOLD`/재작업. 리뷰어 URL을 프로젝트 매핑으로 승격하지 않음 |
| 10. 코드 적용 | 동일 / 동일 | 적용은 새 대화·ID를 만들지 않음 | `AWAITING_APPLY`는 RESULT 투영이어도 적용 전. `code.apply`는 동일 후보·검토·대상 HEAD 확인 후 `APPLYING`→`APPLIED` |
| 11. 종료·실패·복구·취소 | 생성한 ID 보존 / 실행이 없으면 null | 미확정 응답/초기 오류는 기존 매핑 유지. 준비 취소/폐기는 `ABANDONED`, Run은 `CANCELLED`/`FAILED` 등. `RECOVERY_REQUIRED`는 종료와 다름 | 이전 준비·전송과 오류를 저장. 초기 Web 차단은 START에 남을 수 있고 Run 복구는 WORK. 승인 전 취소는 Run을 만들지 않음 |
| 12. 이어서 작업 | 클릭만으로 새 ID 없음 / 원본 ID는 참조만 | 저장 매핑 우선, 같은 폴더·매핑 미선택 시 현행은 원본 URL 자동입력 가능 | 서버 `followUpRunId`와 URL 별도 검증. 이후 2–11의 새 ID와 승인 규칙 적용 |

[UX 목표](dashboard-conversation-to-be.md) · [의사결정표](dashboard-conversation-decision-table.md) · [추적성](dashboard-conversation-traceability.md) · [변경 이력](dashboard-conversation-changelog.md)
