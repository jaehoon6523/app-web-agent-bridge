# E. Windows 중심 단계별 검증 계획

**승인용 제안 / 미실행.** [A](windows-product-acceptance.proposal.md)의 소스·18개 수용 기준을 따른다. 이번 실행은 0회다. 아래 명령은 향후 승인할 선택지이며 지금 실행하지 않는다. 공식 catalog·OS 정책·CI는 그대로다.

## 실행 순서와 완료 조건

| 순서 | 3단계/항목 대응 | 최소 작업·기존 검사 | 완료 조건 | 실패 시 | 예상 소요 |
|---|---|---|---|---|---|
| 0 | 공통 전제 | 승인된 source/head·설정·대상·환경 고정, 기존 active run/소유 PID 확인 | 1회 대상·기존 기한·종료 책임·권한 명확 | UNKNOWN이면 실행 보류·기존 관측만 좁혀 확인 | UNKNOWN |
| 1 | 기본 실행 W01~04 | 서버/기존 진단 supervisor 중 하나, 실제 Windows Chrome·설치 확장·Dashboard. startup/preflight·SQLite·기본 UI·native 계약 재사용 | HTTP 본문·인증/DB·정확한 탭/document·준비/오류 UI, 완료 후 정상 종료 | 첫 실패/미준비 경계 기록. 기한 내 신호 없으면 FAIL/UNKNOWN. 추가 서버·자동 retry 없음 | UNKNOWN |
| 2 | 핵심 W05~12 | 폐기 가능한 승인 대상, 실제 로그인 provider·Worker·독립 reviewer로 연속 UI. UF-05~10·18~21·23 참고 | 프로젝트→대화→합의 승인→Worker→후보→독립 감사→FAIL 차단/수정→별도 Apply→기록/후속 새 승인 | 첫 끊긴 사용자 행동·ID·확정 상태 보존, 뒤는 미검증. 외부/Apply 미승인이면 실행 안 함 | UNKNOWN |
| 3 | 안전 W07/09~12/16 | 바뀐 책임 경계의 기존 승인·manifest·후보·evidence·Apply 부정 계약을 Windows 격리 환경에서 선별 | required FAIL/open finding/stale/foreign evidence 적용 차단·독립성 유지·UI/API 거절 대응 | 격리 대상에서 첫 실패만 분리. 실제 사용자 target에 오적용 시험 금지 | UNKNOWN |
| 4 | 복구·추적 W13~18 | 기존 disconnect/restart/delivery audit/cleanup/export와 실제 Windows 관측 | 6개 trace 질문에 답하고 자동 resend/rerun/apply 없음. exit/close·핸들 해제·source 유지 | 종료 미확인이면 추가 실행 중단. kill 요청을 PASS로 계산하지 않음 | UNKNOWN |
| 5 | 영향 회귀 | 변경 diff와 B 블록 연결로 기존 unit/contract/integration/browser 집합 선택 | 동일 source의 예정 집합 완료, 예상 밖 skip/todo/미완료 0, 권한 계약 유지 | 최초 실패 가족만 조사, 전체 자동 반복 금지 | UNKNOWN |
| 6 | 별도 다중 OS·CI 요구 | 기존 verify:all/minimum/Actions OS×Node, 승인된 범위 1회 | 원래 공식 단계·파일/프로필 집합·source·terminal/finishedAt·close 충족 | 실패·후속 차단 기록. Windows 수용과 별도 보고 | UNKNOWN |

안전 검사를 순서 3에서 보고하더라도 기존 승인/candidate/Apply 보호는 순서 1~2에서도 활성이다. 안전을 끄고 실제 Apply한 뒤 검사하는 절차가 아니다. 실제 Apply는 승인된 폐기 가능한 대상과 명시적 사용자 승인에 한정한다. 승인 없으면 W12 미검증이며 완전 Windows 수용 PASS를 부여하지 않는다.

`npm run diagnose:server`는 같은 한 서버를 기존 supervisor로 관측하는 후보 명령이다. 새 daemon·진단 시스템·polling을 만들지 않는다. 데이터 경로·설치/인증 구성·종료 책임은 실행 승인 시 고정한다. 필요에 따라 기존 `test:platform:browser`, `test:tab-ux-browser`, `test:extension:native`, `test:first-load`를 선택하여 재사용하되 한 번에 모두 자동 실행하는 묶음이 아니다.

## Windows에서 제외된 검사의 대체 범위

| Linux 공식 항목 | Windows에 존재하는 검사 | 대체되는 범위 | 대체되지 않는/미입증 범위 | Windows 제품 수용 처리 |
|---|---|---|---|---|
| ui | platform-browser, tab-ux, e2e, 별도 first-load script | 시작/로드·일부 degraded UI·8개 탭 UX·부분 흐름 | ui-scenarios 전체의 설정 저장·증거 조회·layout/mobile 등 동작의 Windows 동등 관측/영수증 대응표 없음. first-load는 untracked 구현이며 browser 단계의 Linux 정책 때문에 Windows full에 자동 등록되지 않음 | W04/05/12/13/18 및 사용하는 UI의 영향 회귀에서 필요한 동작 확인. 증거 없으면 미검증 |
| browser(core 5 suite) | native, tab-ux, e2e, 일부 discovery 계약 | native 로딩/재로드의 통제 DOM, 탭 선택/복구, 생산 경로와 제어 피어 | 확장·콘텐츠·전달 종료·준비·first-load 5개 suite 전체의 Windows 동등 증거 없음. native는 chatgpt URL을 route.fulfill한 fixture, tab-ux는 LOCAL_FIXTURE_NOT_INSTALLED_EXTENSION | W03/06/13~15/17 관측과 해당 계약 재사용. live provider 결과 별도 |
| sabotage | Discovery 계약/fault, controlled E2E | 정해진 실패 입력의 fail-closed | 빈 response extraction·parsed packet 우회·UI 합의 누락의 3개 의도적 변형을 Windows 검사가 검출한다는 증거 없음 | 부정 안전 입력 W11/16 필수. 전체 mutation test는 보조이며 Linux 정책을 자동 변경하지 않음 |

검사의 존재를 현재 Windows PASS로 세지 않는다. OS 제외는 공식 Gate의 POLICY_EXCLUDED로 유지하고 새 수용안의 미검증과 구분한다. native 성공도 실제 로그인 서비스 연동 성공이 아니다.

## 공식 Gate 정적 대응

| 단계 ID | 현재 Windows 정책 | Ubuntu 정책 | Windows 수용안에서의 역할 |
|---|---|---|---|
| dependencies | 필수 | 필수 | 설치 준비, 제품 전체 PASS 대체 아님 |
| browser-install | 필수 | 필수 | 브라우저 실행 준비 |
| lint | 필수 | 필수 | 내부 회귀·품질 |
| architecture | 필수 | 필수 | 책임 경계의 정적 제약 |
| types | 필수 | 필수 | 내부 회귀·품질 |
| spec | 필수 | 필수 | Apply 입력/복구 경계, 실제 UI와 별도 |
| discovery | 필수: discovery, discovery-2/3/4 | 필수: 단일 discovery | 전체 내부 inventory, 실사용 PASS 대체 아님 |
| integration | 필수 | 필수 | 기존 통합 계약 |
| platform | 필수 | 필수 | 저장·경로·프로세스 등 계약 |
| cleanup | 필수 | 필수 | 자원 정리 계약 |
| windows-focused | 필수 | OS 제외 | Windows 집중 계약 |
| platform-browser | 필수 | 필수 | 실제 브라우저의 production 상태/수명주기, live provider 아님 |
| e2e | 필수 | 필수 | 28 controlled 프로필, 실제 서비스와 별도 |
| ui | OS 제외 | 필수 | 위 대체표 참조 |
| browser | OS 제외 | 필수 | 위 대체표 참조 |
| tab-ux | 필수 | 필수 | 8개 GUI fixture 시나리오 |
| sabotage | OS 제외 | 필수 | 위 대체표 참조 |
| native | 필수 | 필수 | native 확장·수명주기 + 제어 DOM |
| minimum-dependencies | 별도 CI 대상 아님 | minimum 범위 필수 | 최소 Node 별도 축 |
| minimum-sqlite | 별도 CI 대상 아님 | minimum 범위 필수 | 최소 Node SQLite 별도 축 |

현재 소스 분모는 Windows 18, Ubuntu 17, minimum 2다. 후보 E는 discovery-serial 추가로 Windows 19였으며 기존 6/36(full)·6/38(minimum 포함)은 후보 E 이력이다. 새 제품 수용 18개는 공식 Windows 단계와 다른 집합이다. 이번에 catalog나 분모를 바꾸지 않았다.

## 목적·환경·필수성

- **Windows 수용 필수:** A의 W01~W18. 실제 서비스가 필요한 동작과 격리 부정 계약을 모두 충족한다.
- **보조:** controlled 28 프로필·ui fixture·native fixture·first-load·sabotage는 해당 범위 보조 근거다. 안전 invariant의 부정 검사는 필수지만 전체 sabotage matrix를 제품 수용과 동치로 두지 않는다. 공식 catalog의 기존 필수성은 유지한다.
- **타 OS 전용:** ui/browser/sabotage의 현재 Linux 정책. Linux 실패는 공식 Gate FAIL로 계속 남고 Windows 제품 결과와 합치지 않는다.
- **다중 OS/CI/minimum:** 릴리스/명시 요구 시 별도 검증 축. 미확보 상태는 Windows 연결 관측 시작을 막지 않는다. 미커밋 후보와 CI head_sha를 동일 코드로 추정하지 않는다. commit/push 필요 시 별도 승인이다.

## 시간·준비·실패 처리

현재 Windows 3단계/18개 항목의 측정 소요 시간은 **UNKNOWN**이다. 과거 다른 소스의 단일 파일 시간을 전체 Windows 예상 시간으로 외삽하지 않는다. 후보 E Ubuntu selector 단독 20/20 PASS(약16.42초, 실행기 close 약17.54초)와 양 OS M1은 이력이며 현재 Windows 수용 PASS가 아니다.

준비는 실제 HTTP 본문·DB·확장 인증·document binding·runtime availability 신호로 판정한다. listen/heartbeat/headers만으로 전체 준비를 선언하지 않는다. 기존 180초 기본 파일 제한과 개별 예외, 25분 공식 단계 및 각 검사 준비/본문/정리 제한을 유지한다. Web 응답 설정도 임의 증량/단축하지 않는다.

준비 신호가 오면 즉시 진행하고 본문 완료 후 정상 종료/해제를 확인한다. 시간 소진 시 경계·단조 경과·마지막 신호·자식 상태를 기록한다. 종료 미확인이면 UNKNOWN으로 남겨 추가 실행을 중단한다. 기존 intentional wait·조회 polling을 삭제하지 않으며 새 sleep·무한 polling·자동 mutation retry를 도입하지 않는다.

18/18과 실제 연속 동선·안전·추적·정리 증거를 확보하면 Windows 사용 가능을 판정한다. 부분 성공이면 항목별 상태만 보고한다. 다음 결정을 바꾸지 않는 진단은 중단한다. 이번 검토는 A~E 변경안 제출로 완료하며 실행·기존 문서 반영·코드 변경은 시작하지 않는다.

## 근거

- [catalog](../../../scripts/verification-plan.mjs), [runner](../../../scripts/verify-all.mjs), [공식 계약](../../verification-run-contract.md), [CI](../../../.github/workflows/bridge-gates.yml)
- [native 제어 DOM](../../../scripts/native-extension-suite.mjs), [tab UX scope](../../../scripts/preparation-tab-ux-browser.mjs), [8개 GUI ID](../../../scripts/verification-gui-contract.mjs)
- [UI fixture](../../../scripts/ui-scenarios.mjs), [browser core](../../../package.json), [sabotage 3개 변형](../../../scripts/sabotage-critical-preparation.mjs)
- [28 프로필](../../../scripts/e2e/flows.json), [controlled 확장](../../../scripts/e2e/helpers/extension.mjs), [controlled Worker](../../../scripts/e2e/helpers/worker.mjs)
