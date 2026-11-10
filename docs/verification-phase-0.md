# 검증 체계 재설계 — Phase 0 존재 증명

검사일: 2026-10-27. 대상: 현재 로컬 작업 트리, HEAD `06e5e3034e7ae8e67f6af4104097ef9bb952de75`.
증거 종류: 파일 존재 및 정적 코드 검사. 이번 조사에서는 테스트를 실행하지 않았다.
기존 수정·미추적 파일을 포함해 조사했으며, 커밋된 코드와 동일하다고 주장하지 않는다.
이 보고서는 Phase 0 제출물이며 경계 명세, 전이 테스트, 실행기 구현이 아니다.

## 1. 정정과 제출 상태

- 전체 기능의 관찰 가능한 Process를 재귀형 하위 입출력 트리로 분해한 구현: **미구현**. 그런 구현이 있다는 주장을 철회한다.
- `tests/`는 유형·계층·영역별 테스트 분류이며, 전체 기능의 재귀형 경계 트리라는 증거가 아니다.
- `scripts/verification-engine.mjs`, `scripts/verification-plan.mjs`, `scripts/verify-all.mjs`: 모두 실제 존재한다. 현재 파일의 존재 자체를 환각이라고 정정할 근거는 없다. 이전 답변 시점의 존재 여부까지 소급 증명하는 것은 아니다.
- 이번 요청에 이름이 명시된 이전 답변의 파일은 위 세 파일이다. 제공되지 않은 이전 답변의 다른 파일명까지 전부 확인했다고 주장하지 않는다.
- 격리 7/7 성공 주장은 통합 또는 시스템 성공 증거로 인정하지 않는다. 해당 실행의 원본 명령·테스트 ID·영수증을 특정하지 못했으므로 기존 성공 주장을 검증된 사실로 재사용하지 않는다.
- **G0 인수 완료를 주장하지 않는다.** 목록·소스·구현 부재 판정은 제출하지만, 원래 격리 7/7에 대한 대체 경계의 완전한 귀속은 미확인이다. 이를 끝내려면 당시 명령 또는 원본 로그/영수증 경로가 필요하다.
- Phase 1은 사용자의 명시적 승인 전까지 시작하지 않는다.

## 2. scripts/ 전체 파일 목록과 역할

하위 디렉터리·미추적 파일을 포함한다. 경로는 `scripts/` 기준이다. 아래 역할은 소스의 실행·수출 함수·호출 관계를 요약한 것이며 실제 실행 성공을 뜻하지 않는다.

| 파일 | 역할 |
|---|---|
| ack-windows-result.mjs | Windows ACK 검사 영수증을 현재 실행 ID·시간·예정 파일에 결속하고 판정한다. |
| architecture-audit.mjs | 소스 참조와 불변조건 패턴을 수집해 아키텍처 감사 자료를 만든다. |
| architecture-check.js | 모듈 의존·진입점 도달성 등 아키텍처 제약을 검사한다. |
| browser-extension-suite.mjs | 제어된 provider/Chrome 환경에서 브라우저 확장 전달·재검토 흐름을 검사한다. |
| certify.js | 검사 명령과 서버 조회를 통해 지정 실행의 감사·적용 조건을 확인한다. |
| content-lifecycle-browser-suite.mjs | DOM fixture에서 콘텐츠 재주입·전달 표식·복구 동작을 검사한다. |
| delivery-terminal-browser-suite.mjs | 브라우저 fixture에서 종료 전달의 폐기·복구 및 UI 관찰을 검사한다. |
| diagnose-server-child.mjs | 진단 대상 서버를 자식 프로세스로 시작하고 진단 이벤트를 전달한다. |
| diagnose-server.mjs | 서버 진단 자식과 watchdog을 관리하며 이벤트를 기록한다. |
| direct-chromium-reload-compare.mjs | 직접 실행한 Chromium/CDP 재로드 비교 실험을 조립한다. |
| direct-mv3-identity.mjs | MV3 worker 후보 중 실험 소유 확장과 실행 문맥을 식별한다. |
| doctor.js | 로컬 도구·설정·서버 상태에 대한 실행 준비 진단을 제공한다. |
| first-load-browser-suite.mjs | 실제 브라우저에서 초기 로드·응답 경쟁·화면 상태·명령 대상을 검사한다(미추적 파일). |
| latest-run.mjs | 최신 실행의 SQLite 잠금과 실행 소유권을 관리한다. |
| lint.js | 저장소 코드에 지정된 정적 lint 규칙을 검사한다. |
| minimal-native-reload-matrix-v2.mjs | 별도 프로세스·프로필로 최소 MV3 재로드 비교 행렬을 실행한다. |
| mv3-reload-core.mjs | MV3 비교 실험의 케이스·판정·자식 프로세스 감독을 제공한다. |
| native-extension-contract.js | 네이티브 확장 필수 단계·완결 판정·프롬프트 전송·HTML fixture를 정의한다. |
| native-extension-suite.mjs | 실제 확장 로딩과 네이티브 수명주기 단계의 증거를 수집한다. |
| native-reload-control.mjs | 네이티브 재로드 대조 실험의 증거와 종료 결과를 수집한다. |
| preparation-critical-suite.mjs | 제어된 브라우저 환경에서 준비 패킷의 바이트 보존과 처리 흐름을 검사한다. |
| preparation-tab-ux-browser.mjs | 탭 선택·진행·팝업·진단 내보내기 GUI 시나리오와 영수증을 만든다. |
| projection-rebuild.js | projection 재구축 명령을 파싱·실행하고 JSON 결과를 출력한다. |
| repair-selectors.mjs | 선택자 복구 제안 생성·검사·승인 해시 기반 적용 CLI를 제공한다. |
| run-delivery-ux-verification.ps1 | Windows에서 전달 UI·복구·플랫폼·전체 게이트를 실행하고 로그를 남긴다. |
| run-extension-pairing-verification.ps1 | 확장 페어링 관련 검증 실행과 최신 로그 확인을 제공한다. |
| run-preparation-tab-ux-verification.ps1 | Windows에서 준비 탭 집중 검사와 선택적 전체 회귀·브라우저 검사를 실행한다. |
| run-tests.mjs | 테스트 파일 발견·순차 실행·파일 기한·완결 영수증 수집을 담당한다. |
| run-windows-direct-reload.ps1 | Windows 재로드 진단을 호출하고 현재 실행 증거를 표시한다. |
| sabotage-critical-preparation.mjs | 준비 처리 코드를 의도적으로 변형해 중요 검사에서 결함을 검출하는지 확인한다. |
| server-watchdog.mjs | 서버 밖에서 heartbeat와 이벤트 루프 정지를 관찰한다. |
| test-completion-reporter.mjs | Node 테스트 스트림 종료·계획·결과를 완결 영수증으로 기록한다. |
| ui-scenario-fixtures.mjs | 실제 provider 실행 없이 UI 시나리오용 준비·작업·리뷰 상태를 제공한다. |
| ui-scenarios.mjs | 실제 서버 초기화와 명시적 fixture 전이를 사용해 브라우저 UI 시나리오를 실행한다. |
| verification-browser.mjs | 브라우저 설치 또는 지정 실행파일의 기동을 검사하고 식별 영수증을 만든다. |
| verification-engine.mjs | 단계 실행·선행 조건·현재 영수증 검증·증거 보관·최종 상태 집계를 수행한다. |
| verification-gui-contract.mjs | GUI 영수증에 요구되는 시나리오 ID 집합을 제공한다. |
| verification-identity.mjs | 실행 ID·소스 동일성·예정 집합·자원 종료 조건을 비교한다. |
| verification-plan.mjs | full/minimum 및 운영체제별 검증 단계와 예상 테스트 집합을 구성한다. |
| verification-source.mjs | Git 추적/비무시 파일의 현재 바이트로 소스 manifest와 해시를 만든다. |
| verify-all.mjs | 계획·실행 소유권·소스 식별·실제 자식 실행을 연결하는 전체 검증 진입점이다. |
| verify-delivery-recovery.mjs | 전달 복구 관련 소스와 검증 단계의 로그·결과를 수집한다. |
| windows-diagnostics.mjs | Windows 회귀·ACK·최소 재로드 진단 워크플로우를 조립한다. |
| diagnostics/environment.mjs | 재로드 실험 환경·소스 식별·고정 확장 fixture를 준비한다. |
| diagnostics/reload-observer.mjs | CDP를 통해 팝업·재로드·브라우저 종료 관측값을 수집한다. |
| diagnostics/reload-result.mjs | 재로드 관측값을 순수 판정하고 영수증을 읽고 쓴다. |
| e2e/flow-runner.mjs | flows.json에 정의된 흐름을 Node 테스트로 등록한다. |
| e2e/flows.json | E2E 흐름 ID와 실행 프로필의 정적 목록이다. |
| e2e/preflight-readiness.mjs | 서버 생존·시간 제한을 고려해 preflight 준비 상태를 기다린다. |
| e2e/progress.mjs | 예정 프로필과 완료 프로필 기준 진행 이벤트를 만든다. |
| e2e/startup.mjs | 실제 서버 프로세스의 초기 기동 흐름을 검사한다. |
| e2e/suite.mjs | E2E startup/wave 실행·해당 실행 증거 정리·결과 집계를 담당한다. |
| e2e/summary.mjs | 관찰 결과와 TAP skip을 바탕으로 E2E 요약을 만든다. |
| e2e/wave-suite.mjs | 개별 E2E flow 진입점을 브라우저 게이트에 등록한다. |
| e2e/with-browser.mjs | 브라우저 실행 환경을 준비하고 지정 명령을 실행한다. |
| e2e/fixtures/active-worker.mjs | 활성 worker 수명주기용 외부 Codex app-server 프로토콜 대역이다. |
| e2e/fixtures/worker.mjs | 실제 인증 서비스 대신 외부 JSONL worker 응답을 제공한다. |
| e2e/helpers/artifacts.mjs | 산출물별 독립 finalizer로 증거 쓰기를 등록한다. |
| e2e/helpers/browser.mjs | E2E용 브라우저를 실행한다. |
| e2e/helpers/closure.mjs | 종료 시나리오의 자원 해제 흐름을 검사한다. |
| e2e/helpers/dashboard.mjs | Dashboard 공통 E2E 동선과 정상 로컬 조작을 수행한다. |
| e2e/helpers/deadline.mjs | 비동기 작업에 제한 시간을 적용한다. |
| e2e/helpers/extension.mjs | 실제 서버 전송에 Chrome API·provider DOM을 제어한 확장을 연결한다. |
| e2e/helpers/external-lock.mjs | 외부 SQLite 읽기 잠금과 COMMIT 재시도를 다룬다. |
| e2e/helpers/initial-tab-selection.mjs | 실제 UI·서버·SQLite·소켓과 제어된 Chrome/provider를 이용해 초기 탭 선택을 검사한다. |
| e2e/helpers/lifecycle.mjs | 실행 상태·명령·저장 결과·Git·증거의 공통 수명주기 조작을 제공한다. |
| e2e/helpers/observations.mjs | 브라우저 응답에서 상태 조건을 기다리고 텍스트를 정규화한다. |
| e2e/helpers/operations.mjs | 메모·논의·보관·후속 실행·잠금 등의 E2E 조작을 제공한다. |
| e2e/helpers/owned-fixture.mjs | 소유 자원이 닫힌 뒤 임시 fixture 디렉터리 제거를 재시도한다. |
| e2e/helpers/preparation.mjs | 실제 Dashboard 조작과 제어된 provider 응답으로 준비 흐름을 진행한다. |
| e2e/helpers/process.mjs | 임시 작업 환경과 실제 제품 서버 자식 프로세스를 준비한다. |
| e2e/helpers/resources.mjs | E2E 자원별 finalizer와 해제 순서를 관리한다. |
| e2e/helpers/review.mjs | 제어된 리뷰 판정으로 제품 리뷰 계약을 검사한다. |
| e2e/helpers/worker.mjs | worker 작업공간·후보 생성·리뷰 연결 흐름을 검사한다. |
| e2e/platform/process.mjs | 운영체제별 자식 프로세스 실행·종료·프로세스 트리 수거를 제공한다. |

## 3. 성공 결과 재사용 검사

`verify-all.mjs` 자체에는 이전 성공 결과로 실행을 건너뛰는 코드가 없다. 아래에 전체 원문을 제출한다.
실제 실행을 위임받은 `verification-engine.mjs`도 확인했다.

- 각 applicable 단계에서 `await run(...)`을 호출한다.
- 실행 전 해당 receiptPath와 단계 evidencePaths를 제거한다.
- 단계마다 `runId + '-' + stage.id`라는 새 식별자를 요구한다.
- `identityMatches`가 현재 실행 ID·소스 해시·실행 전후 소스 동일성을 비교한다.
- 이전 성공 실행 디렉터리 또는 30일 지난 실행을 삭제하는 로직은 **보관 정리**이며 성공 재사용이 아니다. 이 삭제는 과거 증거 보존과는 별도의 문제다.
- 이전 browser 준비 영수증에서 executable 경로를 읽는 코드는 있다. 실행 경로 선택이며, 이전 성공 판정을 받아 현재 단계를 생략하는 코드는 아니다.
- `verificationPlan`은 `full`, `minimum`만 허용한다. QUICK/RESUME 모드, 영향 맵 기반 선택, 소스·환경 기반 성공 캐시는 여기서 구현되어 있지 않다.
- 코드의 원시 상태 문자열은 격리/통합/시스템을 구별하지 않는다. 아래 원문에 있는 `PASS`는 소스 인용이며 이번 조사의 성공 판정이 아니다. 계획의 `integration`이라는 이름만으로 실제 경계를 증명할 수도 없다.

## 4. 재귀형 입출력 트리 존재 여부와 실제 유사 코드

요구한 **전체 기능별 재귀형 입출력 트리는 미구현**이며 제출할 해당 트리 파일이 없다. `boundaries/`도 현재 없다.
다만 다음 실제 파일은 존재하며 그 내용을 아래 부록에 그대로 제출한다.

| 실제 경로 | 구현 내용 | 요구한 트리가 아닌 이유 |
|---|---|---|
| tests/helpers/progressive-io.mjs | levels 배열을 visit(index + 1, output)으로 순회하며 관찰값을 비교한다. | 재귀 호출 방식인 선형 체인이다. 기능별 부모 Process를 자식 경계 트리로 분해한 자료구조가 없다. |
| tests/public/progressive-io.test.js | 모델 정규화·명령 구성과 합성 단계의 깊이별 검사를 정의한다. | 응답 본문은 fixture 복제이며 실제 HTTP 응답이 아니다. |
| tests/public/dashboard-io-depth.test.js | Dashboard 상태 로드부터 명령 호출 기록까지 10단계 관찰과 고장 주입을 정의한다. | VM·대역 DOM·대역 fetch 기반이고 전체 기능 목록이나 분기형 경계 트리가 아니다. |
| tests/helpers/dashboard-ui.mjs | 실제 UI 소스를 VM에서 실행하기 위한 대역 브라우저 환경이다. | 브라우저·서버·DB를 연결하지 않는다. |

## 5. 격리 7/7의 stub/mock 경계 조사

**원본 실행 귀속 미확인.** 이번 대화에 원래 7개 테스트명·실행 명령·로그 경로가 없다.
소스/문서 검색과 `.agent-controller`, `evidence`, `test-latest.log`의 로그/JSON 검색을 했다.
`test-latest.log` 등 여러 파일에서 7개 성공 TAP 집계가 반복되므로 숫자만으로 원래 실행을 식별할 수 없다.
`docs/README-mv3-reload-v2.md`의 native 7/7 언급도 다른 범위이며 격리 7/7과 동일시하지 않는다.
따라서 아래를 **원래 7개 테스트의 대체 경계 전부라고 주장하지 않는다**. 확인한 Dashboard I/O 경로의 전체 명시적 대체 지점을 제출한다.

| 경계 | 실제 대체 방식 | 증명하지 못하는 것 |
|---|---|---|
| UI → 세션 HTTP API | fetch가 `/api/dashboard/session`에 `{token:'test'}` 반환 | 실제 인증·세션 발급·서버 응답 |
| UI → 상태 HTTP API | fetch가 `/api/state`에 전달받은 state 반환; withRunKnowledge가 일부 상태 보충 | 서버 projection·DB 조회·네트워크 오류 |
| UI → 명령/기타 API | calls 배열 기록 뒤 mutate 콜백 실행; 기본 응답 `{}` | 실제 명령 라우팅·권한·버전 검사·영속 상태 변경 |
| HTTP 응답 → 응답 처리 | 모든 fetch 응답을 `{ok:true,json:...}`로 생성 | 상태 코드·헤더·스트리밍·실제 지연·전송 실패 |
| UI → DOM | 사용자 정의 Element·Map·배열로 document 구현; HTML은 ID만 추출 | 브라우저 파싱·레이아웃·CSS·실제 화면 |
| UI → 이벤트/포커스 | Element listener를 객체에 보관; document listener·focus는 no-op, contains는 false | 실제 이벤트 전파·사용자 입력·포커스 이동 |
| UI → 브라우저 저장소 | sessionStorage를 Map으로 대체 | 탭/세션 수명·저장소 예외·재시작 지속성 |
| UI → 요청 ID 생성 | crypto.randomUUID가 항상 request-1 반환 | 실제 고유성·충돌 처리 |
| UI → 타임아웃/취소 | AbortSignal.timeout은 undefined, setTimeout은 no-op | 실제 timeout·취소·타이머 경쟁 |
| UI → URL/탐색 | location.search는 빈 문자열, origin 고정, reload no-op | 실제 URL 탐색·새 문서·새로고침 |
| 모듈 로더 → app.js | import/export 제거 후 의존성을 VM에 주입 | 브라우저 ES module 로딩·모듈 실행 순서 |
| polling → 갱신 주기 | 소스의 마지막 poll() 호출 제거 후 refresh() 직접 실행 | 실제 주기 polling과 그 경쟁 상태 |
| 모델 테스트 → HTTP 원본 | progressive-io.test.js가 fixture를 structuredClone | 실제 네트워크 응답의 수신·직렬화 |
| 모델 테스트 → 명령 전송 | command.payload를 sent로 복사 | 실제 HTTP 전송·서버 수락·DB/소켓/소유권 전이 |

실제인 부분은 파일 읽기, 일부 제품 모듈 함수, VM 안의 app.js 실행 및 메모리 관찰이다. 대역으로 대체한 경계를 통과했다고 보고할 수 없다.
`verification-plan.test.js`에도 실행기용 합성 source/readSource, run 콜백 및 합성 프로세스 종료 결과가 있다. 이것도 실제 전체 게이트 실행 증거가 아니며 원래 격리 7/7의 구성원인지 확정하지 않았다.

## 6. 조사 범위 및 다음 단계 제한

실행 명령: 파일 열람, Get-ChildItem 재귀 목록, rg 문자열 검색, git status 및 HEAD 확인.
환경 변수 값·`.env`·DB 내용은 열람하거나 보고서에 복사하지 않았다.
현재 작업 트리의 기존 수정 사항은 유지했다. 신규 산출물은 이 Phase 0 보고서뿐이다.
Phase 1~4, 테스트 추가/수정/실행, commit/push/CI 실행은 하지 않았다.
경계 전이 커버리지는 산정 불가다. 분모인 승인된 경계·전이 목록과 원래 7/7의 실행 귀속이 없기 때문이다.

## 7. 원문 부록

아래 부록은 파일에서 직접 읽은 전체 소스다. 상태 문자열은 원문을 보존했다. 이는 격리·통합·시스템 성공 보고가 아니다.

### scripts/verify-all.mjs

SHA-256: 96ed875fbf6eee7e8a537d122ab952be380b4c90eaa93e0ee77bebc51825527a

```javascript
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {verificationSource} from './verification-source.mjs';
import {acquireLatestRun} from './latest-run.mjs';
import {runOwnedNode} from './e2e/platform/process.mjs';
import {verificationPlan} from './verification-plan.mjs';
import {executeVerification} from './verification-engine.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const scope=process.argv.find(arg=>arg.startsWith('--scope='))?.slice(8) || 'full';
const plan=verificationPlan({scope});
if(process.argv.includes('--list')) {
  process.stdout.write(JSON.stringify({scope,node:process.version,platform:process.platform,stages:plan},null,2)+'\n');
} else {
  const directory=path.resolve(process.env.BRIDGE_VERIFICATION_OUTPUT || path.join(root,'.agent-controller'));
  const runId=randomUUID(), lease=acquireLatestRun(directory,'verification',runId), abort=new AbortController();
  const cancel=()=>abort.abort();process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
  process.stdout.on('error',()=>{});
  try {
    const source=verificationSource(root);
    const result=await executeVerification({root,directory,plan,source,runId,signal:abort.signal,
      readSource:()=>verificationSource(root),output:chunk=>{if(!process.stdout.destroyed)process.stdout.write(chunk);},
      run:async(stage,{write,stageRunId,signal})=>{
        const npmCli=process.env.npm_execpath;
        if(!npmCli) throw Error('Run with npm run verify:all');
        const browserPath=path.join(directory,'latest-browser-preparation.json');
        const executable=stage.browser && stage.phase!=='PREPARATION' && fs.existsSync(browserPath)
          ?JSON.parse(fs.readFileSync(browserPath,'utf8')).executable:process.env.UI_BROWSER_EXECUTABLE;
        const env={...process.env,BRIDGE_VERIFICATION_RUN_ID:stageRunId,BRIDGE_VERIFICATION_OUTPUT:directory,
          ...(executable?{UI_BROWSER_EXECUTABLE:executable}:{})};
        delete env.NODE_TEST_CONTEXT;
        return runOwnedNode(stage.nodeArgs || [npmCli,...(stage.args || ['run',stage.command])],
          {cwd:root,env,timeoutMs:stage.timeoutMs,signal,onStdout:write,onStderr:write});
      }});
    process.exitCode=result.status==='PASS'?0:result.status==='PARTIAL'?2:1;
  } finally {process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);lease.release();}
}

```

### scripts/verification-engine.mjs

SHA-256: f8c6feed27141c64803e2ba86b7304a2b6550030c8148a1ec775dc5408f64ef1

```javascript
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {identityMatches,sameUniqueMembers,resourceClosureUnconfirmed} from './verification-identity.mjs';
import {nativeExtensionComplete} from './native-extension-contract.js';

export function receiptLocation(kind, root, directory) {
  return kind==='browser'?path.join(directory,'latest-browser-preparation.json'):kind==='gate'?path.join(root,'.agent-controller/latest-test-result.json')
    :kind==='e2e'?path.join(root,'.agent-controller/ui-qa/e2e-summary.json')
    :kind==='native'?path.join(directory,'latest-native-extension.json')
    :kind==='gui'?path.join(directory,'tab-ux-browser-latest.json'):null;
}
export function receiptComplete(kind, receipt, context) {
  if(!kind) return true;
  if(!identityMatches(receipt,context) || resourceClosureUnconfirmed(receipt)) return false;
  if(kind==='browser') return receipt.status==='PASS' && typeof receipt.version==='string' && typeof receipt.executable==='string';
  if(kind==='gate') return receipt.terminal===true && receipt.status==='PASS'
    && sameUniqueMembers(receipt.scheduled,context.expectedFiles)
    && Array.isArray(receipt.results) && sameUniqueMembers(receipt.results.map(item=>item.file),context.expectedFiles)
    && receipt.results.every(item=>item.pass && item.summary?.completed);
  if(kind==='e2e') return receipt.scope==='FULL SUITE' && receipt.failed===0 && receipt.unexpectedSkips===0
    && receipt.continuationBlocked===0 && receipt.fullRunnablePassed===context.expectedProfiles?.length
    && sameUniqueMembers(receipt.scheduledProfiles,context.expectedProfiles)
    && Array.isArray(receipt.profileResults) && sameUniqueMembers(receipt.profileResults.map(item=>item.id),context.expectedProfiles)
    && receipt.profileResults.every(item=>item.outcome==='PROFILE_PASS' || item.id==='UF-01A' && item.outcome==='PASS');
  if(kind==='native') return nativeExtensionComplete(receipt);
  if(kind==='gui') return receipt.exitCode===0 && typeof receipt.browserVersion==='string'
    && sameUniqueMembers(receipt.scheduledScenarios,context.expectedScenarios)
    && Array.isArray(receipt.scenarioResults)
    && sameUniqueMembers(receipt.scenarioResults.map(item=>item.id),context.expectedScenarios)
    && receipt.scenarioResults.every(item=>item.status==='PASS')
    && Array.isArray(receipt.assertions) && receipt.assertions.length>0
    && receipt.assertions.every(item=>item.status==='PASS' && context.expectedScenarios.includes(item.scenarioId))
    && context.expectedScenarios.every(id=>receipt.assertions.some(item=>item.scenarioId===id)) && !receipt.failure;
  return false;
}
function evidencePath(root,name) {
  if(typeof name!=='string' || path.isAbsolute(name) || name.split(/[\\/]/u).some(p=>!p || p==='.' || p==='..'))
    throw Error('UNSAFE_EVIDENCE_PATH');
  return path.join(root,'.agent-controller',name);
}
// Process closure and evidence validation are separate. Failures never disappear
// when a later independent stage succeeds. Callers inject execution for fault tests.
export async function executeVerification({root,directory,plan,source,readSource,run,
  signal,runId=randomUUID(),output=()=>{}}) {
  fs.mkdirSync(directory,{recursive:true});
  const runsRoot=path.join(directory,'verification-runs');
  if(fs.existsSync(runsRoot)) for(const name of fs.readdirSync(runsRoot)) {
    const previous=path.join(runsRoot,name);
    try {
      const receipt=JSON.parse(fs.readFileSync(path.join(previous,'result.json'),'utf8'));
      if(receipt.status==='PASS' || Date.now()-Date.parse(receipt.finishedAt)>30*86400000)
        fs.rmSync(previous,{recursive:true,force:true});
    } catch { /* Unknown or interrupted evidence is retained for inspection. */ }
  }
  const evidenceRoot=path.join(runsRoot,runId);
  fs.mkdirSync(evidenceRoot,{recursive:true});
  const result={runId,status:'RUNNING',startedAt:new Date().toISOString(),node:process.version,
    platform:process.platform,source,stages:structuredClone(plan),evidenceRoot,
    liveChatGpt:'UNVERIFIED: controlled external boundaries do not prove real ChatGPT delivery'};
  const resultPath=path.join(directory,'latest-verification.json'), logPath=path.join(directory,'latest-verification.log');
  fs.writeFileSync(logPath,''); let bytes=0;
  const save=()=>{
    const data=JSON.stringify(result,null,2)+'\n';
    for(const target of [resultPath,path.join(evidenceRoot,'result.json')]) {
      fs.writeFileSync(target+'.tmp',data); fs.renameSync(target+'.tmp',target);
    }
  };
  const log=chunk=>{const data=Buffer.from(chunk);fs.appendFileSync(logPath,data);bytes+=data.length;output(data);};
  save(); // The complete plan exists even if no child can start.
  let unsafe=false;
  try {
    for(const stage of result.stages) {
      if(!stage.applicable) {save();continue;}
      if(signal?.aborted || unsafe) {
        stage.reason=signal?.aborted?'CANCELLED':'RESOURCE_CLOSURE_UNCONFIRMED';save();continue;
      }
      const blocked=stage.needs.filter(id=>result.stages.find(item=>item.id===id)?.status!=='PASS');
      if(blocked.length) {stage.reason='PREPARATION_FAILED: '+blocked.join(',');save();continue;}
      const stageDirectory=path.join(evidenceRoot,stage.id);fs.mkdirSync(stageDirectory);
      stage.status='RUNNING';stage.reason=null;stage.startedAt=new Date().toISOString();
      stage.receiptKind=stage.receipt;stage.classification='UNKNOWN';stage.causeConfirmed=false;stage.logPath=path.join(stageDirectory,'output.log');
      fs.writeFileSync(stage.logPath,'');save();log('\nSTAGE '+stage.id+'\n');
      const write=chunk=>{fs.appendFileSync(stage.logPath,chunk);log(chunk);};
      const receiptKind=stage.receipt; delete stage.receipt;
      const receiptPath=receiptLocation(receiptKind,root,directory);
      try {
        if(receiptPath) fs.rmSync(receiptPath,{force:true});
        for(const name of stage.evidencePaths || []) fs.rmSync(evidencePath(root,name),{recursive:true,force:true});
        // Per-stage identity also prevents a different stage's gate receipt from
        // being accepted when a producer accidentally stops writing evidence.
        const stageRunId=runId+'-'+stage.id;
        stage.verificationRunId=stageRunId;
        stage.closure=await run(stage,{write,stageRunId,signal});

        if(receiptPath && fs.existsSync(receiptPath)) {
          stage.receipt=JSON.parse(fs.readFileSync(receiptPath,'utf8'));
          stage.receiptPath=path.join(stageDirectory,'receipt.json');
          fs.copyFileSync(receiptPath,stage.receiptPath);
        }
        if(receiptKind==='browser') result.browser=stage.receipt;
        const closed=stage.closure;
        const complete=receiptComplete(receiptKind,stage.receipt,{runId:stageRunId,source,expectedFiles:stage.expectedFiles,expectedProfiles:stage.expectedProfiles,expectedScenarios:stage.expectedScenarios});
        stage.status=closed.code===0 && closed.signal===null && !closed.forced && complete?'PASS':'FAIL';
        if(stage.status==='FAIL') stage.failurePhase=resourceClosureUnconfirmed(stage.receipt)?'CLEANUP':closed.code!==0?'EXECUTION':!complete?'EVIDENCE':'CLEANUP';
        if(receiptKind==='native' && closed.code===2 && closed.signal===null && !closed.forced
          && stage.receipt?.status==='UNVERIFIED' && stage.receipt.completed===true
          && identityMatches(stage.receipt,{runId:stageRunId,source}) && !resourceClosureUnconfirmed(stage.receipt)) {
          stage.status='NOT_RUN';stage.reason='NATIVE_BOUNDARY_UNVERIFIED';stage.failurePhase='ENVIRONMENT';
        }
        if(closed.forced || closed.signal!==null) unsafe=true;
        if(resourceClosureUnconfirmed(stage.receipt) || stage.receipt?.results?.some(item=>item.receiptCleanupError)) unsafe=true;
      } catch(error) {
        stage.status='FAIL';stage.error=error.message;stage.cleanupError=error.cleanupError;
        stage.failurePhase=error.cleanupError?'CLEANUP':error.code==='E2E_RUNNER_DEADLINE'?'TIMEOUT':'EXECUTION';
        // A deadline/cleanup error leaves resource ownership uncertain. Ordinary
        // assertion/evidence failures are independent and do not block siblings.
        if(error.cleanupError || error.code==='E2E_RUNNER_DEADLINE') unsafe=true;
      }
      try {
        const collected=path.join(stageDirectory,'evidence');fs.mkdirSync(collected);
        stage.collectedEvidence=[];
        for(const name of stage.evidencePaths || []) {
          const from=evidencePath(root,name);
          if(!fs.existsSync(from)) continue;
          const to=path.join(collected,name);
          fs.mkdirSync(path.dirname(to),{recursive:true});
          fs.cpSync(from,to,{recursive:true,filter:entry=>{
            if(fs.lstatSync(entry).isSymbolicLink()) throw Error('LINKED_EVIDENCE_PATH');
            return true;
          }});
          stage.collectedEvidence.push(name);
        }
      } catch(error) {stage.status='FAIL';stage.evidenceError=error.message;stage.failurePhase='EVIDENCE';}
      stage.finishedAt=new Date().toISOString();save();
      log('STAGE_RESULT '+JSON.stringify({id:stage.id,status:stage.status,reason:stage.reason,failurePhase:stage.failurePhase})+'\n');
    }
  } catch(error) {result.error=error.message;}
  finally {
    for(const stage of result.stages) if(stage.status==='RUNNING') {stage.status='FAIL';stage.reason='INTERRUPTED';}
    try {
      result.sourceAfter=readSource();
      result.candidateUnchanged=result.sourceAfter.head===source.head && result.sourceAfter.sourceSha256===source.sourceSha256;
      if(!result.candidateUnchanged) result.error='Source changed during verification';
    } catch(error) {result.error=error.message;}
    result.status=result.error || result.stages.some(s=>s.status==='FAIL')?'FAIL'
      :result.stages.some(s=>s.required && s.status!=='PASS')?'PARTIAL':'PASS';
    result.finishedAt=new Date().toISOString();log('\nVERIFICATION '+result.status+'\n');
    result.logBytes=fs.statSync(logPath).size;result.expectedLogBytes=bytes;
    if(result.logBytes!==bytes){result.status='FAIL';result.error='Incomplete verification log';}
    fs.copyFileSync(logPath,path.join(evidenceRoot,'output.log'));save();
  }
  return result;
}

```

### scripts/verification-plan.mjs

SHA-256: a79ed26cde9b4f13954e8d798de153b0c7cd01dfd350dabce96ccf2c93944766

```javascript
import {requiredGuiScenarios} from './verification-gui-contract.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {discoverTests} from './run-tests.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
// The same catalog drives local verification and CI. Explicit overlaps are
// retained: platform/cleanup are focused contracts as well as full discovery.
const stage = (id, command, options = {}) => ({id, command, required:true,
  node:'>=22.5', timeoutMs:25*60*1000, scopes:['full'], needs:['dependencies'], evidence:[], ...options});
export const verificationCatalog = [
  stage('dependencies', null, {args:['ci'],needs:[],phase:'PREPARATION'}),
  stage('browser-install', 'verify:browser-install', {receipt:'browser',
    phase:'PREPARATION',browser:true}),
  stage('lint','lint'), stage('architecture','architecture:check'), stage('types','typecheck'),
  stage('discovery','test',{receipt:'gate',evidencePaths:['latest-test.log','latest-agent-diagnostics-complete','latest-server-response-deadline','latest-server-responsiveness','latest-verification-lifecycle','latest-verification-command','latest-source-checkout']}),
  stage('integration','test:integration'),
  stage('platform','test:platform',{receipt:'gate'}),
  stage('cleanup','test:runtime-cleanup-contract',{receipt:'gate'}),
  stage('windows-focused',null,{os:['win32'],nodeArgs:['scripts/run-tests.mjs',
    'tests/persistence-cleanup.test.js','tests/verification-lifecycle.test.js','tests/preparation-contention.test.js'],receipt:'gate'}),
  stage('platform-browser','test:platform:browser',{browser:true,receipt:'gate'}),
  stage('e2e','test:e2e:ci',{browser:true,receipt:'e2e',evidencePaths:['ui-qa/e2e-startup','ui-qa/e2e-wave','ui-qa/startup-runner-failure.json','ui-qa/wave-runner-failure.json']}),
  stage('ui','test:ui',{browser:true,os:['linux'],evidencePaths:['ui-qa/failure.json']}),
  stage('browser','test:browser:core',{browser:true,os:['linux'],receipt:'gate'}),
  stage('tab-ux','test:tab-ux-browser',{browser:true,receipt:'gui',expectedScenarios:[...requiredGuiScenarios]}),
  stage('sabotage','test:sabotage',{browser:true,os:['linux']}),
  stage('native','test:extension:native',{browser:true,receipt:'native',evidencePaths:['native-reload-control']}),
  stage('minimum-dependencies',null,{args:['ci'],scopes:['minimum'],needs:[],phase:'PREPARATION'}),
  stage('minimum-sqlite',null,{scopes:['minimum'],needs:['minimum-dependencies'],nodeArgs:[
    '--experimental-sqlite','--test','tests/platform/sqlite-database.test.js','tests/platform/sqlite-startup.test.js']}),
];
export function verificationPlan({scope='full',platform=process.platform}={}) {
  if (!['full','minimum'].includes(scope)) throw Error('Unknown verification scope: '+scope);
  // #154 exhausted the discovery stage budget while completing files normally.
  // Split Windows discovery into bounded, sequential groups. File deadlines,
  // the complete test inventory and OS policy stay unchanged. Each group keeps
  // 25 minutes: their combined allowance grows from 25 to 100 minutes, while
  // the CI job still has 90 minutes. Actual Windows elapsed time needs measurement.
  const catalog=verificationCatalog.filter(item=>item.scopes.includes(scope)).flatMap(item=>{
    if(item.id!=='discovery' || platform!=='win32') return [item];
    const files=discoverTests(path.join(root,'tests')).map(file=>path.relative(root,file).split(path.sep).join('/'));
    const groups=Array.from({length:Math.min(4,files.length)},()=>[]);
    files.forEach((file,index)=>groups[index%groups.length].push(file));
    return groups.map((files,index)=>({...item,id:index===0?'discovery':`discovery-${index+1}`,
      command:null,nodeArgs:['scripts/run-tests.mjs',...files]}));
  });
  return catalog.map(item=>{
    const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
    const args=item.nodeArgs || (pkg.scripts[item.command] || '').split(/\s+/u);
    const gateIndex=args.findIndex(arg=>arg==='scripts/run-tests.mjs');
    const expectedFiles=item.receipt==='gate' ? (item.command==='test'
      ?discoverTests(path.join(root,'tests')).map(file=>path.relative(root,file).split(path.sep).join('/'))
      :args.slice(gateIndex+1)) : undefined;
    if(item.receipt==='gate' && item.command!=='test' && gateIndex<0) throw Error('UNRESOLVED_GATE_SCOPE: '+item.id);
    const expectedProfiles=item.receipt==='e2e'?JSON.parse(fs.readFileSync(path.join(root,'scripts/e2e/flows.json'),'utf8')).map(f=>f.id):undefined;
    const applicable=!item.os || item.os.includes(platform);
    return {...item,expectedFiles,expectedProfiles,evidencePaths:item.evidencePaths || (item.receipt==='gate'?['latest-test.log']:[]), needs:[...item.needs,...(item.browser && item.phase!=='PREPARATION'?['browser-install']:[])],
      required:applicable && item.required,status:'NOT_RUN',
      evidence:['output.log',...(item.receipt?['receipt.json']:[])],
      reason:applicable?'PENDING':'POLICY_EXCLUDED_OS',applicable};
  });
}

```

### scripts/verification-identity.mjs

SHA-256: 7685c3a136b71f2e5ffc158af97bf1754b1675105d5f1c4ff8a9b817b05126ee

```javascript
import {randomUUID} from 'node:crypto';
import {verificationSource} from './verification-source.mjs';
const compact=source=>({head:source.head,sourceSha256:source.sourceSha256});
export function beginVerificationIdentity(root) {
  return {verificationRunId:process.env.BRIDGE_VERIFICATION_RUN_ID || randomUUID(),source:compact(verificationSource(root))};
}
export function finishVerificationIdentity(root,identity) {
  const sourceAfter=compact(verificationSource(root));
  return {...identity,sourceAfter,candidateUnchanged:sourceAfter.head===identity.source.head
    && sourceAfter.sourceSha256===identity.source.sourceSha256};
}
export function identityMatches(receipt,{runId,source}) {
  return receipt?.verificationRunId===runId && receipt?.source?.head===source.head
    && receipt?.source?.sourceSha256===source.sourceSha256 && receipt?.candidateUnchanged===true
    && receipt?.sourceAfter?.head===source.head && receipt?.sourceAfter?.sourceSha256===source.sourceSha256;
}
export function sameUniqueMembers(actual,expected) {
  return Array.isArray(actual) && Array.isArray(expected) && expected.length>0
    && actual.every(item=>typeof item==='string') && expected.every(item=>typeof item==='string')
    && new Set(actual).size===actual.length && new Set(expected).size===expected.length
    && actual.length===expected.length && expected.every(item=>actual.includes(item));
}
export function resourceClosureUnconfirmed(receipt) {
  if(!receipt || typeof receipt!=='object') return false;
  if(receipt.cleanupError || receipt.cleanupFailure || receipt.receiptCleanupError || receipt.cleanupErrors?.length || receipt.closureConfirmed===false || receipt.forced===true
    || receipt.deadline===true && !receipt.closure) return true;
  return Object.entries(receipt).some(([key,value])=>!['source','sourceAfter','manifest'].includes(key)
    && value && typeof value==='object' && resourceClosureUnconfirmed(value));
}

```

### tests/helpers/progressive-io.mjs

SHA-256: c20b6e4e7cfc7bad3d4f115ef2033a23b7a99b925f36c23bae8bcffb1c51f5a5

```javascript
import { isDeepStrictEqual } from 'node:util';

// Diagnostic assertions for existing Node tests, not a separate execution engine.
// Each level consumes the EXACT output of the preceding level.
// A level is PASS only after checking at least one independent expected/actual field.
export async function runProgressiveIO(t, {feature, input, levels, depth = levels?.length}) {
  if (!feature || !Array.isArray(levels) || levels.length === 0 || levels.length > 10
    || !Number.isInteger(depth) || depth < 1 || depth > levels.length
    || levels.some(x => !x || !x.name || typeof x.process !== 'function'
      || typeof x.observe !== 'function' || !x.expected || Object.keys(x.expected).length === 0)) {
    throw new TypeError('PROGRESSIVE_IO_CONFIG_INVALID: 1..10 observable levels and valid depth are required');
  }
  const records = [];
  let current = input;
  const emit = entry => {
    const record = {feature, ...entry};
    records.push(record);
    t.diagnostic(`IO_DEPTH ${JSON.stringify(record)}`);
  };
  async function visit(index, value) {
    if (index === levels.length) return value;
    const level = levels[index];
    const number = index + 1;
    if (number > depth) {
      for (let later = index; later < levels.length; later++) {
        emit({depth:later+1, node:levels[later].name, status:'DEFERRED', reason:`selected depth=${depth}`});
      }
      return value;
    }
    let output, actual, inputActual, failure;
    const expectsInput = Object.hasOwn(level, 'expectedInput');
    try {
      if (expectsInput) {
        if (typeof level.observeInput !== 'function') throw new Error('expectedInput requires observeInput');
        inputActual = await level.observeInput(value);
        if (!isDeepStrictEqual(inputActual, level.expectedInput)) {
          const wrong = Object.entries(level.expectedInput)
            .filter(([key, expected]) => !isDeepStrictEqual(inputActual?.[key], expected))
            .map(([key, expected]) => ({field:`input.${key}`,expected,actual:inputActual?.[key]}));
          emit({depth:number,node:level.name,status:'FAIL',boundary:'INPUT',
            differences:wrong,expected:level.expectedInput,actual:inputActual});
          for (let later=index+1;later<levels.length;later++) {
            emit({depth:later+1,node:levels[later].name,status:'NOT_RUN',blockedBy:number});
          }
          throw Object.assign(new Error(`IO_DEPTH_FAILED ${feature} > ${number} ${level.name} input: ${JSON.stringify(wrong)}`),
            {ioBoundaryFailure:true});
        }
      }
      // process() is invoked exactly once. Its output is the child node's input.
      output = await level.process(value);
      actual = await level.observe(output, value);
      if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
        throw new Error('observe() must return a record of actual field values');
      }
    } catch (error) { if (error.ioBoundaryFailure) throw error; failure = error; }
    const differences = failure ? [] : Object.entries(level.expected)
      .filter(([field, expected]) => !isDeepStrictEqual(actual[field], expected))
      .map(([field, expected]) => ({field, expected, actual:actual[field]}));
    if (failure || differences.length) {
      emit({depth:number, node:level.name, status:'FAIL',
        ...(failure ? {reason:failure.message} : {}),
        differences, expected:level.expected, actual:actual ?? null});
      for (let later = index + 1; later < levels.length; later++) {
        emit({depth:later+1, node:levels[later].name, status:'NOT_RUN', blockedBy:number});
      }
      const mismatch = differences.map(x => `${x.field}: expected=${JSON.stringify(x.expected)}, actual=${JSON.stringify(x.actual)}`).join('; ');
      throw new Error(`IO_DEPTH_FAILED ${feature} > ${number} ${level.name}: ${mismatch || failure.message}`, {cause:failure});
    }
    emit({depth:number, node:level.name, status:'PASS',
      ...(expectsInput ? {input:{expected:level.expectedInput,actual:inputActual}} : {}),
      output:{expected:level.expected,actual}});
    return visit(index+1, output);
  }
  current = await visit(0, current);
  emit({status:depth === levels.length ? 'COMPLETE' : 'PARTIAL', depth, total:levels.length});
  return {output:current, records};
}

```

### tests/public/progressive-io.test.js

SHA-256: 8c71103a579786dc6fd41b8042512487e7c7eb29deaf9ab0d92f23900edd76a3

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import {runProgressiveIO} from '../helpers/progressive-io.mjs';
import {normalizeDashboardState, buildCommandEnvelope} from '../../public/dashboard-model.js';

const fixture = () => ({
  workflow:{stage:'WORK',state:'WORKER_RUNNING',runId:'A',runVersion:3},
  run:{runId:'A',version:3,phase:'WORKER_RUNNING',objective:'작업 A'},
  runs:[{runId:'A',phase:'WORKER_RUNNING',objective:'작업 A'}],
  commandCapabilities:['run.stop'],
});

function exampleLevels() {
  // Real production normalizer and command builder; intermediate steps are observable projections.
  const levels = [
    {name:'사용자 입력',process:async x => ({selected:x.selected, raw:x.raw}),
      expected:{selected:'A'},observe:o=>({selected:o.selected})},
    {name:'조회 대상',process:async x => ({...x, request:{runId:x.selected}}),
      expected:{runId:'A'},observe:o=>({runId:o.request.runId})},
    {name:'응답 본문',process:async x => ({...x, payload:structuredClone(x.raw)}),
      expected:{runId:'A',version:3},observe:o=>({runId:o.payload.run.runId,version:o.payload.run.version})},
    {name:'응답 스키마',process:async x => ({...x, canonical:normalizeDashboardState(x.payload,x.request.runId)}),
      expected:{runId:'A'},observe:o=>({runId:o.canonical.run.runId})},
    {name:'작업 상태',process:async x => ({...x, run:oRun(x.canonical)}),
      expected:{phase:'WORKER_RUNNING'},observe:o=>({phase:o.run.phase})},
    {name:'작업 버전',process:async x => ({...x, version:x.run.version}),
      expected:{version:3},observe:o=>({version:o.version})},
    {name:'워크플로 연결',process:async x => ({...x, workflow:x.canonical.workflow}),
      expected:{runId:'A',version:3},observe:o=>({runId:o.workflow.runId,version:o.workflow.runVersion})},
    {name:'기능 권한',process:async x => ({...x, canStop:x.canonical.commandCapabilities.has('run.stop')}),
      expected:{canStop:true},observe:o=>({canStop:o.canStop})},
    {name:'명령 생성',process:async x => ({...x, command:buildCommandEnvelope({type:'run.stop',requestId:'req-1',run:x.run})}),
      expected:{command:'run.stop'},observe:o=>({command:o.command.type})},
    {name:'출력 대상',process:async x => ({...x, sent:x.command.payload}),
      expected:{runId:'A',version:3},observe:o=>({runId:o.sent.runId,version:o.sent.expectedVersion})},
  ];
  return levels;
}
const oRun = canonical => canonical.run;

for (let depth = 1; depth <= 10; depth++) {
  test(`progressive model-to-command IO depth ${depth}/10`, async t => {
    const {records} = await runProgressiveIO(t,{feature:'Dashboard 모델→명령',input:{selected:'A',raw:fixture()},levels:exampleLevels(),depth});
    assert.equal(records.filter(x=>x.status==='PASS').length,depth);
    assert.equal(records.at(-1).status,depth===10?'COMPLETE':'PARTIAL');
    assert.equal(records.filter(x=>x.status==='DEFERRED').length,10-depth);
  });
}

test('depth 10 detects incorrect identity at the raw-payload boundary', async t => {
  const bad=fixture();bad.run.runId='B';bad.workflow.runId='B';
  await assert.rejects(runProgressiveIO(t,{feature:'wrong-id',input:{selected:'A',raw:bad},levels:exampleLevels(),depth:10}),
    /IO_DEPTH_FAILED wrong-id > 3 응답 본문/);
});

test('render-like output mismatch blocks downstream side effects', async t => {
  let mutations=0;
  const levels=[
    {name:'fetch',process:async()=>({status:'WORKER_RUNNING'}),observe:o=>o,expected:{status:'WORKER_RUNNING'}},
    {name:'render',process:async()=>({text:'대기 중'}),observe:o=>o,expected:{text:'구현·수정 중'}},
    {name:'command',process:async x=>{mutations++;return x;},observe:o=>o,expected:{text:'구현·수정 중'}},
  ];
  await assert.rejects(runProgressiveIO(t,{feature:'render-failure',input:{},levels,depth:3}),
    /IO_DEPTH_FAILED render-failure > 2 render/);
  assert.equal(mutations,0);
});

test('exception from process fails closed and preserves the first failing depth', async t => {
  await assert.rejects(runProgressiveIO(t,{feature:'throws',input:1,depth:2,levels:[
    {name:'one',process:x=>x+1,observe:o=>({value:o}),expected:{value:2}},
    {name:'two',process:()=>{throw new Error('network failed');},observe:o=>({value:o}),expected:{value:3}},
    {name:'three',process:x=>x+1,observe:o=>({value:o}),expected:{value:4}},
  ]}), /IO_DEPTH_FAILED throws > 2 two: network failed/);
});

test('a missing observation is never counted PASS', async t => {
  await assert.rejects(runProgressiveIO(t,{feature:'unobservable',input:1,levels:[
    {name:'opaque',process:x=>x,observe:()=>({}),expected:{actualStatus:'OK'}},
  ]}),/actualStatus/);
});

test('nested process receives its parent output and executes exactly once', async t => {
  const executions = [];
  const input = Object.freeze({token:2});
  const one = Object.freeze({token:3});
  const two = Object.freeze({token:6});
  const result = await runProgressiveIO(t,{feature:'lineage',input,depth:2,levels:[
    {name:'parent',process:actual=>{assert.strictEqual(actual,input);executions.push('parent');return one;},
      observe:o=>({token:o.token}),expected:{token:3}},
    {name:'child',process:actual=>{assert.strictEqual(actual,one);executions.push('child');return two;},
      observe:o=>({token:o.token}),expected:{token:6}},
  ]});
  assert.strictEqual(result.output,two);
  assert.deepEqual(executions,['parent','child']);
});

test('partial depths never execute deferred mutation', async t => {
  let mutations=0;
  const result=await runProgressiveIO(t,{feature:'partial',input:1,depth:1,levels:[
    {name:'read',process:i=>i+1,observe:o=>({output:o}),expected:{output:2}},
    {name:'mutation',process:i=>{mutations++;return i+1;},observe:o=>({output:o}),expected:{output:3}},
  ]});
  assert.equal(mutations,0);
  assert.equal(result.records.at(-1).status,'PARTIAL');
  assert.equal(result.records[1].status,'DEFERRED');
});

test('misconfigured stage with no expected observable field is rejected before execution', async t => {
  let executed=false;
  await assert.rejects(runProgressiveIO(t,{feature:'bad-contract',input:1,levels:[
    {name:'empty',process:()=>{executed=true;return 1;},observe:o=>o,expected:{}},
  ]}),/PROGRESSIVE_IO_CONFIG_INVALID/);
  assert.equal(executed,false);
});

test('wrong child input fails at INPUT boundary before process execution', async t => {
  let called=false;
  const levels=[
    {name:'parent',process:i=>({value:i.value+1}),observe:o=>o,expected:{value:2}},
    {name:'child',expectedInput:{value:4},observeInput:i=>({value:i.value}),
      process:i=>{called=true;return i;},observe:o=>o,expected:{value:2}},
  ];
  await assert.rejects(runProgressiveIO(t,{feature:'bad-input',input:{value:1},levels,depth:2}),
    /IO_DEPTH_FAILED bad-input > 2 child input/);
  assert.equal(called,false);
});

```

### tests/public/dashboard-io-depth.test.js

SHA-256: f42d336cebb998ef98392e7c626dbaa6dc2c8411ce56d848319e61c2e43b537a

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import {runProgressiveIO} from '../helpers/progressive-io.mjs';
import {dashboard} from '../helpers/dashboard-ui.mjs';

// Progressive I/O observations of the existing Dashboard; not a claim that
// every private function in app.js has been instrumented.
// IO_DEPTH=1..10 runs a single depth. No variable means the full 10-depth path.
const requestedDepth = process.env.IO_DEPTH == null ? 10 : Number(process.env.IO_DEPTH);
if (!Number.isInteger(requestedDepth) || requestedDepth < 1 || requestedDepth > 10) {
  throw new TypeError('IO_DEPTH must be an integer from 1 to 10');
}
const rawState = () => {
  const run = {id:'A',status:'WORKER_RUNNING',version:3,objective:'작업 A'};
  return {
    workflow:{stage:'WORK',state:'WORKER_RUNNING',runId:'A',runVersion:3},
    run, runs:[{runId:'A',phase:'WORKER_RUNNING',version:3,objective:'작업 A'}],
    commandCapabilities:['run.stop'],
    dataKnowledge:{runs:{status:'AVAILABLE_NONEMPTY'}},
  };
};

function levels() {
  const chain = [
    { name:'01 입력 runId', process:async x=>({...x,target:x.selected}),
      observe:o=>({runId:o.target}),expected:{runId:'A'} },
    { name:'02 Dashboard 실행', process:async x=>({...x,ui:await dashboard(x.raw)}),
      observe:o=>({hasDashboard:Boolean(o.ui?.elements && o.ui?.calls)}),expected:{hasDashboard:true} },
    { name:'03 세션 요청', process:async x=>({...x,sessionRequest:x.ui.calls.find(c=>c.url==='/api/dashboard/session')}),
      observe:o=>({path:o.sessionRequest?.url??null}),expected:{path:'/api/dashboard/session'} },
    { name:'04 상태 요청', process:async x=>({...x,stateRequest:x.ui.calls.find(c=>c.url.startsWith('/api/state'))}),
      observe:o=>({path:o.stateRequest?.url??null}),expected:{path:'/api/state'} },
    { name:'05 원본 데이터 로드', process:async x=>({...x,rawRunId:x.raw.run.id,rawVersion:x.raw.run.version}),
      observe:o=>({runId:o.rawRunId,version:o.rawVersion}),expected:{runId:'A',version:3} },
    { name:'06 정규화 결과', process:async x=>({...x,normalized:{
      runId:x.ui.run('snapshot.run.runId'),phase:x.ui.run('snapshot.run.phase'),version:x.ui.run('snapshot.run.version'),
    }}),observe:o=>o.normalized,expected:{runId:'A',phase:'WORKER_RUNNING',version:3} },
    { name:'07 워크플로 대상', process:async x=>({...x,owner:{
      runId:x.ui.run('workflow.runId'),version:x.ui.run('workflow.runVersion'),
    }}),observe:o=>o.owner,expected:{runId:'A',version:3} },
    { name:'08 화면 렌더링', process:async x=>({...x,view:{
      title:x.ui.elements.get('runObjective').textContent,
      status:x.ui.elements.get('runStatus').textContent,
    }}),observe:o=>o.view,expected:{title:'작업 A',status:'구현·수정 중'} },
    { name:'09 화면 대상 및 조작 가능', process:async x=>({...x,controls:{
      runId:x.ui.elements.get('runPanel').dataset.runId,
      stopEnabled:!x.ui.elements.get('stopRun').disabled,
    }}),observe:o=>o.controls,expected:{runId:'A',stopEnabled:true} },
    { name:'10 실제 명령 출력', process:async x=>{
      const before=x.ui.calls.filter(c=>c.url==='/api/commands').length;
      await x.ui.run('command("run.stop")');
      const commands=x.ui.calls.filter(c=>c.url==='/api/commands');
      const command=commands.at(-1)?.body;
      return {...x,submission:{count:commands.length-before,type:command?.type??null,
        runId:command?.payload?.runId??null,version:command?.payload?.expectedVersion??null}};
    },observe:o=>o.submission,
    expected:{count:1,type:'run.stop',runId:'A',version:3} },
  ];
  // A node's INPUT is the exact prior node's OUTPUT projection, not another fixture.
  return chain.map((node,index)=>({
    ...node,
    expectedInput:index===0?{selected:'A'}:chain[index-1].expected,
    observeInput:index===0?(value=>({selected:value.selected})):chain[index-1].observe,
  }));
}

test(`Dashboard Input→Process→Output progressive depth ${requestedDepth}/10`, async t => {
  const state = rawState();
  const result = await runProgressiveIO(t,{feature:'Dashboard 상태 로드→실제 DOM→명령',
    input:{selected:'A',raw:state},levels:levels(),depth:requestedDepth});
  assert.equal(result.records.filter(x=>x.status==='PASS').length,requestedDepth);
  assert.equal(result.records.at(-1).status,requestedDepth===10?'COMPLETE':'PARTIAL');
});

test('injected DOM corruption is detected at depth 08 and cannot reach command', async t => {
  const actualLevels=levels();
  let ui;
  const normalRender=actualLevels[7].process;
  actualLevels[7]={...actualLevels[7],process:async input=>{
    ui=input.ui;
    input.ui.elements.get('runStatus').textContent='대기 중';
    return normalRender(input);
  }};
  await assert.rejects(runProgressiveIO(t,{feature:'Dashboard DOM fault',
    input:{selected:'A',raw:rawState()},levels:actualLevels,depth:10}),
    /IO_DEPTH_FAILED Dashboard DOM fault > 8/);
  assert.ok(ui);
  assert.equal(ui.calls.filter(x=>x.url==='/api/commands').length,0);
});

```

### tests/helpers/dashboard-ui.mjs

SHA-256: c54c1bd5f21e76415610756694ae2083b1daad1f74fcf0e58b23e522f1ad0af5

```javascript
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as dashboardActionCapabilities from "../../public/dashboard-action-capabilities.js";
import * as dashboardConnectionState from "../../public/dashboard-connection-state.js";
import { externalEventRecords, filterRunsForHistory, groupRunsByProject, normalizeDashboardState } from "../../public/dashboard-model.js";
import * as dashboardRunListKnowledge from "../../public/dashboard-run-list-knowledge.js";
import * as dashboardStartActions from "../../public/dashboard-start-actions.js";
import { renderProjectOverview } from "../../public/project-overview-view.js";
import { createRunActionLayout } from "../../public/run-action-layout.js";
import * as runContextView from "../../public/run-context-view.js";

function inlineModule(source) {
  const lines = [];
  let importing = false;
  for (const line of source.split(/\r?\n/u)) {
    if (!importing && /^\s*import\b/u.test(line)) {
      importing = !/;\s*$/u.test(line);
      continue;
    }
    if (importing) {
      if (/;\s*$/u.test(line)) importing = false;
      continue;
    }
    if (/^\s*export\s*\{/u.test(line)) continue;
    lines.push(line.replace(/^(\s*)export\s+/u, "$1"));
  }
  return lines.join("\n");
}

function withRunKnowledge(state) {
  if (!Array.isArray(state?.runs) || state.dataKnowledge != null) return state;
  return {
    ...state,
    dataKnowledge: { runs: { status: state.runs.length ? "AVAILABLE_NONEMPTY" : "AVAILABLE_EMPTY" } },
  };
}

export async function dashboard(state, mutate = async () => ({}), storage = new Map()) {
  const html = await readFile(new URL("../../public/index.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../../public/app.js", import.meta.url), "utf8");
  const conversationSource = await readFile(new URL("../../public/conversation-view.js", import.meta.url), "utf8");
  const preparationSource = await readFile(new URL("../../public/preparation-view.js", import.meta.url), "utf8");
  const healthPresentationSource = await readFile(new URL("../../public/dashboard-health-presentation.js", import.meta.url), "utf8");
  const auditPresentationSource = await readFile(new URL("../../public/dashboard-audit-presentation.js", import.meta.url), "utf8");
  const statusSource = await readFile(new URL("../../public/dashboard-status-view.js", import.meta.url), "utf8");
  const elements = new Map(), all = [], calls = [];
  class Element {
    constructor(tagName = "") {
      this.tagName = String(tagName).toUpperCase();
      this.children = []; this.listeners = {}; this.dataset = {}; this.value = "";
      this.checked = false; this.hidden = false; this.textContent = ""; this.attributes = {};
      this.classList = {
        add: (...names) => { for (const name of names) this.className = `${this.className ?? ""} ${name}`.trim(); },
        remove: (...names) => { this.className = String(this.className ?? "").split(/\s+/u).filter((name) => !names.includes(name)).join(" "); },
        contains: (name) => String(this.className ?? "").split(/\s+/u).includes(name),
        toggle: (name, force) => {
          const included = force === undefined ? !this.classList.contains(name) : Boolean(force);
          this.classList[included ? "add" : "remove"](name);
          return included;
        },
      };
      all.push(this);
    }
    set id(value) { this._id = value; elements.set(value, this); }
    get id() { return this._id; }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    prepend(child) { if (!this.children.includes(child)) this.children.unshift(child); child.parentElement = this; }
    after(...siblings) {
      const parent = this.parentElement;
      if (!parent) return;
      const index = parent.children.indexOf(this);
      parent.children.splice(index + 1, 0, ...siblings);
      for (const sibling of siblings) sibling.parentElement = parent;
    }
    get nextElementSibling() {
      if (!this.parentElement) return null;
      const index = this.parentElement.children.indexOf(this);
      return this.parentElement.children[index + 1] ?? null;
    }
    querySelectorAll(selector) {
      const descendants = [];
      const visit = (element) => {
        for (const child of element.children) {
          if (selector.split(",").map(item => item.toUpperCase()).includes(child.tagName)) descendants.push(child);
          visit(child);
        }
      };
      visit(this);
      return descendants;
    }
    querySelector(selector) {
      if (selector === "a[data-delivery-recovery]") return this.querySelectorAll("a")
        .find(element => Object.hasOwn(element.dataset, "deliveryRecovery")) ?? null;
      return this.querySelectorAll(selector)[0] ?? null;
    }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
      this.parentElement = null;
    }
    focus() {}
    replaceChildren(...children) { this.children = []; this.append(...children); }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(key, callback) { this.listeners[key] = callback; }
    removeEventListener(key, callback) { if (this.listeners[key] === callback) delete this.listeners[key]; }
    contains() { return false; }
  }
  for (const match of html.matchAll(/id="([^"]+)"/g)) { const element = new Element(); element.id = match[1]; }
  const context = vm.createContext({ location:{search:""},
    ...dashboardActionCapabilities,
    ...dashboardConnectionState,
    ...dashboardRunListKnowledge,
    ...dashboardStartActions,
    ...runContextView,
    externalEventRecords, filterRunsForHistory, groupRunsByProject, normalizeDashboardState, renderProjectOverview, createRunActionLayout, Date, Map, Set, JSON, URL, URLSearchParams, Blob,
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    crypto: { randomUUID: () => "request-1" },
    AbortSignal: { timeout: () => undefined }, setTimeout: () => {},
    window: { location: { origin:"http://127.0.0.1:8787", reload:() => {} } },
    document: {
      getElementById: (id) => elements.get(id),
      createElement: (tagName) => new Element(tagName), addEventListener() {},
      querySelectorAll: () => all.filter((element) => element.dataset.webCommand),
      querySelector: (selector) => [".session-recovery", ".preparation-tab-choice"].includes(selector)
        ? all.findLast(element => element.className === selector.slice(1)) ?? null : null,
    },
    fetch: async (url, options) => {
      calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
      const body = url === "/api/dashboard/session" ? { token: "test" }
        : url.startsWith("/api/state") ? withRunKnowledge(state) : await mutate(url, options);
      return { ok: true, json: async () => body };
    },
  });
  const tabChoiceSource = await readFile(new URL("../../public/preparation-tab-choice.js", import.meta.url), "utf8");
  const executableSource = [
    inlineModule(tabChoiceSource),
    inlineModule(conversationSource),
    inlineModule(preparationSource),
    inlineModule(healthPresentationSource),
    inlineModule(auditPresentationSource),
    inlineModule(statusSource),
    inlineModule(source).replace(/\r?\n(?:void\s+)?poll\(\);\s*$/, ""),
  ].join("\n");
  vm.runInContext(executableSource, context);
  await vm.runInContext("refresh()", context);
  return { elements, calls, context, run: (code) => vm.runInContext(code, context) };
}

```
