# CLI 구현 · 웹 감사 Bridge

CLI 구현 → 고정 후보·실행 증거 → 웹 감사 → 지적 → 수정·재감사 흐름을 연결합니다. 필수 요구사항별 판정과 미해결 지적을 검사하며 점수는 통과 권한을 갖지 않습니다. 감사 통과와 대상 저장소 적용은 별개입니다.

구현 기준은 사용자가 제공한 **「CLI 구현·웹 감사 시스템 통합 기준안」 v1.0 (2026-09-07), REQ-01~21**입니다. 현재 구현·검증 범위와 남은 항목은 [TODO.md](TODO.md)에 기록합니다. 이 저장소에 코드가 있거나 자동 테스트가 통과했다는 사실을 실제 Codex·ChatGPT 연동 완료로 확대하지 않습니다.

## 현재 경로

- 주 콘솔과 `POST /api/runs/start`는 `CODE_CHANGE`로 시작합니다. 목표와 기존 ChatGPT 대화 URL만 받습니다.
- 프로젝트·요구사항·허용 검증·한도는 서버 시작 때 읽은 프로젝트 설정에서 공급합니다. 실행 중 설정 파일 변경은 기존 런에 반영되지 않습니다.
- 한 번에 한 런을 수행하고 과거 런은 조회할 수 있습니다. 중단·별도 적용·기록 다운로드·증거 원문 조회를 지원합니다.
- HTTP 조회를 사용합니다. 대시보드 WS, pause/resume/retry, 실행 중 자유입력은 CODE_CHANGE 초기 범위에서 보류합니다. 과거 DISCUSSION 엔진과 명령은 별도로 남아 있습니다.
- 접수 시 런을 저장하고 ID를 반환합니다. 이후 웹 준비 실패·구현 실패도 해당 런에 남습니다.

## 실행 설정

Node.js는 `package.json`의 engines 조건을 사용합니다. 이 환경에서 검증한 설치 버전과 호환 여부는 실제 검사 결과로 판단합니다.

```powershell
npm ci
Copy-Item .env.example .env
```

이미 `.env`가 있으면 덮어쓰지 말고 필요한 설정만 추가하세요.

| 설정 | 의미 |
|---|---|
| `WEB_EXTENSION_SHARED_SECRET` | 확장과 일치하는 32 UTF-8 바이트 이상의 secret |
| `WEB_EXTENSION_EXPECTED_IDENTITY` | 확장 popup에 표시된 identity |
| `DASHBOARD_TOKEN` | 확장 secret과 별개인 base64url 로컬 명령 토큰 |
| `CODEX_EXECUTABLE` | 실제 Codex 실행 파일 절대 경로. Windows는 `.cmd`가 아닌 `.exe` |
| `WORKSPACE` | 컨트롤러의 기본 작업 경로 |
| `CONTROLLER_DATA_DIR` | SQLite·아티팩트 경로, 기본 `.agent-controller` |
| `AUDIT_PROJECT_FILE` | 아래 프로젝트 JSON의 경로. 없거나 잘못되면 구현 시작 차단 |

프로젝트 JSON 예시입니다. **아래 요구사항·한도는 형식 설명용이며 이 시스템의 REQ-01~21을 충족하는 설정이나 확정 운영값이 아닙니다.** 실제 요구사항 문서에서 항목과 검증 방법을 옮기고 운영자가 한도·명령을 지정해야 합니다.

```json
{
  "projectId": "my-project",
  "targetRoot": "C:/work/my-project",
  "requirements": {
    "requirementsId": "my-project-requirements",
    "revision": "1",
    "sourceRoles": [{"source": "approved-spec.md", "role": "acceptance"}],
    "unresolvedQuestions": [],
    "items": [{
      "requirementId": "APP-01",
      "statement": "필수 사용자 동작을 구체적으로 작성",
      "acceptanceCriteria": "관찰 가능한 입력·결과·실패 조건을 작성",
      "required": true,
      "verificationMethod": {
        "kinds": ["CODE_SNAPSHOT", "EXECUTION"],
        "description": "해당 코드와 실제 사용자 동작 검사 결과를 함께 확인"
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

`verificationMethod.kinds`는 `CODE_SNAPSHOT`, `PATCH`, `EXECUTION`, `ARTIFACT` 중 필요한 종류를 지정합니다. `AGENT_CLAIM`은 충족 증거를 대신하지 않습니다. 요구사항 내용이 바뀌면 새 revision을 사용합니다. 동일 ID·revision으로 다른 내용을 시작하면 거절합니다. 이전 런의 감사가 새 revision을 승인하지 않습니다.

등록 검증은 실행 파일과 리터럴 인자 배열을 사용하며 셸 문자열을 해석하지 않습니다. 웹은 `verificationId`만 요청할 수 있습니다. `.cmd`·`.bat`·`.ps1` 래퍼는 직접 실행하지 않습니다. 검증 도구가 결과 파일을 만들면 `resultFiles`에 작업 위치 기준 상대 경로를 등록합니다.

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

지적 ID는 컨트롤러가 발급합니다. `OPEN → FIX_SUBMITTED`는 CLI의 수정 제출이고 해결이 아닙니다. 웹이 현재 후보 근거와 해결 조건을 확인해야 `RESOLVED`가 됩니다. 보고서에서 빠진 지적은 유지합니다. `WITHDRAWN`은 근거 있는 철회입니다.

캡처에는 기준 commit·후보 tree·patch hash·변경 파일·전체 blob 원문을 저장합니다. Git 객체가 나중에 정리돼도 이미 캡처한 코드 원문은 콘텐츠 주소 아티팩트에서 조회할 수 있습니다. 추가 코드 조회는 정규 파일만 허용하며 경로 탈출·symlink·submodule·바이너리 텍스트 조회를 거부합니다.

실행 증거는 명령·인자·위치·환경 식별·후보·시각·종료 코드·실패·시간 초과·출력을 수집합니다. 실행 전후 후보 변경을 확인하고 바뀌면 해당 실행·결과 아티팩트를 원래 후보의 유효 증거로 인정하지 않습니다. 종료 코드 0만으로 기능 통과를 계산하지 않습니다. stdout/stderr는 각각 8 MiB를 넘으면 잘림을 명시합니다. 현재 결과 파일 수집은 8 MiB 이하 텍스트 파일이며 바이너리는 제공 불가 사유를 남깁니다.

원문에는 민감값 제거를 적용하고 전달 구간·총 줄 수·생략 여부를 표시합니다. 콘솔의 증거 원문 버튼과 `evidence.get`으로 다음 구간을 읽을 수 있습니다. 출력·자료 제한으로 판단에 필요한 증거가 없으면 웹은 보완 요청 또는 판단 불가를 보고해야 합니다.

## 저장·중단·적용

`code_change_runs`는 현재 상태, `code_change_history`는 버전별 기록, `audit_command_receipts`는 명령 의도·결과를 저장합니다. 상태 변경은 expectedVersion을 검사합니다. 외부 감사 요청과 검증 의도는 전송 전에 저장합니다. 같은 명령 ID의 결과는 재시작 후에도 재사용하고, ID를 다른 명령에 재사용하면 거절합니다. INTENT만 남은 명령은 자동 실행하지 않습니다.

중단을 접수하면 후속 배정을 차단합니다. 외부 종료 확인이 부족하면 `RECOVERY_REQUIRED`와 중단 불확실 이유를 남깁니다. 늦은 응답은 새 구현·통과·적용을 시작할 수 없습니다. 런 한도와 외부 턴 시간 초과도 성공으로 바뀌지 않습니다.

감사 통과 후보의 적용은 candidateId·reviewId·patch hash·baseCommit·상태 버전이 모두 맞아야 합니다. clean target에 저장된 patch를 적용하고 실제 tree를 비교합니다. 적용은 commit·push·배포를 수행하지 않습니다. 적용 중 재시작하면 대상이 기준인지 승인 후보인지 그 외인지 판별하고 자동 재적용하지 않습니다. worktree는 감사 기록·복구 확인을 위해 보존합니다.

과거 스키마의 점수 기반 PASS는 새 기준의 PASS로 마이그레이션하지 않습니다. 진행 중이거나 적용 대기였던 과거 기록은 복구 필요로 두고, 원래 캡처·리뷰는 보존합니다.

## API

| 경로 | 역할 |
|---|---|
| `GET /api/health` | 실제 연결·관찰 상태. 실행하지 않은 검증은 `true`로 표시하지 않음 |
| `GET /api/preflight` | 시작 조건과 고정 프로젝트 설정 요약 |
| `POST /api/dashboard/session` | 동일 출처 로컬 브라우저의 임시 인증 |
| `GET /api/state?runId=...` | 인증된 진행·판정·지적·증거·과거 기록 조회 |
| `POST /api/commands` | `{type, requestId, payload}` 명령. CODE_CHANGE는 `run.start`, `run.stop`, `code.apply`, `evidence.get`, `evidence.export` |
| `POST /api/runs/start` | 목표·URL로 접수. `X-Request-ID` 필수, `202`와 런 ID 반환 |

명령은 Bearer 인증과 같은 Origin이 필요합니다. `run.start`의 payload는 `{mode:"CODE_CHANGE", expectedVersion:0, objective, conversationUrl}`입니다. 그 외 명령은 `runId`, `expectedVersion`을 포함합니다. 적용에는 `candidateId`, `reviewId`, `artifactHash`, `baseCommit`을 추가합니다.

## 검증

```powershell
npm run check
node --test --experimental-test-isolation=none tests/audit-boundaries.test.js tests/audit-console.test.js
```

자동 검사는 임시 실제 Git 저장소·실제 Node 검증 명령·SQLite와 모의 CLI/Web 응답을 사용합니다. `audit-console.test.js`는 배포 UI 스크립트를 DOM/네트워크 대역으로 검사하며 실제 브라우저 검사와 구분합니다. 실제 웹 감사자가 누락을 찾아내는지, 설치된 확장·로그인·OS 권한을 포함한 전체 흐름은 별도 실연동 검증이 필요합니다.
