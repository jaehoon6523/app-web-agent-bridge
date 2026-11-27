# 대시보드 대화 계약 변경 이력

2026-11-18 KST · [현행 계약](dashboard-conversation-as-is.md) · [UX 목표](dashboard-conversation-to-be.md) · [결정표](dashboard-conversation-decision-table.md) · [추적성](dashboard-conversation-traceability.md)

## 이전 자료 확인과 집계

- 기준 자료는 사용자가 지칭한 「대시보드 작업 대화/ID 표시 계약표」다. 작업 트리와 이전 기준 커밋 `bc5be505af5b209f44be36e1090145e2e0bf833d`, 로컬 refs의 Git 이력에서 `C-UI-01`/`RULE-04`로 검색했다. GitHub REST에서 PR #6의 head와 본문을 확인했고 공개 조회의 issue comments, inline pull comments, reviews는 각 0건이었다. 전체 이전 문구를 찾지 못했으며, 아래 이전 계약 열은 사용자 제공 단서만 귀속한다. [PR #6](https://github.com/jaehoon6523/app-web-agent-bridge/pull/6)
- `#1234`와 `#1235`는 이 저장소의 GitHub Issues API에서 둘 다 404였다. 작업 트리와 이전 기준 트리의 `assets/screenshot-*.png`도 찾지 못했다. 세 참조는 `USER_REPORTED`로 보존한다. 이전 [명령 계약 감사](../dashboard-contract-audit.md)는 실제 존재하지만 별도 34개 동작 인덱스다. 기존 [매핑 감사 증거](../../evidence/mapping-audit-20261118/fix-report.md)의 PNG·텍스트는 다른 경로와 이름을 갖는 격리 기록이다.
- **원계약 22개 대조**는 문장과 ID의 정확한 연결을 기준으로 일치 0, 불일치 0, 미검증 22다. RULE-04의 기존 계약 공백은 제공된 단서에 따라 별도로 보존했다. **명시적으로 제공된 참조 비교**에서는 7개 비교행 모두 불일치이며, 마지막 행이 두 이름을 포함해 총 8개 참조를 정정했다. **현행 감사 인덱스**는 기존 ID 22개(구현/룰 18개, 정책 4개)를 전부 추적했고 추가 RULE 4개를 부여했다. 이 집계는 서로 다른 검증 단위다.
- 작업 트리의 제품 소스 지문은 `ed25db1be43834e03c87f1417fbacbd5a226ccde742a1fcd93b2b3cbc059401e`다. `git ls-files -co --exclude-standard -- public src extension package.json`에서 존재하는 파일 227개를 PowerShell `Sort-Object -Unique`로 정렬했다. 각 파일의 SHA-256 소문자 + 공백 두 칸 + 상대 경로를 LF로 연결하고 마지막 LF를 포함한 UTF-8 바이트에 SHA-256을 적용했다. 테스트·문서와 기존 증거 디렉터리는 지문 범위 밖이다.

## 이전 문구에서 확인된 참조 정정

| 날짜 | ID | 이전 계약 | 변경 계약 | 변경 이유 | 근거 | 검증 수준 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-18 | C-API-01 | `POST /api/runs` | `POST /api/preparations`, 직접 `/api/runs/start`는 410 | 대시보드 요청은 준비를 먼저 생성 | [server.js](../../src/server.js#L558), H | INTEGRATION_CONFIRMED 실제 준비/410, 이전 미등록 경로 STATIC |
| 2026-11-18 | C-API-02 | `GET /api/runs/:id` | `GET /api/state?runId=…` | 선택 Run 및 준비는 Snapshot으로 조회 | [server.js](../../src/server.js#L645), H | INTEGRATION_CONFIRMED |
| 2026-11-18 | C-TX-03 | `runs.conversation_url` | `code_change_runs.record_json`의 `conversationUrl` | 관계형 URL 열 대신 실제 콘텍스트 저장 | [저장](../../src/persistence/code-change-store.js#L46), H | INTEGRATION_CONFIRMED 실제 Run 재조회 |
| 2026-11-18 | C-TX-02 | `project_default.conversation_url` | `preparation_state.json`의 `projectConversations[실경로]` | 프로젝트 대화의 실제 저장 소유자 | [완료 커밋](../../src/orchestration/preparation-service.js#L633), H | INTEGRATION_CONFIRMED 준비 DB 직접 조회 |
| 2026-11-18 | C-UI-01 | `form#create` | `#startForm` | 실제 시작 폼 | [index.html](../../public/index.html#L98), B | INTEGRATION_CONFIRMED |
| 2026-11-18 | C-UI-02/03 | `ConversationCell` | `#conversationUrl`, `#planningUrl`, `#overviewConversation`/카드 | 단계별 URL 표시 분리 | [app.js](../../public/app.js#L486), B/P | INTEGRATION_CONFIRMED 폼·개요, 나머지 TEST/STATIC |
| 2026-11-18 | C-UI-03/04 | `PreparationCell` / `RunCell` | 준비 상태 문구와 `#overviewTasks` 카드 | 준비·실행 값의 실제 표시 위치 | [개요](../../public/project-overview-view.js#L61), P/F | TEST_CONFIRMED |

## 기존 ID 보존 및 추가 규칙

| 날짜 | ID | 이전 계약 | 변경 계약 | 변경 이유 | 근거 | 검증 수준 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-18 | C-UI-05 | 원문 미확보 | 계보 표시 및 초안/조회 소유권 추적 | 이전 Run과 현재 입력의 귀속 확인 | F·P·B | TEST/INTEGRATION |
| 2026-11-18 | C-API-03 | 원문 미확보 | 버전·요청 ID가 붙은 준비 변경, 승인 응답 `{runId}` | 준비→실행 전환과 동일 요청 보존 | H·R | INTEGRATION/TEST |
| 2026-11-18 | C-ACT-01/02 | 원문 미확보 | 이어서 작업의 적용·폴더 검사, 새 승인과 독립 실행 | 이전 작업 권한과 새 요구사항 분리 | S·F·H | TEST/INTEGRATION |
| 2026-11-18 | C-TX-01 | 원문 미확보 | ROOT_READY에는 ID 없음, BOUND 및 ACK 이후 매핑 저장 | 입력 추정과 확인 증거 구분 | S·E·H | TEST/INTEGRATION(대역) |
| 2026-11-18 | RULE-01~03 | 원문 미확보 | 새 작업/정상 매핑/토글을 초기화와 요청 단계로 분해 | 실제 URL 잔존·읽기 전용 덮어쓰기 기록 | B·P·F | INTEGRATION/TEST |
| 2026-11-18 | RULE-04 | 계약 공백 지적, 원문 미확보 | 이어서 + 매핑 없음/불완전 + 원본 URL 유무를 명시 | 현행 원본 URL fallback 및 승인 분리 | P·F·S, B0 | TEST, 과거 격리 자료 |
| 2026-11-18 | RULE-05 | 원문 미확보 | null/공란/잘못된 URL/ID 불일치를 분리 | FE truthy 판정과 실제 검증 비교 | H·B·정적 | INTEGRATION/STATIC |
| 2026-11-18 | RULE-06/07 | RULE-04/05의 경합·출처 공백 | 매핑 교체·삭제와 프로젝트/늦은 GET을 별도 규칙으로 추가 | stale body와 최신 응답의 같은 값 변경은 서로 다른 결과 | H·F·P | INTEGRATION/TEST |
| 2026-11-18 | RULE-08/09 | RULE-04/05의 연결·실패 공백 | 신규 ID·탭 준비와 실패·복구·중복 보존 규칙 추가 | 준비 DB·Run DB·확장 상태의 시간차 | S·R·H·E | INTEGRATION/TEST |
| 2026-11-18 | D-1 | 우선순위 미결정 | 사용자 명시적 선택 우선 권고 | 귀속을 작업자가 확인 | [결정표](dashboard-conversation-decision-table.md) | 정책 승인 미기록 |
| 2026-11-18 | D-2 | 불완전 매핑 미결정 | 재사용 불가 표시 후 새 대화 제안 | 자동 원본 전환과 구분 | [결정표](dashboard-conversation-decision-table.md) | 정책 승인 미기록 |
| 2026-11-18 | D-3 | null/오류 처리 미결정 | 네 상태 구분과 기존 기록 보존 | 진단 및 대화 안전성 | [결정표](dashboard-conversation-decision-table.md) | 정책 승인 미기록 |
| 2026-11-18 | D-4 | 공란 제출 의미 미결정 | UI는 표준 루트 전송, API는 생략/null/공란 거절 유지 권고 | 의도 명시 및 입력 검증 | F·H, [결정표](dashboard-conversation-decision-table.md) | 구현 TEST/INTEGRATION, 정책 승인 미기록 |

이 감사에서 기존 [명령 계약](../dashboard-contract-audit.md), [사용자 워크플로 안내](../../public/WORKFLOW_CONTRACT.md), 이전 증거는 보존했다. 이력의 ID 배정은 이번 감사의 기능 인덱스이며 원문 ID와의 문장 단위 대조 여부를 나타내지 않는다.
