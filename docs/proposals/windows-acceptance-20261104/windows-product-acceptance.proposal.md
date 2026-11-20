# A. Windows 제품 수용 명세 및 재검토 보고서

**승인용 제안 / 미반영.** 검토일: 2026-11-04, Asia/Seoul. 제품·테스트 코드, 기존 문서, 공식 Gate는 변경하지 않았다. 테스트·런타임·Gate 실행은 0회다.

검토 기준은 미커밋 변경을 포함한 작업 트리 HEAD `0791a19fe8b21274698784a404ac7bb5545ddc6e`, 제안서 생성 전 source SHA-256 `45f75a4a46fbb86f0bc26944662239e092a2145a1f13da442ae886fd02af9b83`(manifest 606개 파일)이다. 제안 문서 생성 후 작업 트리 해시는 달라질 수 있다. 과거 후보 E `e33b7d3102b483052bb6ec85dc9fea2cdec9309bfde8afd3d675e7e311890200`와 구분한다.

## 1. 핵심 결론

**현재 Windows 실사용 가능 여부는 UNKNOWN이다.** 사용 불가나 기능 미구현으로 확정한 것이 아니다. 실제 설치된 확장·로그인 provider·Worker·독립 리뷰·명시적 Apply·복구를 같은 현재 소스에서 연결한 완주 증거가 없다.

최상위 목표를 **Windows에서의 실제 실행 가능성, 명확한 로직 책임, 실행 맥락 추적성**으로 정의한다. 아래 18개 제품 수용 기준과 기존 공식 다중 OS Gate/CI를 별도 축으로 판정한다. 새 수용안의 승인은 기존 Gate 실패를 없애거나 필수 검사를 SKIP하는 승인이 아니다.

Ubuntu 성공을 Windows 수용 검증의 선행조건으로 삼지 않는 안을 제안한다. 저장소 CI는 이미 OS 매트릭스를 병렬 실행하고 `fail-fast:false`다. Ubuntu→Windows 선행 순서는 이전 Worker 작업 지시의 순서였으며, CI 코드의 종속성이 아니다.

## 2. 현재 구현 상태

| 분류 | 확인 결과 | 근거 |
|---|---|---|
| 구현돼 유지 | 준비 context·명령 receipt·승인·고정 후보·Judge/Critic·별도 Apply·복구 fail-closed | preparation-service, code-change-service, audit-round, CodeChangeStore |
| 구현됐으나 현재 Windows 미검증 | 실제 로그인 서비스 전송·실제 Worker·설치 확장과 UI의 전체 동선·종료 | 어댑터/브라우저 코드 존재는 완주 증거가 아님 |
| 문서 설명의 범위 불명확 | DISCUSSION RunPhase·CODE_CHANGE stage·preparation·UI 상태를 하나의 전역 FSM처럼 읽을 수 있음 | CANONICAL_OWNERSHIP, SESSION_STATE_POLICY. 기능이 문서에만 있다고 단정하지 않음 |
| 확인된 연결 누락 | `code_` 런·역할 세션 ID의 진단 필터 불일치, HTTP 관측 ID↔사용자 command ID 조인 부족 | C의 정적 코드 근거. 원본 run 기록 소실로 확대하지 않음 |
| 과도한 제품 선행조건 | 전체 다중 OS/CI 통과를 Windows 첫 실사용 관측보다 앞세운 이전 작업 순서 | 내부 회귀 계약 자체가 불필요하다는 판정은 아님 |
| 별도 계약 결정 필요 | Windows 수용안 채택·기존 문서 반영·공식 Gate 변경은 서로 다른 승인 | D 참조 |

## 3. Windows 수용 체크리스트

분모는 테스트·파일·공식 단계 수가 아니라 **사용자 결과/안전 경계 18개**다. 복합 조건은 모두 관측해야 한 항목 PASS다. 현재 같은 소스의 실제 Windows 수용 증거 기준 **0 PASS / 0 FAIL / 18 UNKNOWN**이다. 미검증을 FAIL이나 미구현으로 바꾸지 않았다.

| 단계 | 전체 | PASS | FAIL | 미검증 |
|---|---:|---:|---:|---:|
| 1. 기본 실행 | 4 | 0 | 0 | 4 |
| 2. 핵심 사용자 기능 | 8 | 0 | 0 | 8 |
| 3. 복구·안전·추적 | 6 | 0 | 0 | 6 |
| **합계** | **18** | **0** | **0** | **18** |

아래 전 항목은 **Windows 수용 필수**, 현재 상태는 **UNKNOWN**이다. 제어된 검사는 해당 안전 경계만 입증하며 실제 서비스가 필요한 부분을 대체하지 않는다.

| ID/단계 | 목적 | 환경 | 관측 가능한 통과 조건 | 실패 영향 | 재사용 검사·영수증/프로필 |
|---|---|---|---|---|---|
| W01/1 | 서버·루프백·인증 | 실제 Windows | listen 외에 health/preflight HTTP 본문 완료·Dashboard 세션 인증 | 전체 진입 불가 | preflight-readiness, platform/browser.contract, UF-01A/B·02·14·17 |
| W02/1 | SQLite·저장·오류 표시 | 실제 Windows + 격리 장애 | 저장/읽기 정상; 잠김·손상·초기화 실패는 unavailable·관련 mutation 차단 | 유실·상태 오판 | platform/sqlite-*, fault/run-store-read-failure, UF-13·15 |
| W03/1 | 설치 확장·정확한 탭 | 실제 Windows Chrome | 실제 확장 identity 인증·탭/document 바인딩; heartbeat만으로 준비 선언 금지 | 연결 불가·오전송 | native-extension-suite, extension-pairing, web-document-binding, UF-01C·04·24·25 |
| W04/1 | 준비·로딩·오류·회복 UI | 실제 Windows UI + 제어 HTTP 장애 | 부분/오래된 응답·렌더 오류 구분, 마지막 확정 상태와 안전한 새로고침 | 멈춘 화면·가짜 READY | first-load-browser-suite, public/workflow-runtime, UF-02·03·13·14·17 |
| W05/2 | 프로젝트·맥락·기록 | 실제 Windows UI | 경로·요구사항 버전·이전 context/run 복원; 기록·note·보관/복원 유지; 권한 승계 없음 | 프로젝트/과거 권한 혼입 | project-preparation, project-activity, UF-05·19·21 |
| W06/2 | 대화·응답 귀속 | 실제 로그인 provider·설치 확장 | 선택 탭에 1회 전송; 같은 session/delivery/대화/message 응답 검증·저장·ACK | 다른 응답 처리·중복 대화 | preparation-api, discussion-response-links, preparation-critical, UF-05·06 |
| W07/2 | 합의·사용자 승인 | 실제 Windows UI | 최신 합의/version 승인으로 resultingRunId 1개; 승인 전 Worker/저장소 준비 없음 | 무승인 변경·중복 Run | preparation-service/api, contract/preparation-capabilities, UF-06·07 |
| W08/2 | 실제 Worker·승인 요청 | 실제 설정 Worker | 별도 worktree·실제 thread/turn·정확한 approval correlation; 공개 capability의 개입 유지 | 대상 직접 변경·오승인 | code-change-worker, worker-approval-authority, worker-workspace-identity, UF-07·23 |
| W09/2 | 후보·증거 고정 | 실제 Windows + 계약 | base/tree/patch/hash/candidate 동결; 후보 변경 시 기존 검증 증거 무효 | 다른 후보 감사·적용 | code-change-e2e, security-evidence, code-change-review-prompt, UF-07·08 |
| W10/2 | 독립 Judge/Critic | 실제 로그인 리뷰어 + 계약 | 서로 다른 대화·같은 manifest·귀속된 reasoning/assertions; 논의/노트가 권한 우회 안 함 | 독립성 상실 | multi-agent-coordination, mixed-provider-audit, UF-08·16·18·19 |
| W11/2 | FAIL 차단·수정·재검증 | 실제 UI + 격리 부정 계약 | 필수 FAIL/open finding 차단, agreed work order→새 후보·manifest 재감사 | FAIL 후보 적용 | code-review, code-change-service, worker-provenance, UF-09 |
| W12/2 | 명시적 Apply·기록·후속 | 승인된 폐기 가능 대상/실제 UI | 정확한 candidate/review/hash/base/version 별도 승인→tree 확인·APPLIED; 후속 작업 새 승인 | 오적용·중복 적용 | generated/apply 두 경계, code-change-service, UF-10·20 |
| W13/3 | 연결 해제·부분 provider 실패 | 실제 Windows + 통제 장애 | 역할별 HOLD·원래 오류·확정 상태 보존; 지연 응답/close가 새 연결·후보를 덮지 않음 | 오판·무한 대기 | extension-reconnect, fault/reviewer-provider-failure, UF-03·16·17 |
| W14/3 | 재시작·상태 복구 | 실제 Windows | 저장 상태 재검증; 진행 중 작업 RECOVERY_REQUIRED; 자동 resend/rerun/apply 없음 | 중복 실행·문맥 유실 | recovery-scan, delivery-ack-restart, generated Apply restart, UF-11 |
| W15/3 | 미확정 전송·문서 변경 | 실제 Windows + 통제 장애 | 오래된 문서 거절; exact ownership inspect/reconcile; 결과 미확정 재전송 금지 | 중복 대화·다른 탭 조작 | web-stored-ambiguous-recovery, delivery-recovery-audit, tab-focus-guards, UF-12·24~26 |
| W16/3 | 잘못된 후보·증거 적용 차단 | 격리 계약 + UI 표시 | foreign/stale candidate/review/manifest·dirty target·변조 증거 거절 | 미검토 코드 적용 | code-review, security-evidence, B-APPLY-INPUT 부정 경계 |
| W17/3 | 취소·Shutdown·자원 회수 | 실제 Windows PID/핸들 | STOPPING≠종료; Worker/브라우저/실행기 exit/close·DB/포트 해제; 미확인은 복구 필요 | 잠금·잔존 작업·다음 실행 불확실 | active-worker-cleanup, runtime-cleanup, code-history-worker-cleanup, verification-lifecycle |
| W18/3 | 추적성·복구 판단·비밀 보호 | 실제 Windows 증거 + 격리 계약 | 행동→전이→외부요청→결과→복구를 기존 ID로 연결; 공개 로그에 본문/credential 없음 | 원인·안전 재시도 판단 불가 | agent-report, diagnostic-safety, delivery-recovery-audit, agent-diagnostics-complete |

18/18과 연속 UI 완주·필수 부정 계약·종료·추적 증거가 있어야 완전 Windows 수용이다. 일부 E2E만으로 안전 검사 전체를 충족하지 않는다. 선택하지 않은 provider 구성의 지원을 삭제하지 않고 검증 상태를 별도 표시한다. UI가 제공하는 기록/논의/노트/후속/보관/Worker 개입도 위 항목과 영향 회귀에서 유지한다.

## 4. 로직 블록 구조

9개 블록은 서비스·도메인·저장·어댑터로 이미 나뉘어 있다. 책임 범위를 명시하면 대체로 유지 가능하며 파일 분할·전면 재작성 근거는 없다. [B 책임·입출력·전이·복구](logic-blocks.proposal.md) 참조.

## 5. 로그 추적성

원본 run/history·명령 receipt·delivery/ACK·manifest로 부분 연결 가능하다. 그러나 HTTP 관측 ID↔command ID, 진단 ID 필터, latest-only export의 역사/복구 연결에는 공백이 있다. 단일 export만으로 충분하다는 판정은 불가다. [C 확인된 연결과 부족한 연결](log-traceability.proposal.md) 참조.

## 6. 기존 지침 변경안

[D P0/P1/P2 표](guideline-changes.proposal.md)를 제출한다. P0는 실제 Windows·필수 안전 수용의 직접적인 증거 공백에 한정한다. 진단 개선·문서 정정·실행기 종료 관측은 P1이며 실제 제품 누수로 단정하지 않는다.

## 7. 다음 작업·최종 판단

다음 단일 작업은 **수용안/우선순위 승인 후 고정 소스로 Windows 기본 실행 W01~W04를 1회 관측하는 것**이다. 실제 환경/source, HTTP 본문·DB·확장 인증·정확 탭·준비/오류 UI와 마지막 확정 상태·종료를 기존 증거로 연결하면 완료다. 최초 실패 경계에서 멈춘다. 실행은 별도 승인 대상이며 이번에는 시작하지 않았다. [E 단계별 계획](windows-verification-plan.proposal.md) 참조.

| 최종 평가 축 | 현재 판정 | 의미 |
|---|---|---|
| Windows 실사용 가능 여부 | UNKNOWN | 현재 소스 실제 완주·필수 안전 증거 부족 |
| 로직 블록 구조의 적절성 | 조건부 적절 | 기존 경계 유지; 상태 체계·문서 범위 정정 필요 |
| 로그 추적성의 충분성 | INCOMPLETE | 기존 저장 기록은 있으나 export 연결·실제 Windows trace 미검증 |
| 전체 공식 Gate/CI | 현재 소스 UNKNOWN / 후보 E 이력 FAIL | 제품 수용과 별도 판정 |

현재 catalog 정적 분모는 Ubuntu 17·Windows **18**·minimum 2다. Windows Discovery 4그룹이며, 후보 E의 discovery-serial+4그룹·Windows **19**와 다르다. 이번 변경이 아니다. 새 Windows 제품 기준 18개와 공식 Windows 단계 18개는 우연히 수만 같은 별도 집합이다. 후보 E 이력 6/36(full), 6/38(minimum 포함)은 [기존 보고서](../../../verification-final-report.md)에 보존하고 현재 PASS로 승계하지 않는다.

## 주요 원본 근거

- [README](../../../README.md), [공식 catalog](../../../scripts/verification-plan.mjs), [CI](../../../.github/workflows/bridge-gates.yml)
- [workflow 계약](../../../public/WORKFLOW_CONTRACT.md), [소유권](../../state-ownership.md), [canonical map](../../CANONICAL_OWNERSHIP.md)
- [native의 제어 DOM](../../../scripts/native-extension-suite.mjs), [controlled E2E 확장](../../../scripts/e2e/helpers/extension.mjs), [실행 프로필 28개](../../../scripts/e2e/flows.json)

기존 문서 수정·코드/테스트 변경·공식 정책 변경·실제 실행은 각각 승인 후 별도 작업이다.
