# Controller Packet 계약 정정 및 검증

## §1. 기준 상태

- 기준 브랜치는 `codex/preparation-packet-contract`, 시작 SHA는 `a5ee3f00629bcbb8c6f04291eba4dc90811b7e5c`였다.
- 운영 체크아웃은 `forensics-20261110`의 `bef58bccead1f9a205ae9044940655044dabe304`였다. 운영 변경은 분리된 작업 트리로 가져오지 않았다. 분리된 작업 트리에 이미 있던 실제 줄바꿈·3줄 예시·대상 화면 질문 변경은 재사용했다.
- Windows 10.0.26200 및 Node 22.14.0에서 임시 SQLite, 모의 웹 세션, 격리 Chromium 페이지를 사용했다.

## §2. 원인 분석

1. 제공된 운영 관측에서 BEGIN 뒤의 JSON과 END가 Chrome 최종 화면 및 서버 원문에 없었다. 서버가 `RESPONSE_COMPLETED` 이후 `CONTROLLER_PACKET_MISSING`을 기록한 결과와 일치한다. 이 증거로 모델 출력 종료의 원인이나 수집기의 조기 완료 여부를 판정할 수 없다.
2. 격리 교정 실험은 외형과 JSON 파싱에 통과했다. 다섯 항목에 `id`와 `description`이 있었고 `statement`와 `acceptanceCriteria`가 없어 업무 검증에서 실패했다. 실제 제품 예시는 올바른 타입과 질문만 있는 구조를 사용했다.
3. T2는 수정 전 서버에서도 거절됐고 ACK가 없었다. 구체적으로 어떤 필드가 누락됐는지는 제공하지 않았다. 대시보드 복구 화면은 패킷 타입만 확인해 그 응답을 정상 제안으로 표시했다. 수정 전 화면 회귀가 이를 재현했다.
4. 호출 순서는 `preparation-service.js`의 `generate()` → `submitTurn()` → 콘텐츠의 `waitForAssistantResponse()` → 백그라운드의 `completedDelivery.rawText` 저장 및 `web.prompt.result` 반환 → 서버 식별자 검사 및 `RESPONSE_COMPLETED` 저장 → `complete()`의 패킷·업무 스키마·페이지 증거 검사 → `ACK_PENDING` 저장 → ACK 확인이다. 마지막 단계에서 소유권이 해제되고 준비가 `DISCUSSING` 또는 `AGREEMENT_READY`로 진행한다.
5. 완료 감시는 텍스트와 DOM 안정화, 생성 중지 표시, 입력창과 사용자·assistant 귀속 및 전송 확인에 의존한다. 격리 Chromium에서 생성 표시가 남아 있으면 안정된 BEGIN-only를 반환하지 않았고, 표시가 사라지자 원문 그대로 반환하고 저장했다.
6. 요구사항 준비는 `controller-packet-envelope.js`의 범용 JSON 외형 파서와 준비 전용 스키마를 사용한다. `src/runtime/web/controller-packet.js` 및 `agent-packets.js`의 일반 에이전트 `PROPOSAL` 타입은 별도 계약이다.

## §3. 수정 내용

| 파일 | 재현 입력 및 변경 |
| --- | --- |
| `src/domain/requirements-proposal.js` | 기존 준비 제안 검증을 구조적 필드 진단으로 옮겼다. 정확한 타입, 문자열 요약, 비어 있지 않은 문자열 원소의 질문 배열, 최대 30개 요구사항, 항목의 두 필수 문자열, 두 배열 중 적어도 하나의 내용 조건을 유지했다. |
| `src/orchestration/preparation-service.js` | `submitTurn()`에 실제 전달되는 3줄 예시와 지시를 맞췄다. 정확한 타입과 `id`·`description`만 있는 항목의 불충분함을 명시했다. 저장된 `validation`에 파싱 성공 여부, 바이트 수, SHA-256, 누락·잘못된 필드를 기록한다. JSON 예외의 응답 인용을 제거하고 기존 오류 코드와 실패 상태를 유지한다. |
| `public/app.js` | `formatError`를 우선 표시하고 확인된 형식에만 정상 제안 문구를 표시한다. 잘못된 필드 이름과 형식 검증 실패를 수신·로딩 상태와 구분한다. |
| `tests/preparation-service.test.js` | T1~T11의 대표 입력과 영속 상태, 재시작, 정확한 ACK 순서, 타 전송 거절을 검사한다. T7은 전송 문자열의 마지막 세 줄을 그대로 반환해 실제 파서와 업무 검증 경로를 실행한다. |
| `tests/helpers/preparation-tab-regressions.js`, `tests/public/workflow-runtime.test.js` | 저장된 타입이 맞아도 형식이 INVALID이면 정상 제안 표시나 승인 가능 표시가 나오지 않는지 검사한다. |
| `scripts/content-lifecycle-browser-suite.mjs` | T12에서 로컬 HTML의 생성 표시와 실제 콘텐츠·백그라운드 코드를 사용해 완료 시점, 원문 일치, 클릭 1회를 검사한다. |

`RESPONSE_COMPLETED`에 원문이 있는 상태는 수신 증거다. 외형 실패에는 `packetParsed:false`와 기존 파싱 오류 코드가 기록된다. 업무 스키마 실패에는 `packetParsed:true`, `INVALID_REQUIREMENTS_PROPOSAL` 및 해당 필드가 기록된다. 양쪽 모두 `INVALID_AGREEMENT / RECOVERY_REQUIRED`를 유지하며 정상 ACK를 요청하지 않는다. 공용 파서의 허용 범위와 콘텐츠 감시 로직은 기존 코드대로 사용한다.

## §4. 테스트 결과

| 검사 | 수정 전 | 수정 후 |
| --- | --- | --- |
| T1 BEGIN-only | 원문 보존·ACK 0·`CONTROLLER_PACKET_MISSING` 확인. 구조적 진단 단정 실패 | 통과. 파싱 false 및 보존 확인 |
| T2 잘못된 items 필드 | 외형 통과·업무 거절·ACK 0. 누락 필드 단정 실패, UI는 정상 제안 오표시 | 통과. 두 누락 필드와 UI 실패 표시 확인 |
| T3 올바른 패킷 | 통과 | 통과 |
| T4 Questions-only | 수용 확인 | `DISCUSSING`, 임의 요구사항 0건 |
| T5 잘못된 type | 업무 거절·ACK 0. 구조적 진단 단정 실패 | `type` 오류, 변환 없음 |
| T6 JSON 오류 | JSON 거절·ACK 0. 구조적 진단 단정 실패 | 파싱 false, 구조적 오류 및 진단의 원문 미노출 확인 |
| T7 실제 프롬프트 정합성 | 기존 작업 트리의 3줄 예시 수용 확인 | `submitTurn()`에서 캡처한 원본을 실제 검증 경로로 수용 |
| T8 원문 보존 및 실패 상태 | 원문·실패 상태·ACK 0 확인 | 해시·길이·검증 상태·활성 소유권까지 확인 |
| T9 정상 ACK 연결 | 통과 | 모의 전송의 ACK 호출 직전 영속 `ACK_PENDING`, 확인 후 완료 및 소유권 해제 |
| T10 재시작 복구 | 원문과 오류를 보존하는 경로 확인. 신규 해시·필드 진단 단정 실패 | 서비스 재개방 후 원문·해시·형식 오류·소유권 일치 |
| T11 타 전송 충돌 | 타 전송 거절 | `generate()`의 응답 식별자 검사에서 거절. 응답 채택과 ACK 없음 |
| T12 완료 감시 | 격리 Chromium 통과 | 격리 Chromium 통과. 생성 중 반환 보류, 종료 후 원문 저장 확인 |

## §5. 코드 품질 검사

- `npm run lint` 통과, JavaScript 537개 확인. `npm run typecheck` 및 `npm run architecture:check` 통과.
- `scripts/run-tests.mjs` 직접 관련 9개 파일 193건 통과, 종료 코드 0. 실행 ID `4c545c75-0fe3-4eba-b45d-8fa40a7fc109`, 소스 지문 `5e93b719708ea680d0db67ce986e82d550eb75b557e59fb5de866dbdc1580fb5`, `candidateUnchanged:true`. 준비 서비스 51, 패킷 렌더링 6, 과거 패킷 사례 1, 응답 추출 1, 릴레이 7, 콘텐츠 17, 준비 API 1, 웹 런타임 33, 대시보드 76.
- 확대 Chromium 묶음은 20/21 통과했다. 실패 항목은 `project draft real DOM: newProjectTask new-run`이었다. `#startRoot`에서 기대 `C:/project`, 실제 빈 문자열이 나왔다. 변경 후보와 원래 Git 기준 커밋의 별도 복사본에서 동일하게 재현됐다. 이 경계의 수정은 패킷 작업 범위에 포함하지 않았다. 함께 선별 실행한 T12는 통과했다.
- 전체 `npm run check`는 실행 대상에서 제외했다. 이번 제품 변경 경계는 패킷·준비 서비스·복구 화면이다.

## §6. Git 증거

- 제품과 테스트 커밋은 `212b9cb95f3cec65185d5ce60fdb0a189a7251c3`이다. 해당 후보의 staged diff 검사에 통과했으며 §3의 일곱 소스·테스트 파일만 포함했다.
- 새 브랜치 최초 푸시 직후 `git ls-remote --exit-code --heads origin refs/heads/fix/controller-packet-contract-validation`로 같은 SHA를 확인했다. 이 문서는 후속 문서 커밋이다. [새 브랜치](https://github.com/jaehoon6523/app-web-agent-bridge/tree/fix/controller-packet-contract-validation)

## §7. 운영 검증과 남은 과제

운영 저장소의 읽기 전용 SQLite 조회에서 `prep_aa2a85de-4b73-4b88-b123-90ee12440fb4` v9, `delivery_7c39b587-852d-4280-b714-9543e7a7653e`가 활성으로 확인됐다. 전후 상태는 `RECOVERY_REQUIRED / RESPONSE_COMPLETED / CONTROLLER_PACKET_MISSING`이고 서버 원문은 715바이트, SHA-256 `e0d07e6ba21ce3777bb1a1fa70a86010ec2e901fc56ebc32ecaa121adec03bd4`로 일치했다. 운영 Git 상태 출력 SHA-256은 전후 `81f64a4e5866e58c47f49825f48d4882d00d05c3672405046b09cf3f97bb9fc8`였다.

현재 호스트에서 8787 리스너가 관측되지 않았다. 운영 서버의 로드 코드와 Chrome 확장 실행 상태는 미확인이다. 운영 적용, Chrome 재로드, 기존 전달의 종결 및 실제 모델 전송은 미실행이다. 실제 모델 재검증에는 별도 승인된 대상과 전송 횟수가 필요하다. 기존 운영 전달의 종결도 별도 승인 범위다.

## §8. 최종 판정

| 항목 | 결과 |
| --- | --- |
| `PACKET_SCHEMA_CONTRACT_VERIFIED` | 통과 |
| `PROMPT_VALIDATOR_ALIGNMENT_VERIFIED` | 실제 전송 인자 캡처 기반 통과 |
| `INVALID_RESPONSE_PRESERVATION_VERIFIED` | 격리 서비스 및 DB 재개방 통과 |
| `COMPLETION_BOUNDARY_REGRESSION_VERIFIED` | 격리 Chromium의 생성 표시 및 정확한 응답 저장 확인 |
| `RELATED_INTEGRATION_VERIFIED` | 직접 관련 193건 통과. 확대 Chromium 묶음의 기준 실패는 §5에 기록 |
| `BRANCH_PUSH_VERIFIED` | 제품 커밋의 로컬·원격 SHA 일치 |
| `LIVE_CHATGPT_E2E_VERIFIED` | `NOT_EXECUTED` |
