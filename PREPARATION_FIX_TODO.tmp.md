# 준비 상태 정합성 수정

- [x] 완료 증거 검사를 항목별 판정으로 분리하고 기대값·관측값 기록
- [x] 응답 수집 증거와 현재 페이지 상태 분리 검토 (동일 메시지 재수집, 과거 수집본 보존; 증거 기준 완화 없음)
- [x] 전송·응답 처리 상태 및 실패 종류를 화면에 표시
- [x] 복구 동작과 버튼 이름을 실제 기능에 맞춤
- [x] 첫 응답 확인 이전 START 유지 및 새로고침 복원 검증
- [x] ACK 실패·응답 불일치·연결 종료 회귀 검증
- [x] 실행 중 서버 및 브라우저 검증 가능 여부 확인 (playwright-core + 실제 Chrome, headless로 검증 성공)

완료 기준: 조기 화면 전환, 중복 전송, 근거 없는 성공 표시가 없어야 한다.

실제 저장 기록 확인: prep_45b44719 응답 신뢰도 HEURISTIC, sendButtonEnabled=null.
메시지 ID는 일치하지만 원문은 준비 제안 형식이 아님. 성공으로 승격하지 않는다.

## 브라우저 검증 결과 (scripts/check-preparation-workflow.mjs)

- playwright-core(1.63.0) + `channel: 'chrome'` 헤드리스로 실제 index.html/app.js를 로컬 HTTP 서버에 띄워 검증 완료.
- 최초 실행 시 검증 스크립트의 mock discussion 항목에 `turnId`/`sequence`/`preparationId`(WEB_DESIGNER의 경우 `deliveryId`)가
  빠져 있어, app.js의 `normalizeDashboardState` 자체 검증 로직이 TypeError를 던지고 클라이언트가 `connected=false`로
  빠지면서 "ChatGPT 응답을 기다리고 있습니다" 화면이 전혀 뜨지 않고 타임아웃 -> 스크립트 데이터 버그로 확인, 수정함.
- 위 수정 후 재실행 과정에서 실제 앱 버그 1건 추가 발견 및 수정:
  - `renderInitialRequest()`가 ChatGPT 대화 URL을 `preparation.conversationUrl`에서 읽었으나, 실제 필드는
    `preparation.webSession.conversationUrl`에 있어 대기 화면에 URL이 `undefined`로 표시됨.
  - `renderPreparation()`과 동일하게 `preparation.webSession?.conversationUrl ?? preparation.conversationUrl`로 통일.
- 수정 후 7개 시나리오(disconnected, waiting, reload, prepared, recovery, no-duplicate-send, mobile) 모두 통과,
  데스크톱/모바일 스크린샷 확보(`.agent-controller/ui-qa/preparation-workflow/*.png`), 콘솔 pageerror 없음.
- 기존 `npm test` 495개 중 8개 실패는 수정 전/후 동일(HTTP dashboard, Git 승인, recovery delivery 관련 사전 존재 실패이며
  이번 변경과 무관 — 로컬 환경 의존적인 것으로 보임, 별도 확인 필요).
