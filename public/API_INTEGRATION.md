# UI 연동 요구사항

이 UI는 WORKFLOW_CONTRACT.md의 서버 상태를 사용한다. 현재 src/server.js의
legacy proposal API로 fallback하지 않는다. 서버에 workflow가 없으면 연결
안내를 표시하고 명령을 비활성화한다.

프런트엔드가 사용하는 준비 명령:

| 요청 | payload (공통 requestId 포함) |
|---|---|
| POST /api/preparations | objective 원문, targetRoot, conversationUrl |
| POST /api/preparations/:id/reply | content |
| POST /api/preparations/:id/approve | 추가 필드 없음; 서버 합의 snapshot 승인 |
| POST /api/preparations/:id/cancel | 추가 필드 없음; 명시적인 준비 취소 |
| POST /api/preparations/web | command, preparationId, sessionId, conversationId, conversationUrl, deliveryId |

web command는 web.focus, web.inspect, web.stop, web.reconcile을 구분한다.
서버 commandCapabilities에 해당 명령이 있어야 사용할 수 있다.
취소 capability는 preparation.cancel이다.

GET /api/state는 계약 필드 외에 기존 실행 기록 UI용 runs, events, messages,
assessments, findings, evidence를 제공한다. preparation.discussion은
DiscussionTurn 배열, agreement.requirements는 요구사항 배열이다.
관측 진단은 preparation.diagnostics 또는 preparation.webSession.diagnostics에
제공한다. exactConversation, pageReachable, pageBusy, generating, extensionBusy,
pageStatus, canFocus, canStop, canRecover를 표시하며 누락값은 추측하지 않는다.

HTTP timeout 이후 UI는 동일 명령을 자동 전송하지 않고
GET /api/state?requestId=:requestId로 조회한다. 이 조회의 연동 응답은
requestResult: { requestId, status }이며 status는 PROCESSING, COMPLETED, FAILED,
NOT_FOUND 중 하나다. 조회 결과가 없거나 처리 중이면 해당 operation을 잠근 채
다음 조회를 기다린다. NOT_FOUND는 서버가 미접수를 확정한 경우에만 반환해야 한다.
조회는 재전송이나 delivery 정리를 수행해서는 안 된다.

이 경로와 requestResult 형식은 src/server.js와 PreparationService에 구현되어 있다.
preparations.sqlite에 준비 문맥, 전송 기록, 명령 결과를 저장한다.
재시작 도중 결과가 불명확한 전송은 자동 재전송하지 않고 RECOVERY_REQUIRED로 표시한다.
확장은 완료 응답을 저장하며, inspect로 해당 응답을 다시 읽고 reconcile로 검증 및 ACK한다.
기존 proposal, project prepare/PUT, 직접 run.start HTTP 경로는 승인 우회를 막기 위해 거부한다.

GET /api/state?view=start는 미완료 준비나 Run이 없을 때 서버가 START를 반환한다.
기록 선택은 GET /api/state?runId=:runId를 사용하며 stage는 서버가 결정한다.
기본 검증은 코드 스냅샷 검토이며, 실행 검증 없음과 기본 실행 한도를 승인 화면에 표시한다.

tests/preparation-service.test.js는 재시작, 질문 전용 합의, 버전 충돌, ACK 복구를 검증한다.
tests/preparation-api.test.js는 HTTP, 실제 임시 Git 저장소, Run 영속화와 중복 승인을 검증한다.
이 테스트의 웹 응답과 CLI 작업은 모의 처리다. 실제 확장 + ChatGPT + CLI E2E 성공을 뜻하지 않는다.

## TEST-01~08 검증 근거 (2026-09-10)

아래는 자동화 검사 범위다. 실제 브라우저 E2E의 완료 판정과 구분한다.

| 계약 | 실행 근거 | 남은 실제 E2E 증명 |
|---|---|---|
| TEST-01 | preparation-api: HTTP start → 질문 응답 → reply → READY → approve → Run 1개, WORK/RESULT 조회. Git과 SQLite는 실제 사용 | 실제 확장 전송·ChatGPT 응답·CLI 실행 |
| TEST-02 | preparation-service: 질문만 있는 응답은 DISCUSSING 유지, 요구사항 0개, 승인 불가 | 실제 모델이 모호한 요청에 질문하는지 확인 |
| TEST-03 | preparation-api: 서버 재시작 뒤 같은 context/discussion/session 복원. workflow-runtime: 초기 JS 상태에서 PREPARE 복원 | 실제 탭 refresh |
| TEST-04 | preparation-service 및 web-delivery-recovery: active pointer/생성 상태 구분, 대상 없는 stop 금지, 다른 delivery stop 거부 | 실제 응답 생성 중 중복 전송·rebind 없음 |
| TEST-05 | preparation-api: RESPONSE_COMPLETED + ACK 누락 → 재시작 → reconcile, 총 전송 2회 유지, 두 delivery 기록 보존 및 pointer null. preparation-service: ACK 후 identity/응답/idle 증거 변경 시 완료 거부 | 실제 확장 저장 상태와 탭에서 ACK 유실 복구 |
| TEST-06 | preparation-service: 다른 conversationId/deliveryId stop 거부. web-delivery-recovery: 다른 대화·도달 불가·생성 중 clear 거부 | 실제 탭 이동·content script 무응답 진단 |
| TEST-07 | preparation-api: 동시 동일 requestId 승인, 재시작 뒤 같은 요청 결과와 runId, 영속 Run 수 1 | 실제 E2E 승인 재시도 |
| TEST-08 | preparation-api: PREPARE 중 .git 없음, 승인 뒤 실제 baseline과 run.baseCommit 일치 | 실제 사용자 흐름의 Git timing |

workflow-runtime은 새 VM에서 START/WORK/RESULT도 서버 snapshot만으로 복원한다.
DOM은 테스트 대역이므로 실제 브라우저 refresh 증명을 대체하지 않는다.
이번 실행 환경의 브라우저 제어 도구에는 연결된 브라우저가 없어 실제 E2E는 미실행이다.
