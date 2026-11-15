# ChatGPT 응답 완료 판정과 원본 증거

## 기준과 범위

기준 커밋은 `175c948ae8a6d521b3309cb27731c4d1d291d5ac`다. `fix/controller-completion-invalid-closure`의 기존 6개 수정 파일을 그대로 이어받았다. Windows 10.0.26200 및 Node v22.14.0에서 검증했다. 운영 체크아웃 `forensics-20261110`과 미커밋 작업은 별도 트리에 있다.

이전 증거 ZIP은 이번 검사 시 기존 ZIP 경로에서 열리지 않았다. 동일 이름의 풀린 폴더에서 `MANIFEST.sha256`의 12개 파일이 모두 일치했다.

## 완료 판정 재현과 수정

수정 전 격리 Chromium은 현재 답변에 BEGIN 23바이트가 있고, 중지 버튼이 보이지 않으며 내용과 DOM이 안정화된 순간 완료를 반환했다. 같은 답변에 이후 JSON과 END를 붙이는 입력이었다. 실험 중 앞선 턴에도 완료 표시가 있었다.

읽기 전용 Chrome Elements 검사에서 임시 채팅의 완료 답변 영역과 액션 행을 감싸는 `data-talvt-turn-state="complete"`를 확인했다. ‘응답이 완료되었습니다’는 그 밖의 `role="status" aria-live="polite" aria-atomic="true"` 요소였다. 해당 관측은 이미 종료된 임시 채팅의 DOM에서 이뤄졌다. 같은 속성의 실제 스트리밍 전이, 다른 언어·페이지 변형의 적용 여부는 미확인이다.

ChatGPT 콘텐츠는 현재 assistant 메시지에 속한 완료 속성과 기존 관측 조건을 모두 확인한다. 이전 턴의 표시나 전역 알림은 현재 메시지 조건에 포함되지 않는다. 완료 속성이 없는 페이지 변형에서는 기존 제한 시간에 `AMBIGUOUS_COMPLETION`을 반환한다. 정상 완료가 확인된 BEGIN-only는 원문을 보존한 채 서버에서 `CONTROLLER_PACKET_MISSING`으로 거절됐다.

## 원본 저장

완료 판정 직전의 관측값과 확정 순간의 HTML을 같은 콘텐츠 실행 흐름에서 캡처한다. 실패·미확정 종료도 캡처한다. 완료 직후 최대 10초 동안 동일 문서·assistant ID에 대해 첫 번째로 관측한 추출 텍스트 변경을 별도 캡처한다. 저장 영수증의 캡처 ID로 전후를 연결한다.

- `page-raw.html`은 `document.documentElement.outerHTML` 전체다. 원본 파일에는 assistant, user, 턴, composer, 전송·중지 버튼, 본문 후보의 실제 DOM이 관측 가능한 경우 함께 저장된다.
- `response-raw.txt`는 assistant 요소의 `textContent`이고, `response-extracted.txt`는 확장이 사용하는 정확한 추출 문자열이다. `decision.json`은 식별자·시각·탐지 근거와 파일별 길이·SHA-256을, `manifest.sha256`은 개별 파일 무결성을 기록한다.
- 기존 인증된 로컬 WebSocket에서 전체 캡처를 여러 프레임으로 보내고, 서버가 파일을 동기화한 뒤 로컬 영수증을 반환한다. 저장 위치는 서버 workspace의 Git 제외 경로 `.agent-controller/decision-evidence-*/<capture-id>/`다. Windows에서 상속 권한을 끊고 서버 실행 계정의 접근을 명시했다. 원문은 비공개 증거 디렉터리에만 쓰며 일반 서버 로그에는 영수증과 해시 등 메타데이터가 남는다.
- 원문 크기 한도 초과, 연결 또는 파일 저장 실패 시 `FAILED`를 반환한다. 증거 상태는 파서나 정상 ACK 판정을 우회하지 않는다. 본문을 읽기 전에 페이지가 없어지거나 요소를 찾지 못하면 해당 요소 원본은 확보할 수 없다. 네트워크 응답·Shadow DOM 내부·관측 창 이후의 변화는 이 DOM 캡처에 포함되지 않는다.

합성 Chromium 캡처를 로컬 `.agent-controller/decision-evidence-samples/`에 보존했다. 완료 캡처 `d4ebec4c-4f32-4192-b315-fc2751efc1ad`의 페이지는 1,190,024바이트, SHA-256 `153c60d43167ffbfc6ba53e518a41107f1d26423acad12f5d5ba8110378ad6da`다. 응답은 139바이트, SHA-256 `5a3a3b670eab5c97910298522b6c0f638f4c735d63529373f169cd35d1024f04`다. 나중에 153바이트가 된 응답은 별도 `AFTER_CHANGE` 캡처에 저장됐으며 확장 완료 응답은 139바이트를 유지했다. 완료 파일을 Chromium에서 직접 읽은 HTML과 비교했고, 저장 manifest의 각 해시를 검증했다.

## 검증

| 명령 또는 범위 | 결과 |
| --- | --- |
| `node --test --test-name-pattern 'quiet streaming\|unsupported completion\|failed private store\|stable incomplete\|DOM fixture: reinjection' scripts/content-lifecycle-browser-suite.mjs` | 5 통과, 실패·skip 0. 조기 완료, 이전 턴, 속성 부재, 원본 저장 실패, 재주입 및 후속 변경 확인 |
| `node --test scripts/preparation-critical-suite.mjs` | 5 통과, 실패·skip 0. DOM, 콘텐츠 반환, 확장 결과, 웹 어댑터, SQLite 재개방을 대조했다. 정상 응답의 ACK와 소유권 해제, BEGIN-only의 원문과 미ACK 상태를 확인했다. |
| `node --test tests/decision-evidence-server.test.js` | 1 통과, 실패·skip 0. 실제 서버 WebSocket에서 인증 전 쓰기 거절, 인증 후 정확한 원문과 영수증 확인 |
| `node --test tests/content-lifecycle.test.js tests/extension-delivery-review.test.js tests/web-runtime-core.new.test.js tests/preparation-service.test.js tests/preparation-api.test.js tests/web-extension-storage.new.test.js` | 149 통과, 실패·skip 0 |
| `npm run lint`, `npm run typecheck`, `npm run architecture:check`, `git diff --check` | 통과 |

이전 확대 실행의 혼합 제공자 3건 실패는 기준 `175c948`의 별도 복사본에서도 `BROWSER_SCOPE_UNCONFIRMED` 또는 해당 흐름의 실패로 재현됐다. 같은 확대 실행에서 화면 식별 실패가 한 번 관측됐으며 기준과 최종 후보에서 해당 항목을 단독으로 실행했을 때 통과했다. 준비 임계 경로의 기존 프롬프트 단정은 기준에서 최신 문구와 어긋났고, 마커 인용·이스케이프 및 코드 펜스를 금지하는 실제 지시를 검사하도록 고친 뒤 후보에서 전부 통과했다. 전체 `npm run check`는 실행하지 않았다.

## 운영과 푸시

운영 SQLite를 마지막으로 읽었을 때 대상은 v9 `ACTIVE / RECOVERY_REQUIRED`, `RESPONSE_COMPLETED`였고 715바이트의 SHA-256은 `e0d07e6ba21ce3777bb1a1fa70a86010ec2e901fc56ebc32ecaa121adec03bd4`였다. 종결 영수증은 없었다. 운영 8787에는 관측 시 리스너가 없었고, Chrome Default 설치 경로의 디스크 버전은 0.2.23이었다. 현재 로드 코드의 동일성은 미확인이다. 기존 운영 코드의 무효 응답 종결 경로는 별도 격리 검사 8건으로 확인했다.

운영 v9 종결, 운영 확장 교체, 신규 실제 ChatGPT E2E는 모두 미실행이다. 최초 v9의 BEGIN-only 원인은 미확정이다. 원격 대상은 `refs/heads/fix/controller-completion-invalid-closure`이며 최종 커밋과 확인한 원격 SHA는 제출 응답에 기록한다.
