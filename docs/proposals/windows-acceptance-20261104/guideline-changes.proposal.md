# D. 기존 개발·검증 지침 변경안

**승인용 제안 / 미반영.** 검토 범위는 [A](windows-product-acceptance.proposal.md)와 같다. 기존 문서 덮어쓰기·제품/테스트 수정·공식 정책 변경·실행을 하지 않았다.

P0는 실제 Windows 흐름이나 필수 안전 수용을 직접 차단하는 문제/증거 공백으로 제한한다. 미검증을 제품 결함으로 단정하지 않는다.

## 변경표

| 우선순위 | 기존 지침·실제 근거 | 문제점 | 수정 지침(안) | 변경 이유 | 기존 기능 영향 |
|---|---|---|---|---|---|
| P0 | 이전 Worker 지시: Ubuntu→Windows→CI→실제 E2E. 실제 CI는 OS 병렬 | Windows 연결·동선 확인이 Linux/내부 Gate 뒤로 밀림 | Windows 기본 연결→핵심 E2E→안전→복구/trace→영향 회귀. 다중 OS/CI는 별도 요구 시 | 최상위 제품 목표와 순서 일치 | 기능 변화 없음. 공식 catalog 유지. 작업 순서 변경 승인 필요 |
| P0 | 내부 계약·controlled E2E·native fixture가 존재 | 실제 로그인 서비스·Worker·독립 리뷰·Apply의 현재 Windows 완주 미입증 | A의 18개 결과를 실제/제어 환경별 판정, 미확인 하나라도 완전 수용 보류 | 실행 가능성의 구체 관측 | 실제 외부/Apply는 별도 승인, 안전 계약 유지 |
| P0 | 후보·독립 감사·명시적 Apply·복구 계약은 구현됨 | 일부 E2E만으로 부정 안전까지 PASS로 확대할 위험 | W09~W17의 잘못된 후보·독립성·미확정 전송·종료 부정 검사를 필수로 유지 | 안전한 사용 직접 보호 | 계약 약화/우회 없음. 격리된 승인 대상에서만 검증 |
| P1 | Windows ui/browser/sabotage OS 제외, tab-ux/native/e2e 필수 | 동작별 대체 범위와 공백 미정의 | E의 대응표로 필요한 Windows 동작 관측. 대체 없는 범위 미검증 유지 | OS 제외를 지원 관측으로 오해하지 않음 | Linux 검사 유지, Windows catalog 자동 추가 금지 |
| P1 | CANONICAL_OWNERSHIP·SESSION_STATE_POLICY | DISCUSSION/코드변경/준비/UI 상태를 한 전역 FSM처럼 읽을 수 있음 | B의 bounded context별 소유자·전이 명시 | 이중 정본/권한 정의 예방 | 모듈·wire 상태 유지, 문서 정정 |
| P1 | WORKFLOW_CONTRACT의 첫 응답 대기 설명 | START 유지와 PREPARE 대기 단락 충돌 | 공개 workflow와 내부 preparation 상태 구분, 현재 connecting→START projection에 맞춰 정정 | 코드·문서 일치 | 코드 수정 없음 |
| P1 | diagnosticId vs code_·역할 web_ ID | 진단 ID 누락·read-only 연결 UNAVAILABLE의 정적 근거 | 실제 생성기 문법만 허용, 기존 run/artifact 참조 연결 | 응답·후보·복구 trace 연결 | 권한/ownership 검사 완화 금지. 좁은 코드/검사 변경 별도 승인 |
| P1 | observer 숫자 requestId와 durable command requestId | 사용자 행동↔HTTP↔서비스 조인 부족 | 기존 stage에 안전한 command/preparation/run/version 참조 추가안 | 로그 양 대신 연결 개선 | 본문·credential 수집/새 로깅 시스템 없음. 별도 승인 |
| P1 | latest snapshot·bounded incidents | 전체 전이/복구 이력으로 오해 가능 | 원본 history/receipt는 정본, latest는 상태·참조. stale/unavailable 명시 | 안전 재시도 판단 | 보존·redaction 유지. 부족한 참조만 보완 |
| P1 | 일반 실행기 timeout의 kill 요청 | exit/close·회수 완료와 구분 부족 | 기존 유한 close 도구로 확인·보존, 미확인 후속 차단 | 안전한 다음 실행의 증거 | timeout/FAIL 유지, 자동 retry 없음. 별도 승인; Ubuntu 해결을 Windows 첫 확인의 선행조건으로 삼지 않음 |
| P1 | coverage-matrix의 25 profiles COMPLETE/RUNNABLE, flows.json 28개 | 명세·실행 가능 선언·실제 PASS 혼동 | 예정 집합 28 ID·source-bound 결과·fixture/live 범위 분리 | 오래된 완료 서술 재사용 방지 | 흐름/테스트 삭제 없음. 문서 정정 |
| P1 | README의 CI full Node24 서술, workflow Node22.14/24 | 최소/전체 환경 결과 혼동 | 실제 workflow 정적 구성과 동종 소스 영수증 분리 | 환경 지원 인수인계 정확성 | 지원 버전 변경 없음 |
| P2 | 전 OS·CI/minimum을 모든 제품 판단의 선행 분모로 사용 | Windows 제품 가용성과 회귀/호환성 목표 혼합 | 공식 Gate/CI 별도 보고 축 유지, 릴리스/명시 요구 시 실행 | 목표의 불필요한 확대 방지 | 기존 CI job·지원 선언 삭제 안 함. 제품 순서에서만 선행 제외 |
| P2 | 파일 분할·로그 확대 중심의 구조 개선 | 실효 없는 변경 비용 | 실제 책임 충돌/중복 authority/trace 단절만 개선 | 최소 유지보수 변경 | 기능·명확한 기존 경계 유지 |

## 유지·제외·별도 결정

**유지:** 요구사항 승인, candidate 고정, 독립 리뷰, 필수 findings, 별도 Apply, expectedVersion/requestId, private/public evidence 분리, hash/history, 복구 fail-closed, 기존 유한 준비·본문·정리 시간. focused platform/cleanup의 의도적 중복을 테스트 수만으로 삭제하지 않는다.

**Windows 제품 선행조건에서만 제외하는 안:** Ubuntu 전면 PASS, 모든 Node/provider/CI의 선통과. 공식 catalog에서 없애는 안이 아니며 기존 실패를 SKIP으로 바꾸지 않는다. A의 새 Windows 수용 기준을 공식 catalog 단계로 자동 추가하지 않는다.

**서로 다른 승인 결정:** (1) Windows 수용 기준/우선순위 채택, (2) 기존 지침 반영, (3) 구체 코드/테스트 변경, (4) 실제 Windows 관측 실행, (5) 공식 catalog/CI 정책 변경, (6) 외부 서비스 영향 실행·실제 대상 Apply, (7) commit/push. 어느 하나의 승인을 포괄 승인으로 보지 않는다.

실패하면 최초 경계·마지막 확정 상태·미확인을 남기고 다음 결정을 바꾸는 좁은 작업만 정한다. 기존 intentional wait·기한을 삭제/단축하지 않으며 새 sleep·무한 polling·자동 mutation 재시도·timeout 증량을 도입하지 않는다.

## 승인 후 반영 대상 문서

- [README](../../../README.md): 제품 목표·증거 수준·환경 지원 설명
- [verification-run-contract](../../verification-run-contract.md): 공식 Gate 축을 유지하면서 제품 수용 축과 분리
- [CANONICAL_OWNERSHIP](../../CANONICAL_OWNERSHIP.md), [SESSION_STATE_POLICY](../../SESSION_STATE_POLICY.md): 상태·소유권 범위
- [WORKFLOW_CONTRACT](../../../public/WORKFLOW_CONTRACT.md): 공개 workflow와 내부 준비 상태 구분
- [coverage-matrix](../../e2e/coverage-matrix.md): 28개 실제 예정 프로필 및 결과 귀속
- [automatic-agent-diagnostics](../../automatic-agent-diagnostics.md): trace 범위·export 한계·개선된 연결을 구현 후 반영

원본 문서와 이전 검증 보고서는 이력으로 유지한다. 새 제안 문서가 기존 공식 지침을 이미 대체했다고 주장하지 않는다.
