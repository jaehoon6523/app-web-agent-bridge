# UI 연동 요구사항

이 UI는 WORKFLOW_CONTRACT.md의 서버 상태를 사용한다. 현재 src/server.js의
legacy proposal API로 fallback하지 않는다. 서버에 workflow가 없으면 연결
안내를 표시하고 명령을 비활성화한다.

프런트엔드가 사용하는 준비 명령:

| 요청 | payload (공통 requestId, expectedVersion 포함) |
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

이 경로와 requestResult 형식은 public 구현의 연동 요구사항이며, 기존 서버에
구현되어 있다는 뜻은 아니다. 실제 ChatGPT/Git E2E 검증에는 서버 구현이 필요하다.
