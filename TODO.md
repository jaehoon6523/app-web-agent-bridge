# 개발 실행·검토·반영 연결 TODO

점검일: 2026-09-06. 현재 작업 트리의 코드와 문서를 정적으로 대조한 결과다. 기존 미커밋 변경을 포함한다. 이 문서는 요청에 따른 점검 목록이며 새 제품 계약이나 기능 구현 완료 선언이 아니다.

사용자 정정에 따라 전체 목적은 [README.md](README.md)의 ‘목표 동작’을 따른다. 앞선 목록은 DISCUSSION 구현 점검에 치우쳐 실제 Codex 작업·Git diff 캡처·Web 검토·재작업·대상 레포 반영이라는 핵심 누락을 충분히 다루지 못했다. 아래 핵심 작업을 우선하며 기존 01~12는 보조 점검으로 유지한다.

우선순위는 P0(외부 입력과 Controller 권한 경계), P1(핵심 실행·복구), P2(계약·검증 공백), P3(설명·유지보수 정리)로 구분한다. ‘확인’은 코드에서 확인한 사실, ‘검증 필요’는 장애 발생 자체를 재현하지 않은 위험이다. 아래 완료 기준은 후속 작업 제안이며 이번 점검에서 통과한 결과가 아니다.

## 우선 작업 — 실제 개발 루프 완성

- [x] **P0 / A. 현재 DISCUSSION 경로의 `candidatePacketType → repair authority` 점검**
  - 2026-09-06 확인: 현재 `src/`와 `tests/`에는 `candidatePacketType` 식별자가 없다. `discussion-controller.js`는 저장된 요청·source message에서 `deriveProtocolRepairPolicy()`를 호출하며, `protocol-repair-policy.js`는 Controller action policy로 허용 타입을 도출한다. `discussion-response-context.js`는 repair를 원래 요청에 다시 결합한다.
  - 검증: `node --test --experimental-test-isolation=none tests/protocol-failure.test.js tests/discussion-protocol-failure.test.js` — 20개 통과, 실패·skip 0. 진단 evidence가 repair 권한을 선택하지 못하는 사례와 재시작 시 일관되게 위조된 repair policy 거부 사례를 포함한다.
  - 판정: 지적된 권한 역전은 현재 DISCUSSION 경로에서 재현되지 않았고 기존 차단 구현을 확인했다. 이번 작업에서 기능 수정은 하지 않았다. 향후 개발 검토 루프에도 동일 경계를 적용해야 하며, 아직 없는 개발 루프까지 검증한 것은 아니다.
- [ ] **P1 / B. 참고 레포와 기존 Bridge 연결 지점 대조**
  - `master-workflow` 및 Git diff 수신·반영 참고 레포의 위치·실제 구현을 확인한다. 기존 Adapter·Dispatcher를 확장할 지점을 찾는다.
  - 완료 기준: 파일 변경, diff 확보, 검토, 재작업, 반영 각 단계의 기존 구현·누락·재사용 지점이 코드 근거로 대응한다. 새 오케스트레이션을 만드는 것을 기본 해법으로 삼지 않는다.
  - 조사 결과: 작업 폴더·주변 경로 및 `C:/Users/cjh/_gemini` 내 검색 가능한 Markdown/package 파일에서 참고 레포를 특정하지 못했다. 일부 임시 디렉터리는 읽기 거부됐다. 사용자에게 정확한 경로 또는 URL을 요청한 상태다.
- [x] **P1 / C. 실제 Codex 작업 실행 연결**
  - 현재 DISCUSSION/readOnly 경로와 개발 작업 경로의 차이를 명시하고, 대상 레포 또는 격리 worktree에서 실제 파일 변경을 수행하도록 연결한다.
  - 완료 기준: 실제 app-server의 thread/turn ID와 run/session binding, 파일 변경, 종료·timeout·crash 처리를 확인한다. Adapter 존재만으로 실연결 완료를 선언하지 않는다.
  - 연결 지점 확인: `src/runtime/codex/configuration.js`의 `buildCodexSandboxPolicy()`와 `session-adapter.js`의 `start()`에는 CODE_CHANGE/workspace-write 지원이 이미 있다. 반면 `dashboard-controller.js` 시작 명령과 `run-policy.js`는 DISCUSSION만 허용한다. 따라서 저수준 Adapter 전체를 새로 만들 일이 아니라 상위 개발 실행 계약·경로를 연결할 작업이다.
- [x] **P1 / D. 실제 변경의 Controller Artifact 캡처**
  - Git 기준점과 diff, 필요한 파일·검증 증거를 Controller가 확보하고 해시로 결합한다. 미추적 파일·바이너리·삭제·기존 사용자 변경의 처리 범위도 정한다.
  - 완료 기준: Worker의 완료 설명과 실제 변경 증거를 구분하고, Reviewer가 본 후보를 동일하게 재식별할 수 있다. 현재 일반 Artifact 저장 구현과 변경 캡처 구현을 구분해 점검한다.
  - 연결 지점 확인: `src/evidence/artifact-store.js`는 bytes 저장·해시 검증을 제공한다. 현재 `src/` 검색에서 Git diff 캡처·worktree·git apply 실행부는 확인되지 않았다. 일반 저장소를 재사용하되 diff 확보·기준점 결합·반영 경로가 추가로 필요하다.
- [x] **P1 / E. 실제 ChatGPT Reviewer 연결**
  - 목표·고정 Artifact·검토 기준을 전달하고 정확한 conversation/turn의 보고서를 수집한다. 점수·지적 사항·근거 참조·요약의 계약을 대조한다.
  - 완료 기준: 전송부터 응답 완료까지 UI evidence와 저장 증거가 결합되고, Reviewer 출력은 평가 자료로만 취급한다. 예시 JSON이나 fixture를 실구현 증거로 사용하지 않는다.
- [x] **P1 / F. Controller PASS/REWORK와 새 Worker 반복**
  - 현재 proposal 합의 경로와 목표 검토 정책의 차이를 해소한다. REWORK brief에 목표·이전 Artifact·검토 지적·반복 번호를 담아 새 Worker 세션으로 전달한다.
  - 완료 기준: 판정은 Controller 정책이 소유하고 Reviewer가 merge·다음 행동을 명령하지 못한다. 새 반복과 같은 반복의 재시작 복구가 구분된다. 예시의 9점을 고정 요구로 오인하지 않는다.
- [x] **P1 / G. 검토된 diff의 대상 레포 반영 경로**
  - 참고 레포의 diff 수신·반영 방식을 대조하고, 사람 또는 별도 승인 단계 이후 검토된 변경을 반영하도록 연결한다. 대상 기준점 변경·충돌·부분 반영 실패 처리를 정의한다.
  - 완료 기준: PASS와 반영 완료를 구분하고, 승인 대상·검토 후보·실제 반영 변경의 동일성을 확인한다. 검토되지 않은 변경이나 기존 사용자 변경을 함께 반영하지 않는다.
- [x] **P1 / H. 실제 반복 및 장애 복구 E2E**
  - 실제 Codex 변경 → diff 캡처 → 실제 Web 검토 → REWORK → 새 Worker 수정 → 재검토 PASS를 2~3회 반복 시나리오에서 검증하고 승인된 반영까지 확인한다.
  - 완료 기준: 실행·세션·턴·Artifact·보고서·판정·반영 증거를 추적할 수 있고, crash/recovery에서도 중복 실행·다른 후보 채택이 없다. 현재는 미검증이다.

## 보조 점검 — 기존 DISCUSSION 구현

### 개발 연결 구현 진행 기록

2026-09-06 후속 구현:

- C/D/G 기반: `git-change-workspace.js`에 격리 worktree 생성, 실제 diff 캡처, 해시·tree 검증, 저장된 patch 반영을 추가했다. 실제 임시 Git 레포에서 새 파일·수정·삭제·바이너리, dirty target, HEAD 이동, Artifact 위조 거부 테스트 4개가 통과했다. submodule은 명시적으로 거부한다. 최종 승인 연결은 아직 없다.
- C/D 연결부: `code-change-worker.js`가 기존 Codex Adapter를 재사용하고 정확한 완료 후 캡처와 Controller 저장 callback을 기다린다. 잘못된 thread/turn, 실패 완료, 저장 실패 테스트 3개가 통과했다. 실제 Codex 실행이나 SQLite 연결 완료를 뜻하지 않는다.
- E/F 기반: `code-review.js`와 Web Adapter 파서 주입을 추가했다. 점수 정책, 권한 필드 거부, 증거 참조 결합과 기존 Web Adapter 경유 보고서 수신을 검증했다. 기본 서버는 계속 DISCUSSION 파서를 사용한다.
- 전체 자동 테스트 355개 통과 후 Web 파서 연결 변경에 대한 관련 26개 테스트 및 타입 검사 통과. lint는 기존 `sqlite-store.js` 1,013줄로 실패한다. 새 코드 때문에 길이가 증가한 것은 아니다.
- 실제 서버 preflight는 ECONNREFUSED. B의 참고 레포 대조, SQLite 개발 실행 계약, 대시보드 실행·승인 연결, 반복·재시작 처리, 실제 Provider E2E는 남아 있다. 이 때문에 A 외 핵심 작업의 완료 체크는 하지 않는다.
- 다음 외부 연결 계약 제안은 README의 ‘다음 연결 계약 제안’에 작성했다. 현재 코드에 없는 승인 조작·반영 대기 상태를 기존 구현인 것처럼 간주하지 않는다.

## 실제 실행 구조

| 구성요소 | 실제 실행 위치와 책임 | 혼동하면 안 되는 의미 |
|---|---|---|
| `src/runtime/web/session-adapter.js` | Node.js 서버에서 웹 세션·요청·응답 관리 | 브라우저 Web Worker가 아님 |
| `extension/background.js` | 확장 Service Worker에서 인증·WebSocket·탭 바인딩·전달 관리 | DOM을 직접 조작하는 실행부가 아님 |
| `extension/content.js` | ChatGPT 페이지의 content script에서 DOM 입력·응답 관찰 | 서버 어댑터나 Service Worker가 아님 |
| `public/app.js` | 대시보드 페이지에서 HTTP 조회·명령·표시 | 에이전트 실행부나 WebSocket 소비자가 아님 |

`extension/manifest.json`은 `background.service_worker`와 `content_scripts`를 별도로 지정한다. `src/`, `public/`, `extension/` 검색에서 별도 Web Worker 생성 코드는 확인되지 않았다. Worker 파일이 없다는 사실만으로 결함은 아니다. 필요한 실행 격리나 CPU 작업 요구가 먼저 있어야 한다.

## P1 — 실행과 복구 판단

- [ ] **01. 확장 재시작 후 전달 복구 경로 점검·완성** — 확인 + 검증 필요
  - 근거: `extension/background.js`의 `handlePrompt`, `handleDeliveryAcknowledgement`; `extension/runtime/storage.js`; `src/orchestration/recovery-scan.js`.
  - 공백: 미확인 전달 ID가 남으면 다음 전송을 거부하는 보호는 있다. 하지만 저장소 존재나 WebSocket 재접속만으로 이전 응답 수집·확인·다음 턴 진행까지 복구됐다고 볼 수 없다. README도 불확실한 제출 결과 채택과 복구 executor의 미연결을 명시한다.
  - TODO: 전송 직전/직후, 응답 수신 직후, DB 저장 후 ACK 전 시점의 서버·확장 종료를 각각 점검하고 기존 복구 계약의 연결 누락을 정리한다.
  - 완료 기준: 각 중단 지점에서 중복 전송이 없고, 전달 ID·DB 상태·확장 저장 상태가 일치하며, 재개 불가능한 경우 이유와 처리 경로가 드러난다.

- [ ] **02. ‘재연결’ 명령과 실제 확장 프로토콜의 차이 정리** — 확인
  - 근거: `src/orchestration/dashboard-controller.js`의 `web.session.focus/rebind` 분기; `src/runtime/web/session-adapter.js`의 `start/resume`; `extension/background.js`의 `rebindSession`.
  - 공백: 대시보드의 두 명령은 모두 `resume()`을 호출한다. 어댑터의 `resume()`은 `web.session.prepare`를 보내지만, 확장의 명시적 `web.session.rebind`는 선택된 `tabId`를 요구한다. 같은 이름이 서로 다른 동작을 가리킨다.
  - TODO: 현재 버튼이 ‘같은 대화 자동 재탐색’인지 ‘선택한 탭으로 명시적 재바인딩’인지 정리하고 설명과 경로를 맞춘다. 명시적 탭 선택을 추가하는 것은 별도 기능 결정이다.
  - 완료 기준: 탭 닫힘, 탭 ID 변경, 동일 대화 중복 탭 상황에서 버튼 설명과 실행 결과가 일치한다.

- [ ] **03. 승인·복구 기록과 실행 기능 구분** — 확인
  - 근거: `src/orchestration/dashboard-controller.js`의 `snapshot/execute`; `src/orchestration/recovery-scan.js`; README의 구현 경계.
  - 공백: 승인 기록 조회와 복구 판정은 있지만 대시보드 명령 처리기에 승인 결정·복구 executor 명령은 없다. 테이블·블로커·조회 UI가 있다는 사실을 사용 가능한 해결 기능으로 설명하면 안 된다.
  - TODO: 기록/판정/실행/사용자 조작별 지원 여부를 명시하고, 기존 계약에서 요구하는 미연결 구간을 후속 구현 대상으로 분리한다.
  - 완료 기준: 해당 상태에서 가능한 조작과 불가능한 조작이 정확히 표시되고, 해결 기능 완료 주장은 실제 상태 전이 증거를 가진다.

- [ ] **04. 재시작 안내가 재개 가능 상태와 충돌하는 문제 정리** — 확인
  - 근거: `src/orchestration/dashboard-controller.js`의 `restorable` 및 `error`; `public/app.js`의 `staleRun`.
  - 공백: 조건에 따라 `run.resume`을 제공하면서, 런타임 세션이 없으면 ‘중단하고 새 실행을 시작’하라는 안내도 반환한다. 프런트는 오류 문자열의 `이전 서버 세션` 포함 여부로 상태를 판단한다.
  - TODO: 재개 가능한 기록과 복구가 필요한 기록의 안내를 기존 상태·capability에 맞추고 문구 의존 분기를 제거한다. 새 외부 필드가 필요하다면 먼저 계약 변경으로 명시한다.
  - 완료 기준: PENDING 재개 가능 사례와 불확실한 제출 사례에서 안내와 활성 명령이 서로 모순되지 않는다.

- [ ] **05. 명령 중복 방지의 보장 범위 명확화** — 확인
  - 근거: `src/server.js`의 `commandReceipts = new Map()` 및 256개 제한; README의 requestId 설명.
  - 공백: 명령 영수증은 프로세스 메모리에만 있다. SQLite에 실행 상태가 저장된다는 사실이 명령 requestId의 영속적 중복 방지를 뜻하지 않는다. 현재 README는 이 한계를 밝히고 있다.
  - TODO: 응답 유실·캐시 축출·서버 재시작 후 같은 명령을 재요청할 때의 실제 결과를 정리한다. 재시작을 넘는 보장이 필요하면 영수증 영속화를 별도 변경으로 설계한다.
  - 완료 기준: 상태 버전 검사와 명령 중복 방지가 각각 보호하는 범위를 설명하고, 중복 실행 여부를 사례별로 검증한다.

## P2 — 기능과 검증의 공백

- [ ] **06. DOM 관찰 완료와 Provider 완료를 구분** — 확인 + 검증 필요
  - 근거: `extension/content.js`의 `waitForAssistantResponse`와 `stable && !stopVisible` 분기; `src/runtime/web/observation.js`; `tests/fixtures/chatgpt-dom/`.
  - 공백: 현재 응답 관찰은 메시지 ID·대화 결합·DOM 및 텍스트 안정화·버튼 상태를 이용한다. 여러 보호가 있어도 Provider의 권위 있는 완료 이벤트와 같지 않다.
  - TODO: 생성 중 일시 정지, 버튼 누락, DOM 가상화, 수동 메시지 삽입, 페이지 이동에서 조기 완료·다른 턴 응답 채택 여부를 확인한다. 관찰 완료, 패킷 검증, 저장 완료, 합의 완료를 설명에서 분리한다.
  - 완료 기준: 불명확한 관찰은 자동 릴레이되지 않으며, 최종 채택은 정확한 턴 결합과 패킷·저장 검증을 거친다.

- [ ] **07. CODE_CHANGE의 선언과 실행 지원 상태 대조** — 확인
  - 근거: `MIGRATION_PLAN.md`의 목표 모드; `src/orchestration/dashboard-controller.js`의 `Only DISCUSSION mode is supported`; `src/domain/run-policy.js`.
  - 공백: 마이그레이션 목표에는 CODE_CHANGE가 있지만 현재 대시보드 시작 경로는 DISCUSSION만 허용한다. 목표 문서의 모드 나열은 실행 구현 증거가 아니다.
  - TODO: 사용자 정정으로 실제 개발 작업은 목표에 포함됨이 확정됐다. 현재 지원 범위를 명시하고, 위 C~G에 따라 필요한 실행·검증·결과·반영 경로를 연결한다. 기존 CODE_CHANGE 식별자의 재사용 여부는 현재 계약과 대조한다.
  - 완료 기준: 지원 모드 설명과 실제 시작 API가 일치한다. CODE_CHANGE 완료 표시는 실제 변경·검증 경로를 갖춘 이후에만 한다.

- [ ] **08. 브라우저 코드의 타입 검사 공백** — 확인
  - 근거: `tsconfig.json`은 `src/**/*.js`, `scripts/**/*.js`만 포함하며 `public`, `extension`, `tests`를 제외한다. `scripts/lint.js`는 파일 길이와 일부 금지 패턴을 검사한다.
  - 공백: `npm run check` 성공을 확장·프런트 전체의 타입 및 메시지 계약 검사 성공으로 해석할 수 없다.
  - TODO: 브라우저 환경과 Chrome API에 맞는 검사 범위를 정하고, 서버↔확장↔content script 메시지의 실제 검사 위치를 대조한다.
  - 완료 기준: 검사 명령별 포함·제외 범위가 명시되고 브라우저 경계의 잘못된 필드나 메시지를 검출하는 근거가 있다.

- [ ] **09. 자동 통합 테스트와 실제 브라우저 E2E 구분** — 확인
  - 근거: `package.json`의 `test:integration`; README의 가짜 app-server 및 DOM fixture 설명.
  - 공백: 통합 테스트 목록이나 fixture 통과만으로 로그인된 ChatGPT, 확장 생명주기, 실제 DOM과 두 에이전트 왕복 실행을 검증했다고 할 수 없다.
  - TODO: 실제 환경 검증 절차와 결과 기록 항목을 정리한다. 정상 왕복, 연결 끊김, 확장 재시작, 수동 개입, ACK 경계를 포함한다.
  - 완료 기준: 자동 테스트 결과와 실제 환경 결과를 별도로 제시하고, 미실행 항목은 미검증으로 남긴다.

- [ ] **10. 기록 표시 제한과 서버 조회 비용 구분** — 확인 + 검증 필요
  - 근거: `src/orchestration/dashboard-controller.js`의 `snapshot`은 선택 실행의 메시지·입력·전달·이벤트를 조회한다. `public/app.js`는 메시지를 정렬한 뒤 `slice(-100)` 한다.
  - 공백: 화면의 100개 제한이 서버 조회량이나 응답 크기를 제한하지 않는다. 실제 성능 문제 발생 여부는 아직 측정하지 않았다.
  - TODO: 큰 실행 기록에서 응답 크기·조회 시간·렌더링 시간을 측정하고 필요 시 페이지 조회나 증분 조회를 설계한다. 생략된 기록의 접근 방식도 정한다.
  - 완료 기준: 측정 결과를 근거로 조회 범위를 결정하고, 화면에 없는 기록을 손실된 기록으로 오인하지 않게 한다.

## P3 — 용어와 문서 정합성

- [ ] **11. ‘web 작업자’ 용어 정정과 Worker 필요성 분리** — 확인
  - 근거: 위 실행 구조 표, `extension/manifest.json`, `src/runtime/web/session-adapter.js`.
  - 공백: 서버 어댑터를 Web Worker라고 설명한 것은 실행 환경과 책임을 혼동한 설명이다. 별도 Worker가 요구된다는 근거는 이번 요청만으로 확정되지 않는다.
  - TODO: 설명에서 ‘ChatGPT 웹 세션 어댑터’, ‘확장 Service Worker’, ‘content script’를 구분한다. 별도 Web Worker는 필요 작업·실행 위치·메시지 경계가 정해질 때 검토한다.
  - 완료 기준: 실제 진입 파일과 실행 환경으로 각 용어를 추적할 수 있다. 디렉터리만 추가해서 Worker 구현 완료로 처리하지 않는다.

- [ ] **12. 문서의 시점·지원 명령·구조 설명 갱신** — 확인
  - 근거: `MIGRATION_PLAN.md`의 과거 ZIP 기준 인벤토리; `FRONTEND_SPEC.md`의 명령 표; `src/orchestration/dashboard-controller.js`의 `run.delete`; `package.json`의 `two-pane` 설명.
  - 공백: 마이그레이션 문서는 과거 기준임을 밝히지만 이를 현재 파일 목록으로 읽으면 오류가 된다. 프런트 명세의 명령 표에는 현재 구현된 `run.delete`가 없고, 패키지 설명의 two-pane과 프런트 명세의 3열 배치도 다르다.
  - TODO: 과거 계획과 현재 지원 현황의 용도를 명확히 하고, 현재 명령·UI 설명을 코드와 대조해 갱신한다. 과거 문서의 UNRESOLVED는 현 구현과 대조 없이 그대로 미구현 판정하지 않는다.
  - 완료 기준: 지원 명령이 명세에 빠짐없이 대응하고, 과거 계획을 현재 구현 사실로 인용하지 않는다.

## 후속 진행 순서와 이번 점검 범위

우선 A의 권한 경계를 확인하고 B의 참고 구현 대조를 통해 C~G의 기존 연결 지점을 확정한다. 이후 H로 전체 흐름을 검증한다. 01~12는 이 핵심 작업에 필요한 복구·검증·설명 점검으로 병행한다. 10은 측정 후 변경 여부를 판단한다.

최초 점검 이후 문서 정정과 위 진행 기록의 코드·테스트 추가를 수행했다. 실제 Provider 전송·브라우저 조작은 하지 않았다. 이 목록은 전체 보안 감사 또는 모든 결함의 완전한 목록이 아니다.
