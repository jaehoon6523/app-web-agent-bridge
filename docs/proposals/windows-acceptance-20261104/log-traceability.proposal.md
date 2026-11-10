# C. 기존 로그·영수증 기반 추적성 명세

**승인용 제안 / 미반영.** 검토 기준은 [A](windows-product-acceptance.proposal.md)와 같다. 이번에는 로그 시스템·코드·테스트를 추가하지 않았다.

## 판정과 기존 자료

**부분 연결 가능 / 실제 Windows 전체 trace 미확인 / compact export만으로 불충분**이다. 로그 파일의 양이나 존재가 충분성을 증명하지 않는다.

| 자료 | 이미 있는 연결·내용 | 보장하지 않는 것 |
|---|---|---|
| 준비 SQLite context/receipts | requestId→preparationId/version, deliveries/trace/discussion/agreement, reserved/resultingRunId | HTTP 관측 ID 조인·미확정 전송 성공 |
| CodeChangeStore run/history·audit_command_receipts | command requestId/hash→runId/결과, version·해시 체인, events/messages/candidate/reviews/application | INTENT만으로 수행 완료·외부 모델 품질·원천 서명 |
| Web receipt·private response·artifact | run parent 아래 delivery/session/role→응답/packet hash·ACK_PENDING/ACKNOWLEDGED | 저장만으로 ACK/생성 종료, 공개 raw 본문 |
| AuditManifest/reviewArtifacts/coordinationEvents | 후보·요구사항·증거·findings·role binding·reasoning/assertions hash | 오래된 manifest의 현재 권한·동일 대화 리뷰의 독립성 |
| server observer JSONL | pid·socketId·증분 숫자 requestId·route·stage·status·단조 시각/elapsed | 사용자 command requestId와 동일 ID·본문/credential 조인 |
| runtime-latest·extension offline export | processInstanceId·diagnosticId·bounded incidents·탭/전송 메타데이터 | 전체 이력·ACK authority·cross-store 원자 snapshot |
| verification run/stage/file receipt | source/head·실행 ID·예정 집합·terminal·PID/closure | 테스트 PASS를 제품 완주로 승격·kill 요청을 회수 완료로 승격 |

## 기존 ID를 이용한 연결 명세

사용자 command requestId와 observer의 숫자 requestId는 다른 namespace다. 명세에서는 의미를 `commandRequestId`와 `httpRequestObservationId`로 구분한다. wire 필드 즉시 rename이나 새 trace ID 도입을 요구하지 않는다. 숫자 requestId는 서버 processInstance/기동 맥락 안에서만 유일하며 재시작을 넘어 같은 ID로 조인하면 안 된다.

| 연결 | 정본 연결키 | 전이·결과 확인 | 현재 판정 |
|---|---|---|---|
| UI→HTTP→준비 | command ID·preparation/version + 서버 process/HTTP 관측 ID | receipt·응답·context 버전 | 영속 연결 있음, HTTP↔command 명시 연결 부족 |
| 준비→전송→응답 | preparation/session/delivery + exact conversation/document·message/turn trace | validation→저장→ACK→COMPLETE | 코드 지원; 실제 Windows 전체 증거 미확인 |
| 승인→Worker→후보 | reserved/resultingRunId·worker thread/turn·candidate/tree/patch/hash | approval receipt→capture→검증 | 원본에 있음; compact export의 후보 연결 부족 |
| 후보→감사→재검증 | run/candidate/manifest·role/session/requestId·evidence refs | finding lifecycle·새 manifest·판정 | 원본 run/artifact로 연결, 진단 일부 ID 누락 |
| Apply→재시작 | command/run/application·candidate/review/hash/base/version | APPLYING→실제 tree→APPLIED/RECOVERY_REQUIRED | 구현 있음; 단일 latest만으론 전후 이력 부족 |
| 오류→복구→재시도 | 같은 run/session/delivery·before/after version/state·error code·출처 | reconcile 관측·명시적 복구 결과 | 자료 있음; latest가 정본 이력 대체 못함 |

## 확인된 단절과 필요한 연결만 보완하는 안

### L1. ID 문법 불일치 — P1, 정적 코드로 확인

diagnostic-schema.js의 identityPattern은 UUID 또는 제한된 prefix만 허용한다. preparation.approve는 `code_<UUID>` reservedRunId를 생성하며 CodeChangeService가 사용한다. audit-round의 roleSessionId는 `web_<runId>` 또는 `web_<runId>_critic`이다. 이 값들은 공통 diagnosticId를 통과하지 못한다.

diagnostic projection에서 null이 될 수 있고, readPersistedDelivery는 소유자가 있으면 delivery/session/run 모두 diagnosticId를 통과해야 읽으므로 해당 형식에 `DELIVERY_IDENTITY_INCOMPLETE`/UNAVAILABLE을 반환할 수 있다. 실제 Windows 발생 빈도는 미측정이며 원본 run DB 손실·전송 권한 검사 결함을 뜻하지 않는다.

**개선안:** 실제 생성기가 만드는 제한된 문법만 진단/read-only 연결에서 허용하고, role/candidate는 기존 원본 run/artifacts 참조로 연결한다. 자유 텍스트·URL·본문을 허용하는 regex 확장은 금지한다. roundtrip·잘못된 ID 거절·redaction의 기존 검사 보완은 별도 승인 대상이다.

### L2. HTTP↔사용자 행동 조인 부족 — P1, 정적 코드로 확인

server-observer requestId는 `++sequence`다. preparationRoute는 mutation.started/completed/failed에 command ID·preparation/version을 전달하지 않는다. /api/commands의 durable receipt와 HTTP 관측 사이에도 명시 연결이 없다. 시각·본문·URL로 추정 조인하지 않는다.

**개선안:** 기존 observer stage 호출에 검증된 command ID, preparation/run, before/after version/state, 안전한 결과 code를 필요한 범위만 연결한다. 새 header·logging service·본문 수집은 제안하지 않는다. 모든 필드가 현재 수집된다고 주장하지 않는다.

### L3. 최신 snapshot의 역사 한계 — P1, 설계 한계

runtime-latest는 최신 section merge이고 incidents는 최대 32개·중복 합산이다. 전체 전이 이력이 아니다. 재시도 안전성은 run history·command receipt·delivery receipt·read-only reconcile로 판단한다.

**개선안:** 기존 audit export를 정본 이력으로 유지하고 latest에는 필요한 history version/artifact ref·복구 결과 참조만 보완한다. 이력을 새 로그에 복제하지 않는다. stale/unavailable/truncated와 별도 저장소 관측 시각을 보존한다.

### L4. 종료 요청≠실제 종료 — P1, 실행기 경계

일반 runOwnedNode catch는 kill 뒤 close를 항상 관측·보존하지 않는다. 후보 E Discovery에서 확인됐고 현재 코드에도 일반 경로가 있다. Windows 제품의 실제 누수로 단정하지 않는다. 승인 후 기존 유한 close 도구로 관측하고 timeout FAIL·자원 미확인 후속 차단을 유지하는 최소 변경안이다. Ubuntu 문제 해결을 Windows 첫 연결 조사의 선행조건으로 만들지 않는다.

## 실패 시 답해야 할 6개 질문

| 질문 | 사용할 자료 | 현재 답변 가능성 | 자료 부족 시 |
|---|---|---|---|
| 어느 사용자 행동인가? | command receipt·preparation/run 연결 | 영속 자료로 부분 가능, HTTP 조인 미완전 | 행동 ID UNKNOWN, 시간으로 추정 금지 |
| 어느 블록 중단인가? | observer stage·runtime code·run/prep state | 부분 가능 | 마지막 관측 블록만 명시 |
| 어떤 상태→어떤 상태인가? | context/run history version·command intent | 원본 이력 필요, compact export 부족 | before/after UNKNOWN, 성공 전이로 간주 금지 |
| 마지막 확정 동작은? | 완료 receipt·ACK·verified tree·close | 기록별 가능 | sent/stored/kill을 완료로 승격 금지 |
| 재시작 후 복구 상태는? | recovered record·reconcile·startup scan | 코드 지원, 실제 Windows trace 미검증 | 복구 필요/UNKNOWN 유지 |
| 다시 시도해도 안전한가? | 완료 receipt·exact ownership·target/외부 idle | 조건부 | 미확정 resend/rerun/apply 금지, inspect/operator 확인 |

## 민감정보·수용 완료 조건

프롬프트/응답 본문·editable 값·token/secret·자유 오류 message/stack·URL query는 운영 진단에 넣지 않는다. 기존 private response storage와 public redacted evidence를 구분한다. conversation hash는 공개 참조이며 권한이 아니다. ID도 형식·길이를 검증한다. process별 단조 시계 origin을 같다고 가정하지 않는다.

동일 Windows 실행의 허용된 성공·차단·복구에서 6개 질문에 기존 자료로 답하고 공개 export의 민감정보 배제를 확인해야 추적성 PASS다. 로그의 존재나 schema 코드만으로 PASS하지 않는다. 기존 bounded reconnect·transaction contention retry·UI 조회 polling은 mutation 자동 재실행과 구분하며 임의 삭제·단축하지 않는다.

## 원본 근거

- [진단 schema](../../../src/diagnostics/diagnostic-schema.js), [read-only delivery](../../../src/diagnostics/persisted-delivery.js), [준비 ID](../../../src/orchestration/preparation-service.js), [role session](../../../src/orchestration/audit-round.js)
- [HTTP observer](../../../src/diagnostics/server-observer.js), [route 연결](../../../src/server.js), [durable command](../../../src/orchestration/dashboard-controller.js)
- [run/history](../../../src/persistence/code-change-store.js), [응답·ACK](../../../src/orchestration/web-delivery-receipts.js), [복구 audit](../../../src/diagnostics/delivery-recovery-audit.js)
- [latest 수집](../../../src/diagnostics/agent-report.js), [저장·합산](../../../src/diagnostics/report-store.js), [실행기](../../../scripts/e2e/platform/process.mjs)
- [기존 진단 설명](../../automatic-agent-diagnostics.md), [보호 계약](../../diagnostic-safety.md)
