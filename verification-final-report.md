# 후보 E 최종 통합 검증 보고서

작성일: 2026-11-04 (Asia/Seoul). 종료 조건 **B: 명확한 차단·변경 승인 필요**. 이번 작업의 신규 테스트·Gate 실행은 0회다. 후보 코드·기존 영수증을 수정하지 않았다.

## ① 전체 현황

| 항목 | 전체 | PASS | FAIL | 미실행/차단 |
|---|---:|---:|---:|---:|
| Ubuntu Full | 17 | 6 | 1 | 10 차단 |
| Windows Full | 19 | 0 | 0 | 19 미실행 |
| Minimum | 2 | 0 | 0 | 2 미실행 |
| **합계** | **38** | **6** | **1** | **31** |

- 현재 검증 대상 source SHA-256: `e33b7d3102b483052bb6ec85dc9fea2cdec9309bfde8afd3d675e7e311890200`
- 기준 Git HEAD: `5ac8d982ec37e1ccf17334281b786214b375fd9a`
- 후보 변경 경로: **25개**(Git status 기준 tracked 16, untracked 9; 줄바꿈 차이 포함). manifest 626개 파일. 별도 작업 폴더 HEAD `0791a19fe8b21274698784a404ac7bb5545ddc6e`는 대상 후보가 아니다.
- 원격 CI: **후보 E UNKNOWN**. 기본 커밋 [Actions #188](https://github.com/jaehoon6523/app-web-agent-bridge/actions/runs/41591417981)은 PASS지만 미커밋 후보로 승계하지 않는다.
- E2E 28개 프로필: 후보 E **0 PASS / 0 FAIL / 28 NOT_RUN**.
- 실제 사용자 흐름 완주: **미검증**. 최종 수용: **불가·보류**.
- OS 정책 제외는 Ubuntu 1개·Windows 3개이며 위 필수 분모에서 제외했다. 38은 OS×단계 및 minimum의 합이며 Node별 CI job 실행 수가 아니다.

## ② 공식 Gate 단계별 현황

시간 표기의 `벽차`는 시작·종료 ISO 시각 차이일 뿐이다. 시각 역행이 관찰되어 **실제 단계 경과 시간은 UNKNOWN**이다. PASS 여부는 시간 추정이 아니라 원본 영수증의 상태·종료·소스 귀속에 따른다. NOT_RUN은 후보 E 실행 영수증 없음, BLOCKED는 원본에 차단 사유가 있는 경우다.

| OS/범위 | 단계 ID | 상태 | 소요 시간 | 실패 원인·차단 이유 | 증거 파일 |
|---|---|---|---|---|---|
| Ubuntu/full | `dependencies` | PASS | UNKNOWN (벽차 10.851초) | — | [공식 영수증](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/ubuntu-e33b-env-gate/official-result.json>) |
| Ubuntu/full | `browser-install` | PASS | UNKNOWN (벽차 15.798초) | — | [공식 영수증](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/ubuntu-e33b-env-gate/official-result.json>) |
| Ubuntu/full | `lint` | PASS | UNKNOWN (벽차 1.688초) | — | [공식 영수증](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/ubuntu-e33b-env-gate/official-result.json>) |
| Ubuntu/full | `architecture` | PASS | UNKNOWN (벽차 1.195초) | — | [공식 영수증](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/ubuntu-e33b-env-gate/official-result.json>) |
| Ubuntu/full | `types` | PASS | UNKNOWN (벽차 3.191초) | — | [공식 영수증](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/ubuntu-e33b-env-gate/official-result.json>) |
| Ubuntu/full | `spec` | PASS | UNKNOWN (벽차 94.928초) | — | [공식 영수증](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/ubuntu-e33b-env-gate/official-result.json>) |
| Ubuntu/full | `discovery` | FAIL | UNKNOWN (벽차 1394.761초) | E2E runner resource closure failed: execution deadline | [공식 영수증](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/ubuntu-e33b-env-gate/official-result.json>) |
| Ubuntu/full | `integration` | BLOCKED | UNKNOWN | RESOURCE_CLOSURE_UNCONFIRMED | [공식 영수증](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/ubuntu-e33b-env-gate/official-result.json>) |
| Ubuntu/full | `platform` | BLOCKED | UNKNOWN | RESOURCE_CLOSURE_UNCONFIRMED | [공식 영수증](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/ubuntu-e33b-env-gate/official-result.json>) |
| Ubuntu/full | `cleanup` | BLOCKED | UNKNOWN | RESOURCE_CLOSURE_UNCONFIRMED | [공식 영수증](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/ubuntu-e33b-env-gate/official-result.json>) |
| Ubuntu/full | `windows-focused` | POLICY_EXCLUDED | UNKNOWN | POLICY_EXCLUDED_OS | [공식 영수증](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/ubuntu-e33b-env-gate/official-result.json>) |
| Ubuntu/full | `platform-browser` | BLOCKED | UNKNOWN | RESOURCE_CLOSURE_UNCONFIRMED | [공식 영수증](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/ubuntu-e33b-env-gate/official-result.json>) |
| Ubuntu/full | `e2e` | BLOCKED | UNKNOWN | RESOURCE_CLOSURE_UNCONFIRMED | [공식 영수증](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/ubuntu-e33b-env-gate/official-result.json>) |
| Ubuntu/full | `ui` | BLOCKED | UNKNOWN | RESOURCE_CLOSURE_UNCONFIRMED | [공식 영수증](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/ubuntu-e33b-env-gate/official-result.json>) |
| Ubuntu/full | `browser` | BLOCKED | UNKNOWN | RESOURCE_CLOSURE_UNCONFIRMED | [공식 영수증](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/ubuntu-e33b-env-gate/official-result.json>) |
| Ubuntu/full | `tab-ux` | BLOCKED | UNKNOWN | RESOURCE_CLOSURE_UNCONFIRMED | [공식 영수증](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/ubuntu-e33b-env-gate/official-result.json>) |
| Ubuntu/full | `sabotage` | BLOCKED | UNKNOWN | RESOURCE_CLOSURE_UNCONFIRMED | [공식 영수증](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/ubuntu-e33b-env-gate/official-result.json>) |
| Ubuntu/full | `native` | BLOCKED | UNKNOWN | RESOURCE_CLOSURE_UNCONFIRMED | [공식 영수증](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/ubuntu-e33b-env-gate/official-result.json>) |
| Windows/full | `dependencies` | NOT_RUN | UNKNOWN | 후보 E 공식 실행 영수증 없음 | [후보 계획](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/checkout/scripts/verification-plan.mjs>) |
| Windows/full | `browser-install` | NOT_RUN | UNKNOWN | 후보 E 공식 실행 영수증 없음 | [후보 계획](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/checkout/scripts/verification-plan.mjs>) |
| Windows/full | `lint` | NOT_RUN | UNKNOWN | 후보 E 공식 실행 영수증 없음 | [후보 계획](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/checkout/scripts/verification-plan.mjs>) |
| Windows/full | `architecture` | NOT_RUN | UNKNOWN | 후보 E 공식 실행 영수증 없음 | [후보 계획](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/checkout/scripts/verification-plan.mjs>) |
| Windows/full | `types` | NOT_RUN | UNKNOWN | 후보 E 공식 실행 영수증 없음 | [후보 계획](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/checkout/scripts/verification-plan.mjs>) |
| Windows/full | `spec` | NOT_RUN | UNKNOWN | 후보 E 공식 실행 영수증 없음 | [후보 계획](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/checkout/scripts/verification-plan.mjs>) |
| Windows/full | `discovery-serial` | NOT_RUN | UNKNOWN | 후보 E 공식 실행 영수증 없음 | [후보 계획](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/checkout/scripts/verification-plan.mjs>) |
| Windows/full | `discovery` | NOT_RUN | UNKNOWN | 후보 E 공식 실행 영수증 없음 | [후보 계획](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/checkout/scripts/verification-plan.mjs>) |
| Windows/full | `discovery-2` | NOT_RUN | UNKNOWN | 후보 E 공식 실행 영수증 없음 | [후보 계획](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/checkout/scripts/verification-plan.mjs>) |
| Windows/full | `discovery-3` | NOT_RUN | UNKNOWN | 후보 E 공식 실행 영수증 없음 | [후보 계획](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/checkout/scripts/verification-plan.mjs>) |
| Windows/full | `discovery-4` | NOT_RUN | UNKNOWN | 후보 E 공식 실행 영수증 없음 | [후보 계획](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/checkout/scripts/verification-plan.mjs>) |
| Windows/full | `integration` | NOT_RUN | UNKNOWN | 후보 E 공식 실행 영수증 없음 | [후보 계획](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/checkout/scripts/verification-plan.mjs>) |
| Windows/full | `platform` | NOT_RUN | UNKNOWN | 후보 E 공식 실행 영수증 없음 | [후보 계획](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/checkout/scripts/verification-plan.mjs>) |
| Windows/full | `cleanup` | NOT_RUN | UNKNOWN | 후보 E 공식 실행 영수증 없음 | [후보 계획](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/checkout/scripts/verification-plan.mjs>) |
| Windows/full | `windows-focused` | NOT_RUN | UNKNOWN | 후보 E 공식 실행 영수증 없음 | [후보 계획](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/checkout/scripts/verification-plan.mjs>) |
| Windows/full | `platform-browser` | NOT_RUN | UNKNOWN | 후보 E 공식 실행 영수증 없음 | [후보 계획](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/checkout/scripts/verification-plan.mjs>) |
| Windows/full | `e2e` | NOT_RUN | UNKNOWN | 후보 E 공식 실행 영수증 없음 | [후보 계획](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/checkout/scripts/verification-plan.mjs>) |
| Windows/full | `ui` | POLICY_EXCLUDED | UNKNOWN | POLICY_EXCLUDED_OS | [후보 계획](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/checkout/scripts/verification-plan.mjs>) |
| Windows/full | `browser` | POLICY_EXCLUDED | UNKNOWN | POLICY_EXCLUDED_OS | [후보 계획](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/checkout/scripts/verification-plan.mjs>) |
| Windows/full | `tab-ux` | NOT_RUN | UNKNOWN | 후보 E 공식 실행 영수증 없음 | [후보 계획](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/checkout/scripts/verification-plan.mjs>) |
| Windows/full | `sabotage` | POLICY_EXCLUDED | UNKNOWN | POLICY_EXCLUDED_OS | [후보 계획](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/checkout/scripts/verification-plan.mjs>) |
| Windows/full | `native` | NOT_RUN | UNKNOWN | 후보 E 공식 실행 영수증 없음 | [후보 계획](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/checkout/scripts/verification-plan.mjs>) |
| Ubuntu/minimum | `minimum-dependencies` | NOT_RUN | UNKNOWN | 후보 E 실행 영수증 없음 | [후보 계획](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/checkout/scripts/verification-plan.mjs>) |
| Ubuntu/minimum | `minimum-sqlite` | NOT_RUN | UNKNOWN | 후보 E 실행 영수증 없음 | [후보 계획](<C:/Users/cjh/_gemini/test/new_neo/app-web-agent-bridge/.agent-controller/m1-http-four-contracts/checkout/scripts/verification-plan.mjs>) |

실행된 Ubuntu 단계는 모두 후보 E이며 Gate sourceAfter도 동일하다. 미실행에는 실행 당시 source를 부여하지 않았다. catalog full 18개 ID를 Windows에서 discovery-serial+4그룹으로 확장하여 계획 22행·필수 19행이다. minimum은 별도 2개다. Discovery와 integration(10개 파일), platform(24개 파일), cleanup(2개 파일)의 중복 실행은 의도된 공식 단계이며 대체 PASS로 합치지 않는다. spec은 2개 파일·16개 경계 관찰이고 E2E는 28개 프로필이다.

## ③ Discovery 상세 결과

- 기존 실행: `8c5892f0-d64b-468c-bd41-8421c9cfb161`, 예정 **201개**, 완료·PASS **158개**, 완료된 실패 **0개**, 완료 증거 없음 **43개**. 단계 자체는 **FAIL**이다.
- 단계 제한 **1,500,000ms(25분)**. 파일 기본 제한 **180,000ms**. 기존 예외 300,000/720,000/240,000/720,000ms도 그대로 유지되어 있으며 모든 파일이 180초인 것은 아니다.
- 158개 파일마다 최상위 TAP `# duration_ms`가 정확히 1개 있고 합계는 **1462360.437055ms = 24분 22.360초**다. 이는 Node TAP 실행기 측정값의 합이며, 프로세스 기동·종료·영수증 처리·다음 파일 준비 비용은 포함하지 않는다. 완전한 단계 단조 시간은 **UNKNOWN**이다.
- 25분과 이 합계의 차이는 **37639.562945ms = 37.640초**다. 비용 제외 상태에서도 예산에 매우 근접하지만 누락된 비용을 추정하여 누적만이 유일한 원인이라고 단정하지 않는다.
- 마지막 정상 완료: `tests/selector-repair-cli.test.js`, TAP 45,943.931311ms, PID 13826, exit 0/signal null.
- 다음 FILE 기록: `tests/selector-repair.test.js`. 이 파일의 당시 PID·준비 완료·TAP·exit/close는 **UNKNOWN**이다.
- 공식 오류: `E2E runner resource closure failed: execution deadline`. 내부 영수증은 RUNNING, terminal false, finishedAt 없음. supervisor PID 764, discovery PID 2269. 강제 종료 뒤 자원 회수는 UNKNOWN.
- 단계 ISO 시각 차이 1,394,761ms는 실제 경과 시간이 아니다. 자원 1,615개 샘플에 반복적인 시각 역행이 있어 25분 미만처럼 보이는 차이로 원인을 추정하지 않는다. 최소 가용 메모리 2,636,845,056바이트·디스크 1,019,883,405,312바이트이며 고갈을 입증하지 않는다. CPU·OOM·프로세스별 자원은 UNKNOWN.

**분류: `RUNNER_OR_CLOSURE_BOUNDARY`. 근본 원인: `UNKNOWN`.** 일반 runOwnedNode catch는 프로세스 그룹 SIGKILL 요청 후 실제 close를 기다리지 않고 pipe를 파기한다. native 전용 경로에는 1000ms 유한 close 관측이 있으나 이 실행은 그 경로가 아니다. 누적 예산 소진은 강한 설명 후보이고, 개별 파일 비정상 정지는 입증되지 않았다. 종료 실패를 실제 누수 발생으로 단정하지 않는다.

단독 selector 검증(이전 승인 1회): **20/20 PASS**, TAP 16,415.087214ms. 테스트 PID 658의 closure code 0/signal null, 실행기 PID 648 exit·close 모두 code 0/signal null; close 단조 시간 17,537.937105ms. terminal true·전후 E 동일·lease 해제·임시 폴더 제거 확인. 이 결과를 기존 158개 실행 영수증에 합쳐 159개 완료로 바꾸지 않으며 공식 단계 PASS로 올리지 않는다. 이번에는 재실행하지 않았다.

원본 위치:

- `/var/tmp/bridge-e33b-env-gate-wfF27e/evidence/verification-runs/8c5892f0-d64b-468c-bd41-8421c9cfb161/discovery/latest-test-result.json`
- `/var/tmp/bridge-e33b-env-gate-wfF27e/evidence/verification-runs/8c5892f0-d64b-468c-bd41-8421c9cfb161/resource-diagnostics/resources.jsonl`
- `/var/tmp/bridge-e33b-env-gate-wfF27e/evidence/verification-runs/8c5892f0-d64b-468c-bd41-8421c9cfb161/resource-diagnostics/stages.jsonl`
- `/var/tmp/bridge-e33b-env-gate-wfF27e/checkout/.agent-controller/selector-single-approved-20261104-01/latest-test-result.json`
- `/var/tmp/bridge-e33b-env-gate-wfF27e/checkout/.agent-controller/selector-single-approved-20261104-01/process-proof.json`

Windows에서 원본은 `\\wsl.localhost\Ubuntu` 하위 경로로 열 수 있다.

### 단계 B: 기존 옵션 검토와 승인용 최소 변경안

`--discovery-concurrency=2/4`는 현재 Linux의 단일·비병렬 Discovery를 분할하지 않으므로 해결 옵션이 아니다. `--scope=p1 --p1-files`는 부분 실행이며 full Gate 대체가 아니다. selector 재실행·timeout 증가·SKIP은 하지 않는다.

먼저 아래 종료 확인 경계만 최소 수정하는 안을 제출한다. **코드 변경 전 승인 요구는 사용자 첨부 지시서 단계 B에서 명시됐다. 패치하지 않았다.**

- `scripts/e2e/platform/process.mjs`: 일반 catch에서도 observeChildClose 결과를 우선 확인하고 기존 1000ms close-drain 경계를 재사용하여 유한 관측; closure·PID·강제 종료 여부·미확인 사유를 error에 첨부. deadline 후 FAIL 유지.
- `scripts/verification-engine.mjs`: catch에서 error의 PID·원래 error code·close 관측·자원 종료 확인 여부를 단계 영수증에 저장. 확인 실패는 UNKNOWN/unsafe로 후속 단계 차단.
- `tests/verification-lifecycle.test.js / tests/platform/lifecycle.test.js`: 연결된 기존 회귀 파일에서 deadline 후 정상 close와 미확인 close의 결과 보존·후속 차단을 집중 검증. 실제 편집 범위는 승인 후 호출 관계를 확인해 최소화.

정상 종료 경로·native containment·파일 목록·기존 기한·PASS 조건을 유지하고, timeout 후 FAIL과 종료 미확인 시 후속 차단을 보존한다. 새 후보는 새 source SHA로 관리하고 기존 PASS는 승계하지 않는다.

Discovery 분할이 별도로 필요해지면 201개 파일의 합집합 동일성·중복 없음·파일 제한·완료 영수증 결속·필수 검사를 보존한 변경안을 별도 승인받아야 한다. 분할로 단계 수와 전체 합산 허용 시간이 바뀌므로 기존 17/17 분모를 무비판적으로 유지할 수 없다. 이번에는 분할안을 적용하거나 단순히 단계 예산을 늘리지 않는다. 종료 확인 수정이 통과해도 예산 실행 조건이 확보되기 전 전체 Gate는 자동 실행하지 않는다.

## ④ 실제 사용자 기능

| 기능 | 현재 소스에서 입증 | 실제 UI E2E | 미검증 범위 |
|---|---|---|---|
| 프로젝트 선택·복구 | 일부 입증 — project-preparation, public/workflow-runtime: 준비·저장·화면 상태 복원 | 미검증 | 실제 UI 프로젝트 선택부터 맥락 복구 전체 동선 |
| 브라우저 대화·응답 귀속 | 일부 입증 — discussion-response, response-links, mixed-provider 등 제어된 피어 계약 | 미검증 | 실제 로그인 서비스 전송 및 응답 귀속 |
| 승인·Worker 실행 | 일부 입증 — preparation-api: HTTP 승인·영속 Run·RESULT projection | 미검증 | 실제 UI 승인 및 실제 외부 Worker 전체 동선 |
| 후보·Judge/Critic | 일부 입증 — multi-agent-coordination 12개: 독립 대화·동일 manifest·역할별 HOLD | 미검증 | 실제 로그인 Judge/Critic의 독립 검토 |
| 재검증·FAIL 차단 | 일부 입증 — code-review, code-change-service: REWORK·귀속·적용 차단 | 미검증 | 실제 사용자 수정·재검증 동선 |
| 명시적 Apply | 일부 입증 — spec 16/16 경계 관찰 및 code-change-service의 별도 Apply | 미검증 | 실제 대상에 사용자 승인 Apply |
| 재시작·연결 복구 | 일부 입증 — recovery-scan, generated Apply restart: 복구 및 자동 재전송 방지 | 미검증 | 실제 UI 재시작·연결 해제·미확정 전송 복구 |
| Shutdown·자원 회수 | 현재 소스에서 제한 범위 입증 — 양 OS M1: 실제 history 작업 취소·서버 자연 종료·DB 해제; 단독 selector 정상 close | 전체 UI 미검증 | 전체 Worker·브라우저 자원 및 과거 실패 실행 종료 |
| 전체 흐름 완주 | 미검증 — 후보 E 공식 28개 E2E 프로필 실행 없음 | 미검증 | 프로젝트 선택부터 검토·Apply·기록·복구까지 전체 |

내부 증거의 기준은 같은 후보 Discovery의 완료 FILE_RESULT 및 spec 영수증이다. 실제 브라우저·모델 서비스의 완주와 구분한다. 외부 서비스 영향 실행과 실제 대상 Apply는 별도 명시적 승인 전 수행하지 않는다.

## ⑤ 실패 및 미해결 항목

### 1. Discovery 기한 만료 및 종료 증거 누락

- 최초 실패 경계: discovery 단계 execution deadline; 마지막 FILE selector-repair.test.js
- 실제 오류 원문: E2E runner resource closure failed: execution deadline
- 확인된 원인: 단계 실행기 deadline 경계 진입 및 일반 catch 경로의 kill 후 close 미확인
- 수정 여부: 미수정; 최소 변경안 승인 필요
- 해결 근거: selector 단독 20/20 PASS는 해당 단독 실행만 해결 증거이며 기존 Discovery 해결 증거가 아님
- 다음 결정을 바꾸는 정보: 고정된 유한 cleanup 경계에서 exit/close를 저장하도록 하는 최소 변경 승인
- 미확인 사항: 누적 시간·기동/정리 비용의 정확한 분해; 당시 selector 파일 PID·정지 여부; 기한 만료 뒤 실제 자식 종료·자원 회수
- source SHA: `e33b7d3102b483052bb6ec85dc9fea2cdec9309bfde8afd3d675e7e311890200`
- 현재 수용 차단 여부: **예**

### 2. Ubuntu 잔여 공식 단계 미실행

- 최초 실패 경계: discovery 이후 10개 필수 단계 BLOCKED
- 실제 오류 원문: RESOURCE_CLOSURE_UNCONFIRMED
- 확인된 원인: 상위 실행기의 unsafe 분기
- 수정 여부: 없음
- 해결 근거: 없음; 158개 파일 PASS를 공식 단계 PASS로 대체하지 않음
- 다음 결정을 바꾸는 정보: B1 해결 및 예산 실행 조건 확보 뒤 동일 고정 소스의 공식 결과
- 미확인 사항: 잔여 43개 파일의 해당 실행 완료 결과; 후속 10개 단계 실제 결과
- source SHA: `e33b7d3102b483052bb6ec85dc9fea2cdec9309bfde8afd3d675e7e311890200`
- 현재 수용 차단 여부: **예**

### 3. Windows·minimum·후보 일치 CI 미확보

- 최초 실패 경계: 선행 Ubuntu full 미통과로 다음 환경 실행 조건 미충족
- 실제 오류 원문: 해당 없음: 실행되지 않아 오류 원문 없음
- 확인된 원인: 실행 증거 공백; 기본 커밋 CI는 미커밋 후보와 다름
- 수정 여부: 없음; commit/push 미승인
- 해결 근거: 기본 커밋 Actions #188 성공은 참고 이력만
- 다음 결정을 바꾸는 정보: 선행 Gate PASS 후 동일 코드의 OS·Node·minimum 영수증; 원격 업로드 필요 시 별도 승인
- 미확인 사항: Windows 19개 단계; minimum 2개 단계; 후보 source와 일치하는 CI matrix
- source SHA: `e33b7d3102b483052bb6ec85dc9fea2cdec9309bfde8afd3d675e7e311890200`
- 현재 수용 차단 여부: **예**

### 4. 실제 사용자 흐름 수용 미검증

- 최초 실패 경계: 후보 E 전체 공식 E2E·실제 로그인 서비스 동선 실행 증거 없음
- 실제 오류 원문: 해당 없음: 실행되지 않아 오류 원문 없음
- 확인된 원인: 검증 범위 부족; 제품 결함으로 단정하지 않음
- 수정 여부: 없음
- 해결 근거: 내부 계약·M1 성공은 전체 UI 완주를 대체하지 않음
- 다음 결정을 바꾸는 정보: 선행 검증 후 실제 대상 Apply 및 외부 서비스 영향 실행의 명시적 승인
- 미확인 사항: 공식 28개 프로필 결과; 실제 대화·Worker·독립 리뷰·Apply·복구 완주
- source SHA: `e33b7d3102b483052bb6ec85dc9fea2cdec9309bfde8afd3d675e7e311890200`
- 현재 수용 차단 여부: **예**

## ⑥ 변경 이력

| 변경 목적 | 변경 파일 | 변경 전 SHA | 변경 후 SHA | 집중 검사 | 전체 Gate |
|---|---|---|---|---|
| 기존 후보 기반 누적 변경 | 25개 경로(아래 목록) | UNKNOWN | e33b7d3102b483052bb6ec85dc9fea2cdec9309bfde8afd3d675e7e311890200 | M1 양 OS 및 HTTP 4/4; 전체 변경에 대한 개별 수정 이력은 UNKNOWN | Ubuntu FAIL; Windows NOT_RUN |
| HTTP evidenceFetch 4개 계약 추가(기존 기록) | `tests/agent-diagnostics-complete.test.js` | 81c4fc90a399a9d29e0137fde2dbd4a1d9fa24effd85d22cc752685f61c3aa5a | e33b7d3102b483052bb6ec85dc9fea2cdec9309bfde8afd3d675e7e311890200 | 4/4 PASS | Ubuntu FAIL |
| 승인된 selector 단독 1회(이전 턴) | 소스 수정 없음 | e33b7d3102b483052bb6ec85dc9fea2cdec9309bfde8afd3d675e7e311890200 | e33b7d3102b483052bb6ec85dc9fea2cdec9309bfde8afd3d675e7e311890200 | 20/20 PASS, close 확인 | 미실행 |
| 이번 분석 및 최종 산출물 | `verification-final-report.md`, `verification-final-status.json` | e33b7d3102b483052bb6ec85dc9fea2cdec9309bfde8afd3d675e7e311890200 | e33b7d3102b483052bb6ec85dc9fea2cdec9309bfde8afd3d675e7e311890200 | 추가 실행 없음 | 추가 실행 없음 |

후보 E의 기본 커밋 대비 변경 경로(원래 변경의 작성 순서·각 변경 전 source SHA는 UNKNOWN):

- ` M` `.github/workflows/bridge-gates.yml`
- ` M` `package.json`
- ` M` `public/app.js`
- ` M` `scripts/content-lifecycle-browser-suite.mjs`
- ` M` `scripts/diagnose-server.mjs`
- ` M` `scripts/run-tests.mjs`
- ` M` `scripts/test-completion-reporter.mjs`
- ` M` `scripts/verification-plan.mjs`
- ` M` `src/diagnostics/report-store.js`
- ` M` `tests/agent-diagnostics-complete.test.js`
- ` M` `tests/agent-report.test.js`
- ` M` `tests/helpers/failure-evidence.mjs`
- ` M` `tests/platform/code-history-http.test.js`
- ` M` `tests/runtime-cleanup/contract.test.js`
- ` M` `tests/source-checkout.test.mjs`
- ` M` `tests/verification-plan.test.js`
- `??` `scripts/history-shutdown-evidence.mjs`
- `??` `tests/helpers/cleanup-child-observer.mjs`
- `??` `tests/helpers/cleanup-execution-evidence.mjs`
- `??` `tests/helpers/history-shutdown-owner.mjs`
- `??` `tests/helpers/history-shutdown-seed.mjs`
- `??` `tests/helpers/project-draft-receipt-contract.mjs`
- `??` `tests/history-shutdown-contract.test.mjs`
- `??` `tests/platform/code-history-shutdown.test.js`
- `??` `tests/runtime-cleanup/evidence.test.mjs`

위 후보 경로를 이번 작업에서 수정하지 않았다. 두 보고서는 현재 Windows 작업 폴더에 작성하며, 별도로 보관된 Ubuntu/Windows 후보 E에 포함되지 않는다. 현재 작업 폴더 자체를 후보 E로 주장하지 않는다.

## ⑦ 최종 판정

| 평가 | 판정 | 이유 |
|---|---|---|
| 구현 상태 | INCOMPLETE | 주요 내부 기능·M1 동작은 입증됐지만 전체 기능 구현 완료 근거 부족 |
| 검증 상태 | FAIL | 동일 후보 Ubuntu Discovery FAIL, 필수 38개 중 PASS 6개 |
| 제품 상태 | UNKNOWN | 동일 소스 실제 사용자 흐름 완주 없음 |
| 배포·적용 상태 | INCOMPLETE | 후보 일치 CI 미확보, commit/push·실제 Apply 별도 승인 필요 |

**다음 단일 작업: 위 실행기 종료 확인 최소 변경안의 승인 결정.** 종료 요청과 실제 close 확인을 분리해야 하며 사용자 단계 B가 코드 변경 전 승인을 요구한다. 완료 조건은 제시된 파일 범위·유한 close 관측·기한 후 FAIL/후속 차단 유지·새 SHA 관리에 대한 명시적 승인 또는 거절이다. 승인 전 패치·집중 재검증·전체 Gate는 하지 않는다.

## 부록 A. 기존 사건의 보존

- 이전 `cd20c829…` 실행은 sudo browser-install 실패 후 RUNNING 영수증이 남았다. 후속 `8c5892f0…`에서 browser-install PASS이므로 현재 준비 장애로 재등록하지 않는다.
- 과거 Windows M1 실패의 progress 누락·DIAGNOSTIC_WRITER_BUSY는 보존하되 단독 후속 PASS와 별개 이력이다. 실제 누수 해결을 주장하지 않는다. `connect EACCES`의 해당 실행 직접 귀속은 UNKNOWN.
- 과거 source `ad68b59f…` E2E는 26/28 PASS·UF-24/UF-26 FAIL이며 후보 E로 승계하지 않는다. 현재 Windows 작업 폴더 계열 UF-25 단독 PASS도 승계하지 않는다.
- 기존 기본 커밋 CI #188은 4개 OS×Node 및 minimum 작업 성공 이력이다. 후보 E 미커밋 변경의 CI가 아니다.

## 부록 B. 158개 파일의 보존 실행 시간

각 값은 해당 파일 출력의 최상위 TAP `# duration_ms`이며 전체 파일 프로세스 생애 시간이나 단계 시간으로 해석하지 않는다. 원본 파일 순서 그대로다. 기동·FD 영수증·자식 종료·파일 사이 비용의 정확한 합계는 UNKNOWN. JSON에도 각 파일 수치·기한·PID·closure를 보존했다.

| # | 파일 | TAP 실행 시간(ms) | 파일 제한(ms) | 결과 |
|---:|---|---:|---:|---|
| 1 | `tests/ack-windows-result.test.mjs` | 475.384466 | 180000 | PASS |
| 2 | `tests/agent-diagnostics-complete.test.js` | 13785.672503 | 180000 | PASS |
| 3 | `tests/agent-diagnostics-http.test.js` | 3473.943890 | 180000 | PASS |
| 4 | `tests/agent-packet-rejections-persistence.test.js` | 2500.384033 | 180000 | PASS |
| 5 | `tests/agent-report-cli.test.js` | 3021.853681 | 180000 | PASS |
| 6 | `tests/agent-report.test.js` | 1473.196935 | 180000 | PASS |
| 7 | `tests/architecture-boundary.test.js` | 450.667579 | 180000 | PASS |
| 8 | `tests/audit-ack-crash-recovery.test.js` | 11327.886315 | 180000 | PASS |
| 9 | `tests/audit-ack-private-recovery.test.js` | 72939.079689 | 180000 | PASS |
| 10 | `tests/audit-ack-recovery.test.js` | 72883.661418 | 300000 | PASS |
| 11 | `tests/audit-boundaries.test.js` | 47193.597956 | 180000 | PASS |
| 12 | `tests/audit-crash-harness.test.js` | 5675.964618 | 180000 | PASS |
| 13 | `tests/audit-delivery-owner.test.js` | 25917.426497 | 180000 | PASS |
| 14 | `tests/audit-fixture-oracle.test.js` | 27022.816057 | 180000 | PASS |
| 15 | `tests/audit-fuzz.test.js` | 101080.967609 | 180000 | PASS |
| 16 | `tests/audit-gaps.test.js` | 16644.833160 | 180000 | PASS |
| 17 | `tests/audit-known-regressions.test.js` | 2773.645288 | 180000 | PASS |
| 18 | `tests/audit-pre-dispatch.test.js` | 12469.710883 | 180000 | PASS |
| 19 | `tests/audit-review-contract.test.js` | 11299.534832 | 180000 | PASS |
| 20 | `tests/canonical-json.test.js` | 429.202825 | 180000 | PASS |
| 21 | `tests/certify.test.js` | 11917.188994 | 180000 | PASS |
| 22 | `tests/code-change-deletion.test.js` | 1602.085863 | 180000 | PASS |
| 23 | `tests/code-change-e2e.test.js` | 12348.432183 | 180000 | PASS |
| 24 | `tests/code-change-review-prompt.test.js` | 421.105815 | 180000 | PASS |
| 25 | `tests/code-change-service.test.js` | 47463.454890 | 180000 | PASS |
| 26 | `tests/code-change-worker.test.js` | 461.570734 | 180000 | PASS |
| 27 | `tests/code-review.test.js` | 575.072060 | 180000 | PASS |
| 28 | `tests/codex-runtime.new.test.js` | 96941.394286 | 180000 | PASS |
| 29 | `tests/composer-guarded-send.test.js` | 707.792958 | 180000 | PASS |
| 30 | `tests/consensus.test.js` | 496.709683 | 180000 | PASS |
| 31 | `tests/content-lifecycle.test.js` | 4806.096448 | 180000 | PASS |
| 32 | `tests/contract/dashboard-action-capabilities.contract.test.js` | 452.115992 | 180000 | PASS |
| 33 | `tests/contract/dashboard-data-knowledge.contract.test.js` | 475.546268 | 180000 | PASS |
| 34 | `tests/contract/dashboard-degraded-state.contract.test.js` | 425.802168 | 180000 | PASS |
| 35 | `tests/contract/network-lifecycle/http-headers.test.js` | 518.279302 | 180000 | PASS |
| 36 | `tests/contract/network-lifecycle/http-unrequested-shutdown.test.js` | 2922.688773 | 180000 | PASS |
| 37 | `tests/contract/network-lifecycle/socket-observation.test.js` | 1546.156644 | 180000 | PASS |
| 38 | `tests/contract/preparation-capabilities.contract.test.js` | 600.619773 | 180000 | PASS |
| 39 | `tests/contract/web-dependency-state.contract.test.js` | 420.004079 | 180000 | PASS |
| 40 | `tests/controller-packet-rendering-contract.test.js` | 462.062898 | 180000 | PASS |
| 41 | `tests/conversation-bootstrap-tab.test.js` | 425.855911 | 180000 | PASS |
| 42 | `tests/conversation-view.test.js` | 465.760485 | 180000 | PASS |
| 43 | `tests/dashboard-connection-state.test.js` | 475.513830 | 180000 | PASS |
| 44 | `tests/dashboard-controller.test.js` | 3538.271057 | 180000 | PASS |
| 45 | `tests/dashboard-read-policy.test.js` | 505.339329 | 180000 | PASS |
| 46 | `tests/dashboard-snapshot-diagnostics.test.js` | 4198.042076 | 180000 | PASS |
| 47 | `tests/delivery-ack-restart.test.js` | 3006.577017 | 180000 | PASS |
| 48 | `tests/delivery-recovery-audit.test.js` | 1377.978652 | 180000 | PASS |
| 49 | `tests/delivery-recovery-ui.test.js` | 1293.789120 | 180000 | PASS |
| 50 | `tests/delivery-terminal-http.test.js` | 2139.149685 | 180000 | PASS |
| 51 | `tests/delivery-terminal-reconciliation.test.js` | 211.300487 | 180000 | PASS |
| 52 | `tests/diagnostic-export.test.js` | 150.128385 | 180000 | PASS |
| 53 | `tests/diagnostic-modules.test.mjs` | 2810.504495 | 180000 | PASS |
| 54 | `tests/diagnostic-safety.test.js` | 1778.510797 | 180000 | PASS |
| 55 | `tests/direct-mv3-identity.test.mjs` | 542.412671 | 180000 | PASS |
| 56 | `tests/discussion-actions.test.js` | 467.270409 | 180000 | PASS |
| 57 | `tests/discussion-blocked.test.js` | 6023.995140 | 180000 | PASS |
| 58 | `tests/discussion-dispatcher-integrity.test.js` | 3004.138673 | 180000 | PASS |
| 59 | `tests/discussion-dispatcher.test.js` | 4642.792718 | 180000 | PASS |
| 60 | `tests/discussion-loop.test.js` | 7260.555364 | 180000 | PASS |
| 61 | `tests/discussion-protocol-failure.test.js` | 5272.537361 | 180000 | PASS |
| 62 | `tests/discussion-response-atomicity.test.js` | 1765.863870 | 180000 | PASS |
| 63 | `tests/discussion-response-links.test.js` | 4998.687401 | 180000 | PASS |
| 64 | `tests/discussion-response.test.js` | 560.439489 | 180000 | PASS |
| 65 | `tests/discussion-runtime-evidence.test.js` | 441.955329 | 180000 | PASS |
| 66 | `tests/domain-contracts.test.js` | 496.066235 | 180000 | PASS |
| 67 | `tests/e2e/active-worker-cleanup.test.js` | 581.800328 | 180000 | PASS |
| 68 | `tests/e2e/execution-summary.test.js` | 16197.262726 | 180000 | PASS |
| 69 | `tests/e2e/graceful-shutdown.test.js` | 31253.354683 | 180000 | PASS |
| 70 | `tests/e2e/portability.test.js` | 588.785377 | 180000 | PASS |
| 71 | `tests/e2e/preflight-readiness.test.js` | 590.925633 | 180000 | PASS |
| 72 | `tests/e2e/progress.test.js` | 414.715359 | 180000 | PASS |
| 73 | `tests/e2e/worker-workspace-identity.test.js` | 2173.379045 | 180000 | PASS |
| 74 | `tests/exact-conversation-reopen.test.js` | 395.793792 | 180000 | PASS |
| 75 | `tests/extension-auth-challenge.test.js` | 400.924816 | 180000 | PASS |
| 76 | `tests/extension-delivery-review.test.js` | 4133.278622 | 180000 | PASS |
| 77 | `tests/extension-pairing-http.test.js` | 1759.476597 | 180000 | PASS |
| 78 | `tests/extension-pairing.test.js` | 485.075399 | 180000 | PASS |
| 79 | `tests/extension-reconnect.test.js` | 384.046674 | 180000 | PASS |
| 80 | `tests/fault/extension-failure.test.js` | 1463.739948 | 180000 | PASS |
| 81 | `tests/fault/reviewer-provider-failure.test.js` | 5468.173381 | 180000 | PASS |
| 82 | `tests/fault/run-store-read-failure.test.js` | 1499.580216 | 180000 | PASS |
| 83 | `tests/fault/runtime-failure.test.js` | 1401.248409 | 180000 | PASS |
| 84 | `tests/fault/server-response-deadline.test.js` | 14149.692962 | 180000 | PASS |
| 85 | `tests/fault/server-responsiveness.test.js` | 16254.015196 | 180000 | PASS |
| 86 | `tests/fault/state-projection-failure.test.js` | 1699.759034 | 180000 | PASS |
| 87 | `tests/flexible-tab-recovery.test.js` | 532.986814 | 180000 | PASS |
| 88 | `tests/git-change-workspace.test.js` | 5422.080933 | 180000 | PASS |
| 89 | `tests/history-shutdown-contract.test.mjs` | 2153.443852 | 180000 | PASS |
| 90 | `tests/live-discussion-composition.test.js` | 1006.950535 | 180000 | PASS |
| 91 | `tests/manual-followup-selection.test.js` | 445.496249 | 180000 | PASS |
| 92 | `tests/minimal-native-reload-matrix-v2.test.mjs` | 17192.624093 | 180000 | PASS |
| 93 | `tests/mixed-provider-audit.test.js` | 4747.527719 | 180000 | PASS |
| 94 | `tests/multi-agent-coordination.test.js` | 54612.064485 | 180000 | PASS |
| 95 | `tests/native-extension-gate.test.js` | 414.173530 | 180000 | PASS |
| 96 | `tests/native-reload-control.test.mjs` | 3707.261805 | 180000 | PASS |
| 97 | `tests/persistence-cleanup.test.js` | 562.248680 | 180000 | PASS |
| 98 | `tests/planning-session-api.test.js` | 1473.550458 | 180000 | PASS |
| 99 | `tests/platform/code-change-history.test.js` | 10427.752814 | 180000 | PASS |
| 100 | `tests/platform/code-history-boundary.test.js` | 9796.570018 | 180000 | PASS |
| 101 | `tests/platform/code-history-error-contract.test.js` | 3941.757704 | 180000 | PASS |
| 102 | `tests/platform/code-history-http-closure.test.js` | 14320.521047 | 180000 | PASS |
| 103 | `tests/platform/code-history-http.test.js` | 86753.438094 | 180000 | PASS |
| 104 | `tests/platform/code-history-owner.test.js` | 4397.844638 | 180000 | PASS |
| 105 | `tests/platform/code-history-remaining.test.js` | 7375.401161 | 180000 | PASS |
| 106 | `tests/platform/code-history-shutdown.test.js` | 42391.620692 | 180000 | PASS |
| 107 | `tests/platform/code-history-worker-cleanup.test.js` | 4145.041527 | 180000 | PASS |
| 108 | `tests/platform/inherited-pipes.test.js` | 2185.490272 | 180000 | PASS |
| 109 | `tests/platform/lifecycle.test.js` | 1434.304927 | 180000 | PASS |
| 110 | `tests/platform/persistence.test.js` | 2149.838881 | 180000 | PASS |
| 111 | `tests/platform/runner.test.js` | 10769.449618 | 180000 | PASS |
| 112 | `tests/platform/sqlite-database.test.js` | 407.411321 | 180000 | PASS |
| 113 | `tests/platform/sqlite-startup.test.js` | 2234.566353 | 180000 | PASS |
| 114 | `tests/platform/test-runner-gate.test.js` | 92448.746163 | 180000 | PASS |
| 115 | `tests/preparation-api.test.js` | 4404.563987 | 180000 | PASS |
| 116 | `tests/preparation-contention.test.js` | 23785.508823 | 180000 | PASS |
| 117 | `tests/preparation-packet-incidents.test.js` | 435.153003 | 180000 | PASS |
| 118 | `tests/preparation-service.test.js` | 21053.082841 | 180000 | PASS |
| 119 | `tests/preparation-stale-tab-integration.test.js` | 502.025926 | 180000 | PASS |
| 120 | `tests/preparation-tab-choice.test.js` | 499.724835 | 180000 | PASS |
| 121 | `tests/preparation-tab-focus.test.js` | 641.830004 | 180000 | PASS |
| 122 | `tests/prepared-session-target.test.js` | 543.959653 | 180000 | PASS |
| 123 | `tests/private-web-response.test.js` | 601.798207 | 180000 | PASS |
| 124 | `tests/project-activity.test.js` | 499.193076 | 180000 | PASS |
| 125 | `tests/project-preparation.test.js` | 1521.172373 | 180000 | PASS |
| 126 | `tests/project-settings.test.js` | 1908.452209 | 180000 | PASS |
| 127 | `tests/projection-rebuild-command.new.test.js` | 889.521236 | 180000 | PASS |
| 128 | `tests/projection-rebuild.test.js` | 1797.158324 | 180000 | PASS |
| 129 | `tests/proposal-persistence.test.js` | 1595.633996 | 180000 | PASS |
| 130 | `tests/protocol-failure.test.js` | 499.204027 | 180000 | PASS |
| 131 | `tests/public/audit-console.test.js` | 514.539960 | 180000 | PASS |
| 132 | `tests/public/dashboard-io-depth.test.js` | 692.749489 | 180000 | PASS |
| 133 | `tests/public/dashboard-model.test.js` | 519.886696 | 180000 | PASS |
| 134 | `tests/public/dashboard-status-view.test.js` | 444.431372 | 180000 | PASS |
| 135 | `tests/public/workflow-contract.test.js` | 513.275323 | 180000 | PASS |
| 136 | `tests/public/workflow-runtime.test.js` | 78702.812927 | 180000 | PASS |
| 137 | `tests/readiness-diagnostics.test.js` | 1723.908691 | 180000 | PASS |
| 138 | `tests/recovery-reconcile.test.js` | 1335.170663 | 180000 | PASS |
| 139 | `tests/recovery-scan.test.js` | 475.578632 | 180000 | PASS |
| 140 | `tests/relay-boundary.test.js` | 501.286953 | 180000 | PASS |
| 141 | `tests/reviewer-provider-router.test.js` | 431.955707 | 180000 | PASS |
| 142 | `tests/reviewer-provider-runtime.test.js` | 463.271912 | 180000 | PASS |
| 143 | `tests/reviewer-provider-selection-ui.test.js` | 435.881223 | 180000 | PASS |
| 144 | `tests/reviewer-settings.test.js` | 589.348468 | 180000 | PASS |
| 145 | `tests/run-information-architecture.test.js` | 444.035920 | 180000 | PASS |
| 146 | `tests/run-limits-persistence.new.test.js` | 1295.912913 | 180000 | PASS |
| 147 | `tests/run-outcomes-persistence.test.js` | 1632.410706 | 180000 | PASS |
| 148 | `tests/run-policy.test.js` | 479.998983 | 180000 | PASS |
| 149 | `tests/run-service.test.js` | 1512.394380 | 180000 | PASS |
| 150 | `tests/run-state-machine.test.js` | 587.791089 | 180000 | PASS |
| 151 | `tests/runtime-cleanup/contract.test.js` | 86390.287035 | 720000 | PASS |
| 152 | `tests/runtime-cleanup/evidence.test.mjs` | 507.703924 | 180000 | PASS |
| 153 | `tests/runtime-cleanup/representation.test.js` | 443.760140 | 180000 | PASS |
| 154 | `tests/runtime-initialization-diagnostics.test.js` | 970.528328 | 180000 | PASS |
| 155 | `tests/schema-migration.test.js` | 4121.438541 | 180000 | PASS |
| 156 | `tests/security-evidence.test.js` | 473.340776 | 180000 | PASS |
| 157 | `tests/selector-diagnostics-http.test.js` | 4032.583862 | 180000 | PASS |
| 158 | `tests/selector-repair-cli.test.js` | 45943.931311 | 180000 | PASS |

합계 **1462360.437055ms**.

