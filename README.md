# Codex / ChatGPT Web Agent Bridge

이 프로그램의 목적은 **Codex가 실제 개발 작업을 수행하고, Controller가 Git diff와 작업 증거를 고정해 ChatGPT Web에 검토시키며, 검토 결과에 따른 재작업과 승인된 대상 레포 반영까지 연결하는 것**입니다.

## 목표 동작 — 2026-09-06 사용자 정정 반영

기존 Bridge의 Controller, Dispatcher, Codex Adapter, Web Adapter를 실제 외부 시스템에 연결해 아래 흐름을 완성합니다. 현재 DISCUSSION 구현만으로 프로그램의 목적이나 완료 범위를 한정하지 않습니다.

```text
목표·검토 기준 → Controller의 Worker brief
  → 실제 Codex app-server → 실제 파일 변경
  → Controller가 Git diff·파일·실행 증거를 Artifact로 캡처·고정
  → 실제 ChatGPT Web Reviewer → 검토 보고서
  → Controller의 정책 판단
      REWORK → 이전 Artifact·지적 사항·반복 번호를 담은 새 brief
             → 새 Codex Worker 세션 → 변경·캡처·검토 반복
      PASS   → 사람 또는 별도 승인 단계 → 검토된 변경을 대상 레포에 반영
```

| 역할 | 책임과 권한 |
|---|---|
| Codex Worker | brief를 받아 실제 코드를 작성·수정하고 작업 결과를 제출합니다. Worker는 작업 역할이며 브라우저 Web Worker를 뜻하지 않습니다. |
| Controller | 요청과 세션·턴을 결합하고, 실제 변경 증거를 캡처·해시로 고정하며, 검토 기준에 따라 PASS/REWORK와 다음 작업을 결정합니다. |
| ChatGPT Web Reviewer | 목표·고정된 Artifact·검토 기준을 받아 점수, 지적 사항, 근거 참조, 요약을 반환합니다. 승인·merge·다음 행동을 명령하는 주체가 아닙니다. |
| 사람 또는 별도 승인 단계 | PASS 이후 대상 레포 반영을 승인합니다. 검토 통과와 반영 완료를 구분합니다. |

Codex의 “구현했습니다”라는 텍스트만을 변경 증거로 전달하지 않습니다. Controller가 실제 Git 변경과 필요한 파일·실행 증거를 확보하고 검토 대상에 결합해야 합니다. 검토한 변경과 반영할 변경이 동일한지도 확인해야 합니다.

작업 공간은 격리된 Git worktree 방식을 우선 검토합니다. REWORK는 새 Worker 세션에 명시적인 brief와 이전 증거를 전달하는 방식으로 연결합니다. 같은 반복의 장애 복구와 다음 반복의 새 세션 생성을 구분합니다. Worker와 Reviewer는 대화 컨텍스트를 공유하지 않습니다.

`master-workflow` 및 사용자가 언급한 Git diff 수신·반영 참고 레포를 대조 대상으로 삼습니다. 해당 경로와 실제 구현은 아직 확인하지 않았으며, 참고 레포의 구현 완료 여부를 이 Bridge의 완료 근거로 간주하지 않습니다.

Reviewer 점수 임계값(예시의 9점), 정확한 보고서 wire schema, worktree 기준점·정리 정책, 최종 반영 명령은 이 문서에서 임의로 확정하지 않습니다. 사용자 설명의 예시 JSON을 현재 구현된 API라고 주장하지 않습니다.

Agent가 제공한 값이 Controller의 허용 행동이나 repair 권한을 정하지 못하도록 해야 합니다. 2026-09-06 현재 DISCUSSION 경로를 점검한 결과, repair 정책은 저장된 원래 요청과 Controller action policy에서 도출되며 진단 evidence와 위조된 repair 정책을 다루는 기존 테스트를 포함해 20개가 통과했습니다. 지적된 `candidatePacketType → repair authority` 문제는 현재 경로에서 재현되지 않았습니다. 이 결과가 향후 개발 루프의 권한 경계까지 검증한 것은 아닙니다. 근거와 실행 명령은 [TODO.md](TODO.md)에 기록했습니다.

## 현재 구현 상태와 목표의 차이

현재 서버는 Codex app-server 및 확장용 연결 코드를 갖추고 있으며, 실행 상태·입력·응답·제안·합의 결과를 SQLite에 저장합니다. 대시보드 시작 경로는 DISCUSSION만 허용하고, 기존 합의 판정은 동일한 persisted proposal hash에 대한 양쪽 승인입니다. 이것은 위 목표의 점수 기반 개발 검토·재작업·반영 루프와 구분해야 합니다.

Git worktree 생성·diff 캡처·저장된 patch 반영 모듈과 Codex 완료 후 캡처 연결부, 점수 검토 판정, Web Adapter의 Controller 지정 파서 연결부를 추가했습니다. 이 모듈들은 아직 대시보드의 개발 실행·저장 경로에 연결되지 않았습니다. 새 Worker 반복, 실제 ChatGPT 검토를 포함한 2~3회 반복 및 crash/recovery E2E는 미검증입니다.

| 추가 구현 | 현재 확인한 범위 |
|---|---|
| `src/repository/git-change-workspace.js` | clean target에서 격리 worktree 생성, 임시 index로 새 파일·삭제·바이너리 포함 diff 캡처, Artifact 해시 및 Git tree 검증 후 저장된 patch 반영. 기존 변경·HEAD 변경은 거부하고 submodule 포함 캡처는 미지원으로 거부합니다. commit·push는 하지 않습니다. |
| `src/runtime/code-change-worker.js` | 기존 CODE_CHANGE Adapter를 worktree에 연결하는 factory와 정확한 thread/turn 완료 후 캡처·Controller 저장 callback을 기다리는 연결부. 저장 실패 뒤 자동 재전송은 거부합니다. 실제 Codex 작업 검증은 아직 하지 않았습니다. |
| `src/domain/code-review.js` | `score`, `findings`, `evidenceRefs`, `summary`만 허용하는 검토 파서·판정 함수. Controller가 임계값과 허용 증거를 제공하며 Reviewer 권한 필드와 미제공 증거 참조는 거부합니다. |
| `src/runtime/web/session-adapter.js` | Controller가 생성 시 지정한 응답 파서를 사용 가능. 기본값은 기존 DISCUSSION 파서입니다. 서버의 기본 생성 경로는 아직 개발 검토 파서를 선택하지 않습니다. |

검증: 모듈 추가 후 전체 자동 테스트 355개 통과. 이후 Web 파서 연결 변경에 대해서는 관련 26개 테스트와 타입 검사를 통과했습니다. 전체 lint는 기존 변경이 있는 `src/persistence/sqlite-store.js`의 1,013줄/1,000줄 제한 초과로 실패합니다. 실제 서버 preflight 조회는 연결 거부(ECONNREFUSED)였으며, 실제 Provider E2E 결과로 대체하지 않습니다.

### 다음 연결 계약 제안 — 아직 API에 적용되지 않음

현재 저장 계약은 DISCUSSION 제안·합의를 중심으로 하므로 아래는 새로운 개발 실행 입력·저장·승인 의미의 제안입니다.

- 시작 입력은 기존 `run.start`의 `CODE_CHANGE` 분기에 대상 레포 절대 경로, 검토 기준, 명시적 점수 임계값, 최대 반복 수를 받습니다. 임계값 9를 자동 기본값으로 정하지 않습니다.
- 각 반복에서 Controller가 run/session/turn, 기준 commit, 후보 tree, diff Artifact hash, 검토 보고서와 정책 판정을 SQLite에 결합해 저장합니다. 재시작 시 이미 제출된 작업을 새 Worker 요청으로 다시 보내지 않습니다.
- REWORK는 기존 후보 파일 상태를 유지하되 새 Codex 세션과 새 brief로 시작합니다. 새 세션 생성과 같은 턴의 장애 복구를 구분합니다.
- PASS는 자동 반영이 아니라 반영 대기입니다. 대시보드에서 사용자가 정확한 후보 hash와 기준 commit에 결합된 ‘변경 반영’을 실행하면 저장된 patch를 clean target에 적용합니다. 이 조작은 commit·push·merge를 하지 않습니다.
- 반영 전후 실패 또는 재시작에서는 실제 target tree를 확인해 미반영·동일 후보 반영·불명확 상태를 구분합니다. 불명확 상태는 자동 재적용하지 않습니다.

이 제안의 외부 API 필드명과 저장 schema는 아직 추가하지 않았습니다. 사용자에게 보이는 승인 조작과 반영 대기 의미가 확정된 후 기존 Controller·저장소·대시보드에 연결합니다.

완료 기준은 실제 Codex 파일 변경 → Controller 증거 고정 → 실제 Web 검토 → REWORK → 새 Worker 수정 → 재검토 PASS → 승인된 변경 반영을 추적 가능한 증거로 확인하는 것입니다. 연결 성공, fixture 통과, 에이전트의 완료 주장만으로 전체 완료를 선언하지 않습니다. 상세 작업 목록은 [TODO.md](TODO.md)를 참고하세요.

아래 실행·API·제어 설명은 **현재 DISCUSSION 구현**에 관한 사용 안내입니다.

## 실행

Node.js 22.5 이상과 Chrome 또는 Edge 116 이상이 필요합니다.

```powershell
npm ci
Copy-Item .env.example .env
```

이미 `.env`가 있다면 덮어쓰지 말고 필요한 설정만 확인하세요.

- `WEB_EXTENSION_SHARED_SECRET`: 확장 프로그램과 동일한 32 UTF-8 바이트 이상의 secret
- `WEB_EXTENSION_EXPECTED_IDENTITY`: 확장 popup에 표시된 persisted identity
- `DASHBOARD_TOKEN`: 확장 secret과 별개인 32자 이상의 base64url 토큰
- `CODEX_EXECUTABLE`: 설치된 실제 Codex 실행 파일의 절대 경로. Windows에서는 `.cmd`가 아닌 `codex.exe`
- `WORKSPACE`: Codex 세션의 작업 폴더
- `CONTROLLER_DATA_DIR`: SQLite와 artifact 저장 경로. 기본값은 workspace의 `.agent-controller`

```powershell
npm start
```

Windows에서는 `start-live.cmd`를 실행해도 됩니다. 이 스크립트는 프로젝트 폴더를 기준으로 서버를 시작합니다.

## 브라우저 연결과 대시보드

1. `chrome://extensions` 또는 `edge://extensions`에서 개발자 모드를 켜고 이 프로젝트의 `extension/`을 압축 해제된 확장으로 로드합니다.
2. 확장 popup에 `ws://127.0.0.1:8787/ws/extension`과 shared secret을 저장합니다.
3. 확장 identity를 `.env`에 설정하고 서버를 재시작합니다.
4. 로그인된 ChatGPT의 기존 대화를 하나의 탭에서 엽니다.
5. [대시보드](http://127.0.0.1:8787)에 접속하면 `.env` 설정을 사용해 자동 연결됩니다. `HOST`나 `PORT`를 바꿨다면 해당 주소로 접속하세요. 서버는 같은 출처의 로컬 브라우저 요청에만 별도의 임시 접속 토큰을 발급합니다. `.env`의 토큰은 전송하지 않으며, 임시 토큰은 페이지 메모리에만 유지되고 서버를 재시작하면 만료됩니다. 수동 입력은 ‘직접 연결하기’에 있습니다.
6. 목표, 정확한 `https://chatgpt.com/c/...` URL, 짝수 최대 턴 수를 입력하고 Start를 누릅니다.

동일한 대화를 표시한 탭이 여러 개면 연결을 거부합니다. 대시보드는 인증된 HTTP로 상태를 주기적으로 갱신하고 명령 결과를 표시합니다.
토론과 코드 변경 모두 정확한 대화 탭·content script·입력창 준비를 확인한 뒤 실행 기록을 생성합니다. 준비 실패 시 실행이나 worktree를 만들지 않고 입력 화면에 원인과 조치 안내를 표시합니다. 탭 상태를 바로잡은 뒤 같은 입력으로 Start를 다시 누를 수 있습니다. 확장 연결만으로 대화 준비가 완료된 것은 아닙니다.
실제 Start는 Codex와 ChatGPT에 메시지를 보내므로 계정 사용량이 발생할 수 있습니다.

## 실행 제어

- **Start**: Web 대화를 먼저 확인하고 Codex thread를 시작한 뒤 백그라운드에서 토론을 진행합니다. 미완료 실행이 있으면 새 실행을 거부합니다.
- **Pause**: 현재 응답은 저장하되 다음 전송을 멈춥니다.
- **Resume**: 일시정지된 실행을 재개합니다. 서버 재시작 뒤에는 전송되지 않은 PENDING 작업만 기존 thread·conversation으로 재연결할 수 있습니다.
- **Stop**: CANCELLED 결과와 hash-linked 완료 이벤트를 저장합니다. 알려진 활성 턴에는 interrupt도 요청합니다.
- **Interrupt active turn**: 활성 턴의 정확한 ID를 확인한 뒤 일시정지하고 중단을 요청합니다. 불확실한 결과는 자동 재전송하지 않습니다.
- **Send steer**: 활성 Codex 턴에만 추가 지시를 보냅니다. ChatGPT Web은 steering을 지원하지 않습니다.
- **Open/focus tab / Rebind session**: 활성 전송이 없을 때 같은 Web 대화만 다시 연결합니다.
- **Export evidence**: 현재 실행의 대화, 이벤트, 전달 상태, 제안과 결과를 민감값 제거 처리를 거쳐 JSON으로 다운로드합니다.

지원되는 명령만 활성화됩니다. 승인·복구 side record를 해결하는 executor와 불확실한 제출의 결과 채택은 아직 연결되지 않았습니다.
이 경우 상태를 확인한 뒤 운영자가 처리해야 하며, 단순 Retry로 중복 전송하지 않습니다.
서버 재시작 직전 이미 전송된 작업은 PENDING 작업처럼 재개할 수 없습니다.

## HTTP API

- `GET /api/health`: 서버, Codex 프로세스, Web 연결 준비 상태
- `GET /api/preflight`: 실행 전 설정과 확장 인증 여부
- `GET /api/state?runId=...`: Bearer 인증이 필요한 실행 projection. runId 생략 시 최근 실행
- `POST /api/dashboard/session`: 로컬 주소·Host·Origin·Fetch Metadata 확인 후 브라우저용 임시 토큰 발급
- `POST /api/commands`: Bearer 인증과 같은 Origin이 필요한 대시보드 명령
- `POST /api/runs/start`: 기존 HTTP 호출자를 위한 동기 실행 경로. 대시보드와 동일한 실행 잠금 사용

명령 예시:

```json
{
  "type": "run.start",
  "requestId": "unique-command-id",
  "payload": {
    "expectedVersion": 0,
    "mode": "DISCUSSION",
    "objective": "검토할 목표",
    "conversationUrl": "https://chatgpt.com/c/conversation-id",
    "maxTurns": 6
  }
}
```

실행 중 명령은 `runId`와 최신 `expectedVersion`을 포함해야 합니다. 버전이 달라지면 409로 거부합니다.
동일한 requestId와 내용의 재요청은 서버 프로세스 내 최근 256개 명령 범위에서 기존 결과를 반환합니다.
서버 재시작 후에는 먼저 저장 상태를 조회하고, 결과가 불확실한 명령을 무조건 재요청하지 마세요.
대시보드 WebSocket 경로는 사용하지 않습니다. 확장 transport만 WebSocket을 사용합니다.

## 검증

```powershell
npm run check
npm run test:integration
```

`check`는 lint, typecheck와 전체 테스트를 실행합니다. 테스트는 가짜 Codex app-server와 Web 프로토콜/DOM fixture를 사용하며 외부 Provider에 메시지를 보내지 않습니다.
자동 테스트 성공이 실제 로그인된 ChatGPT 화면의 동작까지 증명하지는 않습니다.

```powershell
npm run projection:rebuild -- --database <absolute-db-path> --run-id <run-id>
```

Projection 복구는 대상 DB와 실행을 명시해야 합니다. 기존 데이터는 자동 삭제하거나 자동 재전송하지 않습니다.

## 구현 경계

- 서버는 loopback에서만 실행되며 확장 연결은 HMAC으로 인증합니다.
- Codex 실행 파일을 검증·고정하고 child environment는 allowlist로 구성합니다.
- DISCUSSION은 readOnly sandbox를 사용하지만 이 sandbox만으로 shell 실행 자체가 차단된다고 보장할 수 없습니다.
- 웹 응답 저장 후 확장에 durable acknowledgement를 보내 다음 전송을 허용합니다.
- 합의는 두 에이전트가 같은 persisted proposal hash를 승인해야 성립합니다.
- UI 스트리밍 미리보기는 저장된 최종 응답이나 합의 증거가 아닙니다.
- ChatGPT DOM 변경, 로그인 만료, CAPTCHA와 브라우저 확장 연결은 실제 환경에서 별도 확인이 필요합니다.
- `DEMO_MODE=true`는 정적 화면·서버 smoke용이며 가짜 대화를 생성하거나 live 실행을 허용하지 않습니다.

초기 ZIP과 기존 구조의 마이그레이션 근거는 [MIGRATION_PLAN.md](MIGRATION_PLAN.md)를 참고하세요.
