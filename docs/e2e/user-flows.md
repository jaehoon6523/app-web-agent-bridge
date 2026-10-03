# E2E Closure — 25 profiles

25 profiles 모두 W1–4 COMPLETE. Execution: RUNNABLE 25 / CONTINUATION BLOCKED 0. 각 profile의 실행 증거는 final E2E 결과로 판정한다. 외부 provider/Worker는 controlled peer이며 실제 모델·설치된 Chrome 확장 검증을 뜻하지 않는다. 원격 적용은 별도다.

## UF-01A Fresh startup

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

- Given: 설정 없는 새 workspace
- When: 서버를 실행하고 Dashboard를 연다
- Then: 서버/auth 정상; runtime 준비 필요; 확장 연결 대기; 입력해도 Web action 차단
- Skeleton: `scripts/e2e/startup.mjs`

## UF-01B Configured startup

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

- Given: 확장 secret/identity와 Worker 실행 경로 설정 존재; 미연결
- When: Dashboard를 연다
- Then: 서버/auth/runtime 정상; 확장 연결 대기; 준비 시작 차단
- Skeleton: `scripts/e2e/wave-suite.mjs`

## UF-01C Connected startup

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

- Given: 확장이 인증된 상태; 실행/프로젝트 전제조건은 별도
- When: Dashboard를 연다
- Then: 확장 인증 표시; runtime/Worker 등 나머지 전제조건을 충족한 action만 활성
- Skeleton: `scripts/e2e/wave-suite.mjs`
- 미완: 없음: profile continuation 구현 및 검증

## UF-02 Runtime degraded

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

- Given: 확장 configured; artifact 디렉터리 생성이 실패
- When: Dashboard를 열고 상태 상세를 확인한다
- Then: 서버/auth 정상; runtime 준비 필요; local 폴더 선택 유지; runtime 의존 시작 차단
- Skeleton: `scripts/e2e/wave-suite.mjs`

## UF-03 Extension disconnected

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

- Given: 서버/auth/runtime 정상; 확장 configured지만 WebSocket disconnected
- When: Dashboard를 열고 목표/폴더를 입력한다
- Then: 확장 연결 대기; Web action 차단; 폴더 선택 유지; runtime 정상 유지
- Skeleton: `scripts/e2e/wave-suite.mjs`

## UF-04 Extension connect

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

- Given: 서버 실행; 확장 설정 존재; 미인증
- When: 확장에서 연결을 시작한다
- Then: challenge/auth 완료 후 확장 인증 표시; 다른 장애를 정상으로 덮지 않음
- Skeleton: `scripts/e2e/wave-suite.mjs`
- 미완: 없음: profile continuation 구현 및 검증

## UF-05 Preparation start

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

- Given: 확장 인증; 준비 시작 capability 충족; 유효한 프로젝트 폴더
- When: 목표/폴더 입력 후 준비 대화 시작을 클릭한다
- Then: 요구사항 정리 화면; 응답 summary/질문/기준 표시; delivery 귀속; 자동 승인 profile은 별도
- Skeleton: `scripts/e2e/wave-suite.mjs`
- 미완: 없음: profile continuation 구현 및 검증

## UF-06 Preparation revise

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

- Given: 합의 제안이 표시되고 같은 preparation context가 ACTIVE
- When: proposalFeedback 입력 후 답변 보내기를 클릭한다
- Then: 같은 목표/폴더/대화 유지; 새로운 응답 표시; 대기 중 중복 reply 차단
- Skeleton: `scripts/e2e/wave-suite.mjs`
- 미완: 없음: profile continuation 구현 및 검증

## UF-07 Approve to Worker

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

- Given: 합의 완료; unresolved 질문 없음; 명시적 승인 profile
- When: 합의 승인하고 작업 시작을 클릭한다
- Then: Worker 작업 화면; 승인한 기준과 run 연결; 자동 적용 없음
- Skeleton: `scripts/e2e/wave-suite.mjs`
- 미완: 없음: profile continuation 구현 및 검증

## UF-08 Candidate independent review

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

- Given: Worker 완료; candidate와 evidence 고정
- When: 자동 검토 진행과 결과를 확인한다
- Then: 같은 candidate에 Judge/Critic 결과; provider/역할 구분; 판정 전 적용 차단
- Skeleton: `scripts/e2e/wave-suite.mjs`
- 미완: 없음: profile continuation 구현 및 검증

## UF-09 Rework

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

- Given: candidate 검토에 필수 미해결 finding 존재
- When: 수정·재검토 진행을 확인한다
- Then: REWORK 단계 및 finding 이력; 새 candidate; 재검토 전 적용 금지
- Skeleton: `scripts/e2e/wave-suite.mjs`
- 미완: 없음: profile continuation 구현 및 검증

## UF-10 Pass and explicit apply

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

- Given: schema v3 독립 검토 PASS; AWAITING_APPLY; target base 동일
- When: Apply 전 target를 확인한 뒤 적용 버튼을 클릭한다
- Then: PASS는 아직 미적용; 클릭 후 APPLIED; 승인 candidate만 실제 target에 반영
- Skeleton: `scripts/e2e/wave-suite.mjs`
- 미완: 없음: profile continuation 구현 및 검증

## UF-11 Restart recovery

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

- Given: preparation 또는 run 진행; receipt가 persist됨
- When: 서버 종료 후 같은 workspace에서 재시작하고 Dashboard를 연다
- Then: 작업/context 복구; 불확실 delivery 복구 필요; 자동 재전송 없음
- Skeleton: `scripts/e2e/wave-suite.mjs`
- 미완: 없음: profile continuation 구현 및 검증

## UF-12 Stale binding

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

- Given: 전송이 가능한 정확한 tab/document binding
- When: provider tab을 reload/navigation 후 재전송과 rebind를 시도한다
- Then: 과거 document에 send 없음; binding 복구 안내; 선택한 tab에만 명시적 rebind
- Skeleton: `scripts/e2e/wave-suite.mjs`
- 미완: 없음: profile continuation 구현 및 검증

## UF-13 State degradation

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

- Given: HTTP 정상; session 정상; preparation SQLite 손상
- When: Dashboard를 열어 실패를 확인하고 손상 파일을 제거해 복구시킨다
- Then: 서버/auth 정상; 상태 조회 실패; 잘못된 server-down 안내 없음; 다음 실제 poll에서 복구
- Skeleton: `scripts/e2e/wave-suite.mjs`

## UF-14 Server transport down

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

- Given: 정상 Dashboard 화면; production process alive
- When: 실제 server process를 종료하고 열린 Dashboard를 관찰한다
- Then: 실제 transport 응답 없음; mutation 차단; 정상 상태를 현재 상태처럼 표시하지 않음
- Skeleton: `scripts/e2e/wave-suite.mjs`

## UF-15 SQLite contention

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

- Given: 실제 준비 mutation 가능; 외부 connection이 SQLite write lock 보유
- When: 준비/reply mutation을 보내고 동시에 독립 API를 조회한다
- Then: wait/retry 동안 서버 UI responsive; deadline 충족; lock 해제 후 dispatch 1회 및 receipt 일치
- Skeleton: `scripts/e2e/wave-suite.mjs`
- 미완: 없음: profile continuation 구현 및 검증

## UF-16 Partial provider failure

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

- Given: Judge provider 정상; Critic provider unavailable; 검토 단계
- When: 역할 상태와 복구 action을 확인한다
- Then: 서버/auth/runtime 전체 장애로 표현 금지; 실패 role 표시; PASS/apply 차단; unrelated action은 capability별 유지
- Skeleton: `scripts/e2e/wave-suite.mjs`
- 미완: 없음: profile continuation 구현 및 검증

## UF-17 Dashboard authentication failure

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

- Given: 서버 정상; 별도 Dashboard credential이 invalid/rejected
- When: 무효 session으로 상태를 조회하고 정상 session으로 다시 연결한다
- Then: 인증 실패/거부 표시; 서버 정상; mutation 차단; 정상 session 이후 복구
- Skeleton: `scripts/e2e/wave-suite.mjs`
- 미완: 없음: profile continuation 구현 및 검증

## UF-18 Reviewer free discussion

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

- Given: candidate 고정; HOLD 또는 AWAITING_APPLY; 역할 대화 capability 충족
- When: 역할과 질문을 선택해 감사자에게 보낸다
- Then: 역할 응답/전송 상태 표시; 자연어만으로 verdict/apply 권한 변경 없음; 미확정 결과는 자동 재전송 없음
- Skeleton: `scripts/e2e/wave-suite.mjs`
- 미완: 없음: profile continuation 구현 및 검증

## UF-19 Operator note and decision

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

- Given: run 존재; 메모 기록 capability 충족
- When: NOTE 또는 DECISION을 선택해 기록한다
- Then: 기록 종류/내용/phase가 목록에 표시; 새로고침 후 유지; 단순 메모가 검토 verdict를 바꾸지 않음
- Skeleton: `scripts/e2e/wave-suite.mjs`
- 미완: 없음: profile continuation 구현 및 검증

## UF-20 Applied follow-up lineage

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

- Given: APPLIED run과 유효한 프로젝트 경로 존재
- When: 같은 폴더에서 이어서 작업을 클릭하고 새 준비를 시작한다
- Then: 폴더 유지; 새 목표; 이전 적용 작업 링크; follow-up lineage와 기준 handoff 유지
- Skeleton: `scripts/e2e/wave-suite.mjs`
- 미완: 없음: profile continuation 구현 및 검증

## UF-21 Archive and restore

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

- Given: settled terminal run; Worker/reviewer busy 아님
- When: 보관 후 history filter에서 조회하고 보관을 해제한다
- Then: 보관 상태와 목록/필터 일치; 해제 후 다시 표시; 적용한 target 코드 변경 없음
- Skeleton: `scripts/e2e/wave-suite.mjs`
- 미완: 없음: profile continuation 구현 및 검증

## UF-22 Cancel and discard preparation

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

- Given: ACTIVE preparation; cancel 가능 상태 또는 unresolved delivery
- When: 취소하거나 확인/사유를 입력하고 명시적으로 전송을 폐기한다
- Then: cancel과 unresolved discard 구분; 이력과 이유 표시; 자동 재전송 없음; 새 작업 조건 갱신
- Skeleton: `scripts/e2e/wave-suite.mjs`
- 미완: 없음: profile continuation 구현 및 검증

## UF-23 Worker live intervention

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

- Given: WORKER_RUNNING; steer 가능한 Worker와 현재 turn 존재
- When: GUIDANCE/QUESTION을 입력해 전달하고 requirements 변경 요청도 확인한다
- Then: 현재 turn에 개입 상태 표시; stale turn/요구사항 변경 차단; 승인 기준 유지
- Skeleton: `scripts/e2e/wave-suite.mjs`
- 미완: 없음: profile continuation 구현 및 검증
