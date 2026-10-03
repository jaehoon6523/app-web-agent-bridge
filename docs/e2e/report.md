# Integrated E2E Closure

기준은 H-REVIEW local tree `c083742deeeeff3143dcd966f58f3595e2fb26f5`이며 원격 HEAD는 `8109fb2a13ba5d8f8345d69880045a5866ed147f`다. 누적 patch와 이번 incremental patch를 구분한다.

25개 명세의 공통 continuation harness를 구현했다. RUNNABLE 선언과 실제 이번 실행 PASS는 구분하며 실제 결과는 `npm run test:e2e`의 observed summary 및 별도 closure evidence bundle을 기준으로 한다.

## 공통 구현

- preparation/Worker/review를 재사용한 finding → frozen plan/work order → candidate B → re-review → explicit Apply.
- 동일 workspace server restart: settled preparation/run, unresolved delivery fail-closed, 새 Dashboard session 및 자동 resend 없음.
- document stale send 거부, ambiguous tab selection, 명시적 UI rebind 후 선택 tab만 send.
- 외부 SQLite writer lock 동안 UI preparation mutation과 독립 API 응답, 정확히 한 번 dispatch/ACK.
- Critic 실제 provider DOM login failure → role-local HOLD → 복구. Judge artifact, runtime, server 보존.
- 실제 rejected Dashboard credential → auth failure render → mutation 차단 → session 재취득.
- reviewer discussion 성공/ambiguous 결과, note/decision, applied follow-up, archive/unarchive, cancel/discard.
- 실제 Codex adapter active turn/steer와 외부 deterministic app-server executable. 승인 requirements 변경 권한을 추가하지 않는다.

## 최소 제품 수정

1. session completion의 `body`를 보존하여 dedicated reasoning artifact bytes/hash/size를 검증한다. `text`, raw response, parsed packet 및 authority boundary를 유지한다.
2. follow-up의 APPLIED 판정은 production raw record의 `stage`와 기존 `phase`를 지원한다.
3. 기존 role binding wait 계약에 `SESSION_AUTH_REQUIRED`를 포함하여 provider 로그인 실패를 역할별 HOLD로 분류한다.

각 수정은 기존 regression test에 production-shaped case를 추가하고 E2E에서 실제 행동을 검증한다. Service 호출/DB seed/합성 Dashboard state/테스트 전용 production branch를 쓰지 않는다.

## 경계

Chrome API와 provider DOM/response, 외부 Worker executable은 controlled peer다. 실제 확장 설치·실제 모델 품질·Windows active executable 경로·전체 fault 공간을 검증했다고 주장하지 않는다. Apply는 승인 candidate tree를 index/worktree에 적용하며 HEAD를 유지하는 현재 제품 계약이다. 원격 push/merge는 하지 않았다.

최종 gate: test:e2e, check, integration, browser, ui, sabotage, diff check 및 binary patch tree roundtrip. 로그와 observed summary는 closure bundle에 포함한다.
