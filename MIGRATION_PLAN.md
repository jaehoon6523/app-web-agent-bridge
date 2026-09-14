# 실제 연결 검토와 남은 작업

현재 CODE_CHANGE 경로의 구현을 기준으로 정리한 문서다. 과거 전면 교체 목록은 Git 이력에 남아 있다.
제품 기준은 [README](README.md), 실행 계약은 아래 코드가 소유한다. 이 문서의 예시로 새 필드나 권한을 만들지 않는다.

## 제안에 대한 판단

| 제안 | 판단과 현재 구현 |
|---|---|
| 기존 Adapter를 연결해 끝까지 검증 | 동의. 별도 orchestrator가 필요하지 않다. `CodeChangeService.execute`가 이미 전체 순서를 소유한다. |
| Codex app-server 런처·JSONL·thread/turn 신규 구현 | 이미 `src/runtime/codex/`에 구현돼 있다. 설치된 CLI·인증·실제 이벤트 호환성 검증과 구분해야 한다. |
| Worker 문자열을 Controller artifact로 고정 | 방향은 맞다. 현재는 문자열 wrapper가 아니라 실제 Git tree·patch·blob을 캡처한다. Worker 응답은 별도 `AGENT_CLAIM`이다. |
| `summary/body/assumptions/open_decisions` Artifact 도입 | 현재 wire 계약이 아니다. `GitChangeWorkspace.capture`와 기존 evidence 계약을 사용한다. |
| Reviewer `score/findings/evidenceRefs/summary`만 반환 | 현재 계약을 충족하지 못한다. `REVIEW_REPORT`에는 요구사항별 assessments, findingDecisions, newFindings와 정확한 run/request/candidate/requirements binding이 필요하다. |
| threshold 9, score 8이면 REWORK | 현재 기준과 충돌한다. 점수는 참고값이다. 필수 불충족·미해결 지적은 REWORK, 필요한 증거 부족은 HOLD, 필수 통과 조건 충족 시 PASS다. |
| REWORK마다 새 Worker | 이미 회차마다 worker factory/start/close를 수행한다. 새 Codex thread를 사용하되 같은 run worktree의 이전 변경을 이어서 수정한다. |
| 회차마다 별도 worktree | 현재는 런별 worktree다. 새 thread와 새 worktree는 다른 개념이다. 회차마다 새 worktree를 만들 필요성은 별도 요구가 있어야 한다. |
| Worker 대화 기록을 Reviewer에 전달 | 필요 없다. 고정 후보, 요구사항, evidence, 지적을 전달하며 AGENT_CLAIM은 주장이란 표시를 유지한다. |
| 실제 파일/worktree 연결 필요 | `GitChangeWorkspace`와 Worker 캡처 wrapper가 이미 연결돼 있다. worktree는 OS 읽기·쓰기 권한 격리를 보장하지 않는다. |
| PASS 후 자동 merge | 현재는 `AWAITING_APPLY`에서 멈추고 별도 `code.apply`를 받는다. 적용도 commit/push/merge를 수행하지 않는다. |
| `candidatePacketType → repair authority` P0가 남음 | 현재 DISCUSSION repair는 `deriveProtocolRepairPolicy`가 원래 Controller 입력과 source message에서 allowedPacketTypes/hash를 도출한다. 진단상의 observed type을 바꿔도 정책이 같다는 회귀가 있다. CODE_CHANGE report repair와 혼동하지 않는다. |
| HMAC으로 UI evidence 진실성 보장 | HMAC은 확장 연결의 challenge 인증이다. DOM이나 모델 판단의 진실성을 증명하는 서명이 아니다. 문서·메시지·실행 binding은 별도로 검증한다. |
| 프로세스 재시작 후 자동 continuation | Adapter의 정확한 thread resume 지원과 CODE_CHANGE의 재시작 정책은 다르다. 실행 중 서버 재시작은 RECOVERY_REQUIRED이며 자동 재전송하지 않는다. |

## 현재 실행 경로와 소유 코드

1. `src/orchestration/code-change-service.js`: 기준/대상 고정, 런 접수, 회차·중단·적용 판단.
2. `src/runtime/workers/registry.js` → `code-change-worker.js` → `codex/process-manager.js`, `jsonl-rpc-peer.js`, `session-adapter.js`: Worker process/thread/turn과 완료 결합.
3. `src/repository/git-change-workspace.js`, `src/evidence/candidate-evidence.js`: 실제 코드 캡처와 검증 실행 증거.
4. `src/orchestration/code-change-prompts.js`, `audit-round.js`: Worker brief, 고정 후보 검토 요청, 추가 evidence/형식 보완.
5. `src/runtime/web/session-adapter.js` → `extension/background.js` → `extension/content.js`: 인증된 연결, 정확한 대화/문서, 전송과 응답 관찰.
6. `src/domain/code-review.js`: 응답 검증과 PASS/REWORK/HOLD 계산. 외부 응답 필드로 다음 actor나 repair 권한을 지정하지 않는다.

Codex stdio 연결의 공식 설명은 [OpenAI App Server 문서](https://learn.chatgpt.com/docs/app-server)를 참조한다. initialize/initialized 후 thread와 turn을 생성하고, ID가 결합된 알림을 읽는다. 설치 버전에 대한 확인은 해당 바이너리와 실제 왕복 기록으로 남겨야 한다.

## 검증을 나누는 기준

| 명령 | 실제 실행하는 것 | 대체하는 것 / 보장하지 않는 것 |
|---|---|---|
| `npm run check` | 정적 검사, domain, SQLite, 임시 Git, Node 자식 프로세스 등 자동 검사 | 실제 Codex 계정·ChatGPT 응답·브라우저 검증을 보장하지 않음 |
| `npm run test:browser` | 실제 Chromium DOM, manifest 순서의 content scripts, background ESM 전체, HMAC·WebSocket·Web Adapter, fixture JSONL process와 Codex Adapter를 포함한 REWORK→PASS | Chrome extension API와 ChatGPT 페이지/모델은 fixture. 확장 설치/서비스 워커 수명/실제 제공자 지능은 미검증 |
| `npm run test:ui` | 콘솔 브라우저 입력·표시·레이아웃·일부 네트워크 실패 | 준비/실행/적용 API와 상태 전환은 fixture |
| `npm run certify` | 저장된 감사 기록의 candidate/requirements/report/evidence 정합성 재검사 | 실제 제공자 출처·아티팩트 원문 무결성·실시간 동작의 독립 인증 아님 |

`test:browser`는 기존 함수를 문자열로 잘라 호출하거나 send/response 감지 함수를 성공값으로 대체하지 않는다. 다만 Chrome API fixture와 페이지 fixture의 한계를 없애지는 못한다. 실제 제공자 검증을 대신했다고 보고하지 않는다.

## 실제 제공자 검증 순서

1. 운영자가 지정한 clean Git target, 확정 RequirementsSet, 등록 검증과 한도, Codex 실행 경로/인증, 확장 설정과 대상 ChatGPT 대화를 준비한다. 예제 설정을 운영값으로 자동 승격하지 않는다.
2. 실제 콘솔 준비 흐름으로 시작한다. root 탭은 첫 메시지 관찰 후 대화 ID를 확보하고, CODE_CHANGE에는 확정된 대화가 전달된다.
3. 첫 실제 Worker의 process/thread/turn, workerTurns inputRef/outputRef, 원본 target 보존과 captured tree/patch를 확인한다.
4. 실제 Web 응답의 요청/대화/문서/메시지 identity와 저장된 요청·응답을 확인한다. 전송 버튼 클릭·텍스트 안정화만으로 감사 성공을 판단하지 않는다.
5. 실제 누락을 Reviewer가 발견한 REWORK, 다음 Worker의 새 thread, 다른 후보, 지적의 재검증과 PASS를 확인한다. 반복 횟수를 맞추려고 리뷰 결과를 조작하지 않는다. 첫 회차에 PASS면 REWORK 경로는 미검증으로 남긴다.
6. PASS는 적용 대기에서 멈춘다. 별도 적용을 요청받은 경우에만 candidate/review/base/hash/version을 결합해 적용한다.
7. 별도의 승인된 실행에서 crash, timeout, browser reload, 연결 유실과 재시작을 검증한다. 모호한 전송은 자동 재시도하지 않고 기록 보존·복구 필요·늦은 응답 차단을 확인한다.

현재 작업의 fixture 실행 결과는 실제 계정에 대한 위 1~7 수행 기록이 아니다. 실환경 결과는 기존 런 저장소와 artifact에 보존하고, 연결 표시나 테스트 개수로 대체하지 않는다.
