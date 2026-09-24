# CLI 구현 · 웹 감사 Bridge

CLI 구현 → 고정 후보·실행 증거 → 웹 감사 → 지적 → 수정·재감사 흐름을 연결합니다. 필수 요구사항별 판정과 미해결 지적을 검사하며 점수는 통과 권한을 갖지 않습니다. 감사 통과와 대상 저장소 적용은 별개입니다.

구현 기준은 사용자가 제공한 **「CLI 구현·웹 감사 시스템 통합 기준안」 v1.0 (2026-09-07), REQ-01~21**입니다. 현재 구현·검증 범위와 남은 항목은 [TODO.md](TODO.md)에 기록합니다. 이 저장소에 코드가 있거나 자동 테스트가 통과했다는 사실을 실제 Codex·ChatGPT 연동 완료로 확대하지 않습니다.

## 현재 경로

작업 상태와 웹 연결의 소유권 및 복구 경계는 [state-ownership.md](docs/state-ownership.md)에 기록합니다.

- 주 콘솔은 준비 대화·합의 승인을 거쳐 `CODE_CHANGE`를 시작합니다. 준비 API와 화면 계약은 [WORKFLOW_CONTRACT](public/WORKFLOW_CONTRACT.md), [API_INTEGRATION](public/API_INTEGRATION.md)을 참조하세요. 직접 `POST /api/runs/start`를 호출하는 CODE_CHANGE 경로에는 확정 프로젝트 설정과 정확한 기존 대화 URL이 필요합니다.
- 프로젝트·요구사항·허용 검증·한도는 콘솔의 **프로젝트 설정**에서 입력·저장합니다. 미종료 작업이 없을 때 변경할 수 있고 다음 작업부터 바로 반영됩니다. 기존 런의 기준은 변경하지 않습니다.
- 한 번에 한 런을 수행하고 과거 런은 조회할 수 있습니다. 중단·별도 적용·기록 다운로드·증거 원문 조회를 지원합니다.
- HTTP 조회를 사용합니다. CODE_CHANGE의 pause/resume/retry와 실행 중 자유입력은 지원하지 않습니다. 준비 대화의 답변과 기존 DISCUSSION 엔진은 별도 계약입니다.
- 접수 시 런을 저장하고 ID를 반환합니다. 이후 웹 준비 실패·구현 실패도 해당 런에 남습니다.

## 실행 설정

Node.js는 `package.json`의 engines 조건을 사용합니다. 이 환경에서 검증한 설치 버전과 호환 여부는 실제 검사 결과로 판단합니다.

```powershell
npm ci
npm start
```

`.env`는 서버 부팅의 필수 조건이 아닙니다. 특정 연동을 사용할 때만 `.env.example`에서 필요한 값을 설정하세요. 반대로 값을 명시했는데 형식이나 조합이 잘못된 경우에는 시작 시점에 거부합니다.

| 설정 | 필수 범위 | 의미 |
|---|---|---|
| `HOST` | 기본값 있음 | loopback bind 주소. 기본 `127.0.0.1`; 원격 bind는 지원하지 않음 |
| `PORT` | 기본값 있음 | HTTP/WebSocket 포트. 기본 `8787` |
| `WORKSPACE` | 기본값 있음 | 컨트롤러 기본 작업 경로. 기본 `.` |
| `CONTROLLER_DATA_DIR` | 기본값 있음 | SQLite·아티팩트 경로. 기본 `.agent-controller` |
| `DEMO_MODE` | 기본값 있음 | `true`이면 static/smoke 전용이며 live runtime은 비활성화 |
| `WEB_EXTENSION_SHARED_SECRET` | Web 연동 시 identity와 함께 필수 | 확장과 일치하는 32 UTF-8 바이트 이상의 secret |
| `WEB_EXTENSION_EXPECTED_IDENTITY` | Web 연동 시 secret과 함께 필수 | 확장 popup에 표시된 identity |
| `DASHBOARD_TOKEN` | 선택 | headless CLI/API 자동화용 stable token. 브라우저 콘솔은 임시 session token을 자동 발급받음 |
| `AUDIT_PROJECT_FILE` | 선택 | 기존 프로젝트 JSON. 콘솔에서 저장한 설정이 우선 |
| `CODEX_EXECUTABLE` | 실제 Codex 기능 사용 시 필수 | Codex 실행 파일 경로. 미설정이면 해당 기능만 not-ready |
| `CODEX_HOME` | 선택 | Codex 인증/home 경로를 runtime에 전달 |
| `CODE_WORKER_PROVIDER` | 기본값 있음 | `codex` 기본; `deepseek`, `claude`, `qwen`, `gemini` 지원 |
| `CODE_WORKER_MODEL` | 선택 | 구현 worker 모델 라벨 |
| `CODE_WORKER_EXECUTABLE` | non-Codex worker 사용 시 필수 | JSONL-compatible provider CLI/shim |
| `CODE_WORKER_ARGS` | 선택 | worker 실행 인자 JSON 배열 |
| `WEB_RESPONSE_TIMEOUT_MS` | 기본값 있음 | Web turn timeout. 기본 `300000` ms |

도구 전용 환경변수는 서버 부팅 조건과 별개입니다. `BRIDGE_BASE_URL`, `CERTIFY_RUN_ID`, `CERTIFY_EXPECT_APPLIED`는 certification에 사용하고, `UI_BROWSER_CHANNEL`, `UI_BROWSER_EXECUTABLE`은 UI QA에서 사용합니다. `BRIDGE_RESULT_DIR`, `BRIDGE_EXECUTION_ID`는 검증 프로세스에 컨트롤러가 주입하므로 운영자가 고정 설정하지 않습니다.

**처음 사용하는 경우:** 콘솔에서 `프로젝트 설정`을 열고 Git 저장소 절대 경로, 필수 요구사항과 통과 기준, 검증 프로그램과 인수, 실행 한도를 입력한 뒤 저장하세요. 검증 명령은 저장 시 실행되지 않습니다. 코드 검토만 수행할 수도 있으며, 이 경우 실제 동작 검증을 했다고 간주하지 않습니다.

설정은 컨트롤러 데이터 폴더의 `audit-project.json`에 저장되어 재시작 후에도 유지됩니다. 요구사항 변경 시 기준 버전을 올려 주세요. 기존의 복잡한 JSON 설정은 전체 설정 편집으로 보존하며, 다른 탭에서 변경한 설정을 오래된 화면이 덮어쓰지 않도록 저장 버전을 확인합니다.

새 작업이 미종료 작업 때문에 막혔다면 실행 기록의 **미종료 작업 확인 · 중단**을 눌러 해당 작업을 열고, 항상 표시되는 **작업 중단** 버튼을 사용하세요. 외부 종료가 불확실한 경우에는 복구 확인 후 실행 폐기 절차가 표시됩니다.

## 화면 시나리오 검증

`npm run test:ui`는 설치된 Chrome으로 실제 콘솔을 열어 시작 입력, 새 대화 응답 대기, 문서 변경 진단·취소, 준비 대화·답변·새로고침·합의 승인, 작업 중단·복구, 연결 끊김, 증거 조회와 적용, 모바일 레이아웃을 검사합니다. Edge를 사용하려면 `UI_BROWSER_CHANNEL=msedge`, 별도 브라우저 경로는 `UI_BROWSER_EXECUTABLE`을 지정하세요.

초기 화면과 인증은 임시 데이터 폴더의 실제 로컬 서버를 사용합니다. 준비·실행·감사·적용 상태는 명시적인 브라우저 테스트 데이터로 대체하므로 실제 Codex/ChatGPT 동작 인증을 뜻하지 않습니다. 사용자 기록은 변경하지 않습니다. 스크린샷은 `.agent-controller/ui-qa`에 저장되고, 실패 시 `failure.png`와 `failure.json`에 진단을 남깁니다. 일반 검사는 `npm run check`로 실행합니다.

## 프로젝트 JSON 가져오기

프로젝트 JSON 예시입니다. **아래 요구사항·한도는 형식 설명용이며 이 시스템의 REQ-01~21을 충족하는 설정이나 확정 운영값이 아닙니다.** 실제 요구사항 문서에서 항목과 검증 방법을 옮기고 운영자가 한도·명령을 지정해야 합니다.

```json
{
  "projectId": "my-project",
  "targetRoot": "C:/work/my-project",
  "requirements": {
    "requirementsId": "my-project-requirements",
    "revision": "1",
    "authority": "REQUIREMENTS_JSON",
    "sourceRoles": [{"source": "approved-spec.md", "role": "REFERENCE", "content": "참고 문서 원문을 여기에 고정합니다. 수용 조건은 아래 items에 명시합니다."}],
    "unresolvedQuestions": [],
    "items": [{
      "requirementId": "APP-01",
      "statement": "필수 사용자 동작을 구체적으로 작성",
      "acceptanceCriteria": "관찰 가능한 입력·결과·실패 조건을 작성",
      "required": true,
      "verificationMethod": {
        "kinds": ["CODE_SNAPSHOT", "EXECUTION"],
        "description": "해당 코드와 실제 사용자 동작 검사 결과를 함께 확인",
        "checks": [{"verificationId": "project-tests", "expectedExitCode": 0, "requiredResultFiles": []}]
      },
      "sourceRefs": ["approved-spec.md"]
    }]
  },
  "policy": {
    "maxIterations": 3,
    "maxEvidenceRounds": 3,
    "maxFormatRepairs": 2,
    "totalTimeoutMs": 1800000,
    "turnTimeoutMs": 300000
  },
  "verifications": [{
    "verificationId": "project-tests",
    "executable": "C:/Program Files/nodejs/node.exe",
    "args": ["--test", "tests/feature.test.js"],
    "cwd": ".",
    "timeoutMs": 60000,
    "purpose": "APP-01의 필수 동작 확인",
    "environmentId": "local-node-test-environment",
    "resultFiles": []
  }]
}
```

`verificationMethod.kinds`는 `CODE_SNAPSHOT`, `PATCH`, `EXECUTION`, `ARTIFACT` 중 필요한 종류를 지정합니다. `AGENT_CLAIM`은 충족 증거를 대신하지 않습니다. `EXECUTION` 또는 `ARTIFACT`를 요구하면 `checks`에 등록된 검증 ID·기대 종료 코드·필수 결과 파일을 지정해야 합니다. `ARTIFACT`에는 최소 하나의 필수 결과 파일이 필요합니다. `SATISFIED`는 각 검증의 **해당 후보에서 가장 최근 실행**과 그 실행에 속한 파일을 참조해야 하며, 기대 종료 코드 일치 외에도 시간 초과·중단·오류 없음과 후보 불변·종료 확인이 필요합니다. 실패 출력은 불충족 분석 자료로 보존합니다. 검증 성공만으로 기능 충족을 자동 선언하지는 않습니다.

`authority: "REQUIREMENTS_JSON"`은 `items`의 수용 조건이 최종 기준임을 명시합니다. 참고 문서는 `sourceRoles`의 `REFERENCE` 원문으로 고정하며 파일 경로를 실행 중 다시 읽어 기준으로 사용하지 않습니다. 모든 `sourceRefs`는 등록된 원문을 가리켜야 합니다. 참고 문서에만 있는 필수 조건은 운영자가 시작 전에 `items`로 옮겨야 하며 충돌·미정 사항은 `unresolvedQuestions`에 기록합니다. 원문도 요구사항 해시에 포함됩니다. 요구사항 내용이 바뀌면 새 revision을 사용합니다. 동일 ID·revision으로 다른 내용을 시작하면 거절합니다. 이전 런의 감사가 새 revision을 승인하지 않습니다.

등록 검증은 실행 파일과 리터럴 인자 배열을 사용하며 셸 문자열을 해석하지 않습니다. 웹은 `verificationId`만 요청할 수 있습니다. `.cmd`·`.bat`·`.ps1` 래퍼는 직접 실행하지 않습니다. 검증 도구가 결과 파일을 만들면 `resultFiles`에 `BRIDGE_RESULT_DIR` 기준 상대 경로를 등록합니다. 검증 프로그램은 컨트롤러가 매 실행 새로 만든 이 디렉터리에 결과를 기록해야 합니다. 작업 사본에 남은 파일은 수집하지 않습니다. `BRIDGE_EXECUTION_ID`도 환경 변수로 전달합니다. 심볼릭 링크·하드 링크 결과는 거절하고, 수집 후 임시 디렉터리는 정리합니다.

허용 검증은 **신뢰하는 프로젝트 운영 설정**입니다. 자식 프로세스의 작업 위치와 환경 변수 전달을 제한하지만, 호스트에서 실행하는 검증 명령 자체를 OS 샌드박스로 격리하는 구현은 아닙니다. Codex에는 `workspaceWrite`와 작업 worktree, 네트워크 비허용 정책을 전달합니다. 설치된 app-server 계약의 제한된 읽기 경로 지원과 실제 OS 권한 효과는 별도 검증 대상입니다. Git worktree를 권한 격리의 증거로 간주하지 않습니다.

```powershell
npm start
```

브라우저에 `extension/`을 압축 해제된 확장으로 로드하고 popup에 `ws://127.0.0.1:8787/ws/extension`과 secret을 설정합니다. 기존 ChatGPT 대화 탭을 하나만 열고, `http://127.0.0.1:8787`에서 대상·기준을 확인한 뒤 목표·대화 URL로 시작합니다. 로컬 브라우저 인증과 requestId는 콘솔이 처리합니다.

## 감사·증거 계약

`src/domain/audit-contract.js`와 `src/domain/code-review.js`가 실행 중 입력·응답을 검사합니다. 모든 응답은 `runId`, `requestId`, `candidateId`, `requirementsRef`로 결합됩니다. 보고서는 `REVIEW_REPORT`, 추가 요청은 `EVIDENCE_REQUEST`입니다. 실제 요청에 응답 필드 설명과 고정된 문맥을 함께 전달합니다.

- `SATISFIED`: 필요한 종류의 해당 후보 증거와 판정 이유가 있어야 합니다.
- `UNSATISFIED`: 확인한 불충족을 보존합니다.
- `UNDETERMINED`: 부족한 정보와 이유를 보존합니다.
- 필수 불충족·미해결 지적은 `REWORK`, 필수 판단 불가·새 후보에서 해결 지적의 재검증 미완료는 `HOLD`, 나머지 필수 통과 조건을 충족할 때만 `PASS`입니다.

지적 ID는 컨트롤러가 발급합니다. `OPEN → FIX_SUBMITTED`는 CLI의 수정 제출이고 해결이 아닙니다. 웹이 현재 후보 근거와 해결 조건을 확인해야 `RESOLVED`가 됩니다. 보고서에서 빠진 지적은 유지합니다. `WITHDRAWN`은 근거 있는 철회입니다. `newFindings`는 수용 조건 위반이며 필수 요구사항의 위반은 웹의 `required:false`와 무관하게 컨트롤러가 필수 지적으로 유지합니다. 수용 조건 밖의 선택 개선안은 `suggestions` 배열(`requirementId`, `description`, `evidenceRefs`)로 별도 기록합니다.

캡처에는 기준 commit·후보 tree·patch hash·변경 파일·전체 blob 원문을 저장합니다. Git 객체가 나중에 정리돼도 이미 캡처한 코드 원문은 콘텐츠 주소 아티팩트에서 조회할 수 있습니다. 추가 코드 조회는 정규 파일만 허용하며 경로 탈출·symlink·submodule·바이너리 텍스트 조회를 거부합니다.

실행 증거는 명령·인자·위치·환경 식별·후보·시각·종료 코드·실패·시간 초과·출력을 수집합니다. 실행 전후 후보 변경을 확인하고 바뀌면 해당 실행·결과 아티팩트를 원래 후보의 유효 증거로 인정하지 않습니다. 종료 코드 0만으로 기능 통과를 계산하지 않습니다. stdout/stderr는 각각 8 MiB를 넘으면 잘림을 명시합니다. 현재 결과 파일 수집은 8 MiB 이하 텍스트 파일이며 바이너리는 제공 불가 사유를 남깁니다.

원문에는 민감값 제거를 적용하고 전달 구간·총 줄 수·생략 여부를 표시합니다. 콘솔의 증거 원문 버튼과 `evidence.get`으로 다음 구간을 읽을 수 있습니다. 출력·자료 제한으로 판단에 필요한 증거가 없으면 웹은 보완 요청 또는 판단 불가를 보고해야 합니다.

## 저장·중단·적용

`code_change_runs`는 현재 상태, `code_change_history`는 버전별 기록, `audit_command_receipts`는 명령 의도·결과를 저장합니다. 상태 변경은 expectedVersion을 검사합니다. 외부 감사 요청과 검증 의도는 전송 전에 저장합니다. 같은 명령 ID의 결과는 재시작 후에도 재사용하고, ID를 다른 명령에 재사용하면 거절합니다. INTENT만 남은 명령은 자동 실행하지 않습니다.

코드 변경 이력은 각 버전의 내용 해시와 앞 버전 해시를 연결해 저장합니다. 시작 시 기존 이력을 검사한 뒤 연결하고, 이후 읽기·저장·적용 전에는 버전 누락, 해시 불일치, 현재 상태와 이력의 불일치를 거절합니다. 감사 기록 다운로드에는 검증된 버전별 해시 체인을 포함합니다. 이전 설치에서 가져온 이력은 **전환 당시의 무결성부터** 확인할 수 있으며 전환 이전에 변조되지 않았다는 증거는 아닙니다. 로컬 DB를 통째로 다시 작성할 권한이 있는 공격자에 대한 서명·외부 증명도 아닙니다.

대시보드 작업 목록은 대상 폴더별로 묶고 최근 작업을 먼저 보여줍니다. 연결 정보에서 확장 인증과 마지막으로 관찰된 대화 바인딩을 별도 표시합니다. 마지막 바인딩은 현재 탭이 유효하다는 보증이 아니며 실제 전송 때 다시 확인합니다.
Worker의 설정값과 실행 어댑터가 보고한 제공자·모델도 분리해 보존합니다. 보고가 없는 값은 설정값을 실행 확인 증거로 승격하지 않습니다. 어댑터 보고는 제공자 네이티브 실행 증명과 같지 않습니다.

중단을 접수하면 후속 배정을 차단합니다. 외부 종료 확인이 부족하면 `RECOVERY_REQUIRED`와 중단 불확실 이유를 남깁니다. 늦은 응답은 새 구현·통과·적용을 시작할 수 없습니다. 런 한도와 외부 턴 시간 초과도 성공으로 바뀌지 않습니다.

`RECOVERY_REQUIRED`에서 로컬 작업이 정리된 뒤 콘솔의 **복구 확인 후 실행 폐기**를 사용할 수 있습니다. 운영자가 CLI·검증 프로세스·ChatGPT 생성 종료와 대상 변경 상태를 직접 확인하고 사유를 입력하면 `run.abandon`이 `CANCELLED`로 종료합니다. 확인 내용은 자동 검증으로 가장하지 않고 `OPERATOR_ATTESTATION`과 현재 대상 HEAD·Git 상태로 보존합니다. 런·후보·작업 사본은 삭제하지 않고 적용 권한도 부여하지 않습니다. 로컬 작업이 남으면 폐기를 거절합니다. 서버가 멈췄다면 먼저 외부 작업을 종료하고 재시작한 뒤 확인하세요. 이후 새 실행도 clean target 사전 검사를 통과해야 합니다.

감사 통과 후보의 적용은 candidateId·reviewId·patch hash·baseCommit·상태 버전이 모두 맞아야 합니다. clean target에 저장된 patch를 적용하고 실제 tree를 비교합니다. 적용은 commit·push·배포를 수행하지 않습니다. 적용 중 재시작하면 대상이 기준인지 승인 후보인지 그 외인지 판별하고 자동 재적용하지 않습니다. worktree는 감사 기록·복구 확인을 위해 보존합니다.

현재 런 계약은 schemaVersion 3입니다. 이전 schemaVersion 1·2의 승인도 새 증거·기준 계약의 승인으로 승계하지 않습니다. 미완료 이전 런은 복구 필요로 남기고, 확인 후 폐기하고 새 설정으로 새 런을 시작해야 합니다. 이미 종료된 기록은 역사로 보존합니다. 기존 프로젝트 설정에는 `authority`, 참고 문서 원문, 필요한 `checks`를 명시적으로 추가해야 하며 자동으로 채워 승인하지 않습니다.

과거 스키마의 점수 기반 PASS는 새 기준의 PASS로 마이그레이션하지 않습니다. 진행 중이거나 적용 대기였던 과거 기록은 복구 필요로 두고, 원래 캡처·리뷰는 보존합니다.

## API

| 경로 | 역할 |
|---|---|
| `GET /api/health` | 실제 연결·관찰 상태. 실행하지 않은 검증은 `true`로 표시하지 않음 |
| `GET /api/preflight` | 시작 조건과 고정 프로젝트 설정 요약 |
| `GET /api/project` | 인증된 사용자의 저장된 프로젝트 설정과 편집 버전 조회 |
| `PUT /api/project` | 미종료 작업이 없을 때 검증된 프로젝트 설정 저장 (`project`, `expectedVersion`) |
| `POST /api/dashboard/session` | 동일 출처 로컬 브라우저의 임시 인증 |
| `GET /api/state?runId=...` | 인증된 진행·판정·지적·증거·과거 기록 조회 |
| `POST /api/commands` | `{type, requestId, payload}` 명령. CODE_CHANGE는 `run.start`, `run.stop`, `run.abandon`, `code.apply`, `evidence.get`, `evidence.export` |
| `POST /api/runs/start` | 목표·URL로 접수. `X-Request-ID` 필수, `202`와 런 ID 반환 |

명령은 Bearer 인증과 같은 Origin이 필요합니다. `run.start`의 payload는 `{mode:"CODE_CHANGE", expectedVersion:0, objective, conversationUrl}`입니다. 그 외 명령은 `runId`, `expectedVersion`을 포함합니다. `run.abandon`에는 `externalTerminationConfirmed:true`, `targetInspected:true`, 비어 있지 않은 `reason`을 추가합니다. 적용에는 `candidateId`, `reviewId`, `artifactHash`, `baseCommit`을 추가합니다.

## 검증

```powershell
npm run check
npm run test:browser
npm run check:critical
npm run test:ui
```

자동 검사는 임시 실제 Git 저장소·실제 Node 검증 명령·SQLite와 모의 CLI/Web 응답을 사용합니다. `tests/public/audit-console.test.js`는 배포 UI 스크립트를 DOM/네트워크 대역으로 검사하며 실제 브라우저 검사와 구분합니다. 실제 웹 감사자가 누락을 찾아내는지, 설치된 확장·로그인·OS 권한을 포함한 전체 흐름은 별도 실연동 검증이 필요합니다.

`test:browser`는 실제 Chromium에서 content script와 background 전체를 Web Adapter에 연결하고, 실제 Codex Adapter에 JSONL fixture 프로세스를 연결해 캡처→리뷰→REWORK→새 Worker→PASS를 검사합니다. Reviewer fixture는 캡처된 patch 내용을 읽어 판정하며 호출 횟수로 PASS를 반환하지 않습니다. Chrome API와 제공자 페이지/응답은 대역이므로 실제 Codex·ChatGPT 성공 증거는 아닙니다. 설치된 Chrome이 없으면 실패하며 자동 skip하지 않습니다. `check`에는 브라우저 검사가 포함되지 않으므로 확장 변경 시 두 명령을 모두 실행하세요.

`test:critical`은 고정 장애 HTML과 원문 oracle을 사용해 DOM → content script → Chrome message boundary → background → Web Adapter → PreparationService → SQLite 복원 → 실제 dashboard 렌더링을 모두 통과시킵니다. 원문 SHA-256과 각 경계의 원문 보존, packet·합의·상태·UI를 각각 검사하며 이름·경로·요구사항 수를 바꾼 변형 입력도 실행합니다. production 코드는 `tests/fixtures`를 참조할 수 없습니다. `test:sabotage`는 content 추출, packet 반영, UI 렌더링을 임시 복사본에서 각각 손상시킨 뒤 critical test가 반드시 실패하는지 확인합니다. `check:critical`은 일반 검사와 이 두 gate를 함께 실행합니다.

현재 연결 제안에 대한 검토, 코드 소유 위치와 실제 제공자 검증 순서는 [MIGRATION_PLAN](MIGRATION_PLAN.md)에 있습니다. 저장된 감사의 정합성 검사와 실제 제공자 검증의 차이는 [CERTIFICATION](docs/CERTIFICATION.md)에 명시합니다.
