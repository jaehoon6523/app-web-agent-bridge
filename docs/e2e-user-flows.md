# App/Web Agent Bridge — 사용자 행동 E2E 계약

이 파일의 UF-01A 상세와 과거 미구현 표는 원본 v2 범위 기록이다. 현재 전체 Wave 진행과 skip 이유는 [전체 계약](e2e/user-flows.md)과 [Coverage Matrix](e2e/coverage-matrix.md)가 기준이다.

## UF-01A 원본의 기준과 범위

E2E oracle은 사용자가 실제 화면에서 관찰하는 결과다. Unit/contract/fault PASS는 하위 증거이며 이 흐름의 PASS를 대신하지 않는다.

이 변경은 **UF-01A의 fresh LIVE, extension/provider 미설정 최초 실행**만 구현한다. UF-02~16과 준비→Worker→검토→적용 전체 E2E는 미구현이다. UF-01A PASS를 모든 설정·Windows 환경·전체 제품 workflow의 PASS로 보고하지 않는다.

실행: `npm run test:e2e:startup` (Node 24, Chrome 설치 필요). 기존 browser gate와 같은 `UI_BROWSER_EXECUTABLE` 또는 `UI_BROWSER_CHANNEL` 설정을 지원한다. CI browser job에서 실행하며 실패 artifact는 `.agent-controller/ui-qa/`에 포함된다.

## UF-01A: 행동 ↔ 호출 ↔ UI

| 사용자 행동 / 경계 | 실제 production 경로 | 사용자 oracle |
|---|---|---|
| 서버 실행 | 별도 프로세스 `node src/server.js` → default `loadConfig()` → `main()` → listen | 프로세스 생존 + 외부 `/api/preflight` 전체 JSON 응답 |
| Dashboard 열기 | 새 browser context → GET `/` → 실제 ES modules | 첫 화면, page/console error 없음 |
| 자동 인증 | 실제 `refresh()` → POST `/api/dashboard/session` | 정상 session 응답 + `#sessionHealth` 인증됨 |
| 첫 상태 조회 | GET `/api/state` → preparations 초기화/project + dashboard snapshot → 실제 persistence/projection | 첫 session/state body가 navigation 시작부터 5초 이내 완료 |
| 상태 표시 | `refresh()` → normalize → render → health presentation | `#apiHealth`: 응답 확인됨; `#engineHealth`: 런타임 준비 필요; `#channelHealth`: 연결 대기 |
| 상태 상세 열기 | `#apiHealth` 클릭 → disclosure | 실제 `#apiHealthDetail` 표시와 서버 응답 문구 |
| 첫 작업 입력 | `#objective`, `#startRoot`에 사용자 입력 | `#chooseFolder` enabled; `newRun` disabled (runs UNAVAILABLE); `saveProject`/`applyCode` hidden+disabled; 입력 뒤에도 extension 의존 `#planRun` disabled |
| 종료 | 실제 SIGTERM → production shutdown → close | POSIX: graceful exit 0; Windows: 명시적 SIGTERM 종료 (graceful 검증 아님) |

`/api/preflight`는 외부 테스트 driver가 실제 HTTP로 조회한다. 현재 Dashboard `refresh()`는 별도 preflight GET을 하지 않고 `/api/state.preflight`를 사용한다. 문서상의 이상적인 호출 순서를 실제 구현으로 오인하지 않는다.

DOM class만으로 PASS하지 않는다. 접근성 label과 화면 패널, 입력 동작, enabled/disabled, 실제 응답 state를 함께 확인한다. 상태 label은 실제 presentation 계약에 근거한다. 서버 응답 없음/연결 끊김/npm start 안내는 이 profile에서 금지한다.

## 실행 격리와 artifact

서버는 새 임시 cwd/workspace에서 실행한다. 운영 `.env`, controller DB, 기존 browser session을 사용하지 않는다. 서버 환경은 필요한 OS 변수와 명시적인 테스트 config만 전달한다. demo mode, server factory, injected runtime, HTTP route mocking, synthetic snapshot을 사용하지 않는다. 외부 provider를 실행하지 않으므로 이 테스트는 provider 연결 성공을 증명하지 않는다.

`result.json`은 test ID, profile, HTTP method/path/status, page/console errors, 종료 결과와 제한된 state를 담는다. server stdout/stderr와 preflight를 보존하고 성공 screenshot, 실패 screenshot/DOM/failure stack을 기록한다. header, token, query, request body는 수집하지 않는다. DOM에서는 script와 입력 객체를 제거한다. controller/service 내부 전체 tracing과 extension artifact는 이후 흐름의 작업이며 현재 artifact가 모든 내부 경계를 계측한다고 주장하지 않는다.

## 나머지 흐름: 구현 예정

| ID | 사용자 흐름 | 핵심 oracle | 현재 이 패치의 E2E 증거 |
|---|---|---|---|
| UF-02 | runtime 준비 실패 | 서버/auth 유지, runtime 의존 action만 제한 | UF-01A 미설정 profile에서 일부 관찰; 별도 fault 미구현 |
| UF-03 | extension 미연결 | local 기능 유지, Web action 제한 | UF-01A 최초 미설정 profile만 관찰 |
| UF-04 | extension 연결 | 실제 WS 인증, 연결 표시/capability 갱신 | 미구현 |
| UF-05 | preparation 시작 | 정확한 document에 한 번 전송, 응답 귀속/렌더 | 미구현 |
| UF-06 | 요구사항 수정 대화 | context/이력 유지, 새 turn 한 번 전송 | 미구현 |
| UF-07 | 승인→Worker | 승인 전 실행 금지, candidate 귀속, 자동 적용 금지 | 미구현 |
| UF-08 | 독립 검토 | 동일 candidate/hash, Judge/Critic 권한 분리 | 미구현 |
| UF-09 | FAIL→수정→재검토 | 새 candidate, finding lineage, 재검토 | 미구현 |
| UF-10 | PASS→명시적 Apply | Apply 전 tree 불변, 승인한 hash만 적용 | 미구현 |
| UF-11 | 서버 재시작 | 복구/NEEDS_REBIND, uncertain mutation 자동 재전송 금지 | 미구현 |
| UF-12 | tab navigation/reload | stale document 전송 금지, 명시적 rebind | 미구현 |
| UF-13 | state projection 503 | 상태 조회 실패, transport/auth 구분 | 미구현 |
| UF-14 | 서버 프로세스 종료 | 실제 transport 실패 표시 | 미구현; UF-01A은 종료 code만 검사 |
| UF-15 | SQLite contention | 독립 API deadline, dispatch/receipt 일치 | 미구현; 별도 C/D/E fault 증거와 구분 |
| UF-16 | reviewer provider 부분 실패 | role-local 제한, unrelated capability 유지 | 미구현 |

전체 Wave 문서: [User Flow](e2e/user-flows.md), [함수 호출](e2e/call-flows.md), [Render Oracle](e2e/render-oracles.md), [Coverage Matrix](e2e/coverage-matrix.md), [Gap Report](e2e/gaps.md). UF-01A 이후에는 전체 UF를 같은 깊이까지 전진시키고 공통 blocker를 해소한다. 아래 표는 UF-01A 원본의 범위 설명이며 현재 Wave 상태는 새 matrix가 기준이다.

Profile 구분: UF-01A fresh 미설정 (구현), UF-01B configured-but-disconnected (미구현), UF-01C connected (미구현). preflight 성공은 HTTP 200과 checks 객체를 모두 확인한 뒤에만 확정하며 실패 observation에는 status/shape/error name만 보존한다. 임시 DB 원본은 인증/외부 응답 포함 가능성이 있어 자동 첨부하지 않는다. 안전한 persistence artifact 설계는 별도 미구현이다.
