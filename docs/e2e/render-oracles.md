# E2E Closure — 25 profiles

25 profiles 모두 W1–4 COMPLETE. Execution: RUNNABLE 25 / CONTINUATION BLOCKED 0. 각 profile의 실행 증거는 final E2E 결과로 판정한다. 외부 provider/Worker는 controlled peer이며 실제 모델·설치된 Chrome 확장 검증을 뜻하지 않는다. 원격 적용은 별도다.

상태 축 공통 규칙: 서버 도달성 / Dashboard 인증 / runtime / extension / provider를 별도로 판정한다. workflow 객체는 `#startPanel`, `#projectPanel`, `#runPanel` 중 해당 단계의 panel에 표시한다. `enabled`의 조건은 현재 capability와 입력/phase를 함께 충족해야 하며 force-click으로 우회하지 않는다. hidden은 visible=false와 필요한 disabled 상태를 함께 검증한다. 오류 문구는 connectionNotice와 health detail 등 장애 안내 영역에서 검사하며 사용자 입력/과거 기록까지 전역 금지하지 않는다.

Provider readiness는 preflight 설정과 실제 role turn 성공이 다르다. 별도 provider health indicator는 존재하지 않으며 run role 요소가 provider별 상태를 표시한다. 실행하지 않은 role 결과를 정상이라고 판정하지 않는다.

## UF-01A

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

| 상태 축 | 기대값 |
|---|---|
| server | REACHABLE |
| dashboard | AUTHENTICATED |
| runtime | UNAVAILABLE |
| extension | NOT CONFIGURED |
| provider | not exercised |
| workflow | START |

서버/auth 정상; runtime 준비 필요; 확장 연결 대기; 입력해도 Web action 차단

| 구분 | 객체/조건 |
|---|---|
| 관찰 객체 | #startPanel; #apiHealth; #sessionHealth; #engineHealth; #channelHealth |
| 활성 action | #chooseFolder |
| 비활성 action | #planRun; #newRun |
| 숨김 action | #applyCode; #saveProject; #startRun |
| 금지 장애 안내 | 서버 응답 없음; 서버 연결 끊김 |

## UF-01B

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

| 상태 축 | 기대값 |
|---|---|
| server | REACHABLE |
| dashboard | AUTHENTICATED |
| runtime | READY under Given |
| extension | DISCONNECTED |
| provider | not exercised |
| workflow | START |

서버/auth/runtime 정상; 확장 연결 대기; 준비 시작 차단

| 구분 | 객체/조건 |
|---|---|
| 관찰 객체 | #engineHealth; #channelHealth; #startPanel |
| 활성 action | #chooseFolder |
| 비활성 action | #planRun |
| 숨김 action | #applyCode |
| 금지 장애 안내 | 서버 응답 없음; 서버 연결 끊김 |

## UF-01C

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

| 상태 축 | 기대값 |
|---|---|
| server | REACHABLE |
| dashboard | AUTHENTICATED |
| runtime | READY under Given |
| extension | AUTHENTICATED under Given; stale/disconnected tracked separately |
| provider | actual selected role readiness; configuration does not imply success |
| workflow | START |

확장 인증 표시; runtime/Worker 등 나머지 전제조건을 충족한 action만 활성

| 구분 | 객체/조건 |
|---|---|
| 관찰 객체 | #channelHealth; #webSignal; #planRun |
| 활성 action | #chooseFolder |
| 비활성 action | #applyCode |
| 숨김 action | #applyCode |
| 금지 장애 안내 | 서버 응답 없음; 서버 연결 끊김 |

## UF-02

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

| 상태 축 | 기대값 |
|---|---|
| server | REACHABLE |
| dashboard | AUTHENTICATED |
| runtime | UNAVAILABLE |
| extension | actual state/unknown after failed read |
| provider | not exercised |
| workflow | START/degraded |

서버/auth 정상; runtime 준비 필요; local 폴더 선택 유지; runtime 의존 시작 차단

| 구분 | 객체/조건 |
|---|---|
| 관찰 객체 | #apiHealth; #sessionHealth; #engineHealth; #startPanel |
| 활성 action | #chooseFolder |
| 비활성 action | #planRun |
| 숨김 action | #applyCode |
| 금지 장애 안내 | 서버 응답 없음; 서버 연결 끊김 |

## UF-03

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

| 상태 축 | 기대값 |
|---|---|
| server | REACHABLE |
| dashboard | AUTHENTICATED |
| runtime | READY under Given |
| extension | DISCONNECTED |
| provider | not exercised |
| workflow | START |

확장 연결 대기; Web action 차단; 폴더 선택 유지; runtime 정상 유지

| 구분 | 객체/조건 |
|---|---|
| 관찰 객체 | #channelHealth; #engineHealth; #startPanel |
| 활성 action | #chooseFolder |
| 비활성 action | #planRun |
| 숨김 action | #applyCode |
| 금지 장애 안내 | 서버 응답 없음; 서버 연결 끊김 |

## UF-04

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

| 상태 축 | 기대값 |
|---|---|
| server | REACHABLE |
| dashboard | AUTHENTICATED |
| runtime | READY under Given |
| extension | AUTHENTICATED under Given; stale/disconnected tracked separately |
| provider | actual selected role readiness; configuration does not imply success |
| workflow | START after connect |

challenge/auth 완료 후 확장 인증 표시; 다른 장애를 정상으로 덮지 않음

| 구분 | 객체/조건 |
|---|---|
| 관찰 객체 | #channelHealth; #webSignal |
| 활성 action | #chooseFolder |
| 비활성 action | #applyCode |
| 숨김 action | #applyCode |
| 금지 장애 안내 | 서버 응답 없음; 서버 연결 끊김 |

## UF-05

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

| 상태 축 | 기대값 |
|---|---|
| server | REACHABLE |
| dashboard | AUTHENTICATED |
| runtime | READY under Given |
| extension | AUTHENTICATED under Given; stale/disconnected tracked separately |
| provider | actual selected role readiness; configuration does not imply success |
| workflow | PREPARE |

요구사항 정리 화면; 응답 summary/질문/기준 표시; delivery 귀속; 자동 승인 profile은 별도

| 구분 | 객체/조건 |
|---|---|
| 관찰 객체 | #projectPanel; #proposalStatus; #proposalSummary; #projectRequirements |
| 활성 action | #reloadProject |
| 비활성 action | #saveProject (합의 전) |
| 숨김 action | #applyCode |
| 금지 장애 안내 | 서버 응답 없음; 서버 연결 끊김 |

## UF-06

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

| 상태 축 | 기대값 |
|---|---|
| server | REACHABLE |
| dashboard | AUTHENTICATED |
| runtime | READY under Given |
| extension | AUTHENTICATED under Given; stale/disconnected tracked separately |
| provider | actual selected role readiness; configuration does not imply success |
| workflow | PREPARE |

같은 목표/폴더/대화 유지; 새로운 응답 표시; 대기 중 중복 reply 차단

| 구분 | 객체/조건 |
|---|---|
| 관찰 객체 | #projectPanel; #proposalSummary; #projectRequirements; #proposalStatus |
| 활성 action | #reviseRequirements (settled + 입력 후) |
| 비활성 action | #reviseRequirements (진행 중) |
| 숨김 action | #applyCode |
| 금지 장애 안내 | 서버 응답 없음; 서버 연결 끊김 |

## UF-07

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

| 상태 축 | 기대값 |
|---|---|
| server | REACHABLE |
| dashboard | AUTHENTICATED |
| runtime | READY under Given |
| extension | AUTHENTICATED under Given; stale/disconnected tracked separately |
| provider | actual selected role readiness; configuration does not imply success |
| workflow | WORK |

Worker 작업 화면; 승인한 기준과 run 연결; 자동 적용 없음

| 구분 | 객체/조건 |
|---|---|
| 관찰 객체 | #runPanel; #runObjective; #runStatus; #workerProvenance |
| 활성 action | #stopRun (capability 있을 때) |
| 비활성 action | #applyCode |
| 숨김 action | #saveProject |
| 금지 장애 안내 | 서버 응답 없음; 서버 연결 끊김 |

## UF-08

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

| 상태 축 | 기대값 |
|---|---|
| server | REACHABLE |
| dashboard | AUTHENTICATED |
| runtime | READY under Given |
| extension | AUTHENTICATED under Given; stale/disconnected tracked separately |
| provider | actual selected role readiness; configuration does not imply success |
| workflow | REVIEW |

같은 candidate에 Judge/Critic 결과; provider/역할 구분; 판정 전 적용 차단

| 구분 | 객체/조건 |
|---|---|
| 관찰 객체 | #candidateDetails; #assessments; #evidenceList; #runJudgeRole; #runCriticRole |
| 활성 action | #exportEvidence (capability 있을 때) |
| 비활성 action | #applyCode (판정 전) |
| 숨김 action | #saveProject |
| 금지 장애 안내 | 서버 응답 없음; 서버 연결 끊김 |

## UF-09

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

| 상태 축 | 기대값 |
|---|---|
| server | REACHABLE |
| dashboard | AUTHENTICATED |
| runtime | READY under Given |
| extension | AUTHENTICATED under Given; stale/disconnected tracked separately |
| provider | actual selected role readiness; configuration does not imply success |
| workflow | REWORK → REVIEW |

REWORK 단계 및 finding 이력; 새 candidate; 재검토 전 적용 금지

| 구분 | 객체/조건 |
|---|---|
| 관찰 객체 | #runStatus; #findings; #candidateDetails; #assessments |
| 활성 action | #stopRun (capability 있을 때) |
| 비활성 action | #applyCode (재검토 전) |
| 숨김 action | #saveProject |
| 금지 장애 안내 | 서버 응답 없음; 서버 연결 끊김 |

## UF-10

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

| 상태 축 | 기대값 |
|---|---|
| server | REACHABLE |
| dashboard | AUTHENTICATED |
| runtime | READY under Given |
| extension | AUTHENTICATED under Given; stale/disconnected tracked separately |
| provider | actual selected role readiness; configuration does not imply success |
| workflow | AWAITING_APPLY → APPLIED |

PASS는 아직 미적용; 클릭 후 APPLIED; 승인 candidate만 실제 target에 반영

| 구분 | 객체/조건 |
|---|---|
| 관찰 객체 | #applyCode; #runStatus; #candidateDetails |
| 활성 action | #applyCode (PASS 및 capability 충족) |
| 비활성 action | #applyCode (적용 중/후) |
| 숨김 action | #saveProject |
| 금지 장애 안내 | 서버 응답 없음; 서버 연결 끊김 |

## UF-11

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

| 상태 축 | 기대값 |
|---|---|
| server | REACHABLE |
| dashboard | AUTHENTICATED |
| runtime | READY under Given |
| extension | AUTHENTICATED under Given; stale/disconnected tracked separately |
| provider | actual selected role readiness; configuration does not imply success |
| workflow | recovered stage / RECOVERY_REQUIRED |

작업/context 복구; 불확실 delivery 복구 필요; 자동 재전송 없음

| 구분 | 객체/조건 |
|---|---|
| 관찰 객체 | #runList; #proposalStatus; #preparationException; #runStatus |
| 활성 action | #reloadProject |
| 비활성 action | #saveProject (복구 전); #applyCode (권한 복구 전) |
| 숨김 action | #startRun |
| 금지 장애 안내 | 서버 응답 없음; 서버 연결 끊김 |

## UF-12

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

| 상태 축 | 기대값 |
|---|---|
| server | REACHABLE |
| dashboard | AUTHENTICATED |
| runtime | READY under Given |
| extension | AUTHENTICATED under Given; stale/disconnected tracked separately |
| provider | actual selected role readiness; configuration does not imply success |
| workflow | PREPARE + NEEDS_REBIND/recovery |

과거 document에 send 없음; binding 복구 안내; 선택한 tab에만 명시적 rebind

| 구분 | 객체/조건 |
|---|---|
| 관찰 객체 | #preparationException; #webBindingSignal; #preparationDiagnosticsBody |
| 활성 action | web.rebind (eligible tab 있을 때) |
| 비활성 action | #reviseRequirements (stale) |
| 숨김 action | #applyCode |
| 금지 장애 안내 | 서버 응답 없음; 서버 연결 끊김 |

## UF-13

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

| 상태 축 | 기대값 |
|---|---|
| server | REACHABLE |
| dashboard | AUTHENTICATED |
| runtime | UNKNOWN/current state not assumed |
| extension | actual state/unknown after failed read |
| provider | not exercised |
| workflow | state unknown → recovered START |

서버/auth 정상; 상태 조회 실패; 잘못된 server-down 안내 없음; 다음 실제 poll에서 복구

| 구분 | 객체/조건 |
|---|---|
| 관찰 객체 | #apiHealth; #sessionHealth; #refreshSignal; #connectionNotice |
| 활성 action | #chooseFolder (서버/auth 전제만 충족) |
| 비활성 action | #planRun |
| 숨김 action | #applyCode |
| 금지 장애 안내 | 서버 응답 없음; 서버 연결 끊김 |

## UF-14

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

| 상태 축 | 기대값 |
|---|---|
| server | UNREACHABLE |
| dashboard | AUTHENTICATED before transport loss |
| runtime | UNKNOWN/current state not assumed |
| extension | actual state/unknown after failed read |
| provider | not exercised |
| workflow | last known phase stale |

실제 transport 응답 없음; mutation 차단; 정상 상태를 현재 상태처럼 표시하지 않음

| 구분 | 객체/조건 |
|---|---|
| 관찰 객체 | #apiHealth; #serverSignal; #connectionNotice |
| 활성 action | 없음 |
| 비활성 action | #chooseFolder; #planRun; #applyCode |
| 숨김 action | #saveProject |
| 금지 장애 안내 | 없음 |

## UF-15

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

| 상태 축 | 기대값 |
|---|---|
| server | REACHABLE |
| dashboard | AUTHENTICATED |
| runtime | READY under Given |
| extension | AUTHENTICATED under Given; stale/disconnected tracked separately |
| provider | actual selected role readiness; configuration does not imply success |
| workflow | PREPARE mutation waiting |

wait/retry 동안 서버 UI responsive; deadline 충족; lock 해제 후 dispatch 1회 및 receipt 일치

| 구분 | 객체/조건 |
|---|---|
| 관찰 객체 | #proposalStatus; #preparationPersistence; #apiHealth |
| 활성 action | #reloadProject |
| 비활성 action | #reviseRequirements (mutation 진행 중) |
| 숨김 action | #applyCode |
| 금지 장애 안내 | 서버 응답 없음; 서버 연결 끊김 |

## UF-16

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

| 상태 축 | 기대값 |
|---|---|
| server | REACHABLE |
| dashboard | AUTHENTICATED |
| runtime | READY under Given |
| extension | AUTHENTICATED under Given; stale/disconnected tracked separately |
| provider | Critic unavailable; Judge actual state |
| workflow | HOLD with role failure |

서버/auth/runtime 전체 장애로 표현 금지; 실패 role 표시; PASS/apply 차단; unrelated action은 capability별 유지

| 구분 | 객체/조건 |
|---|---|
| 관찰 객체 | #runJudgeRole; #runCriticRole; #runStatus; #apiHealth |
| 활성 action | #exportEvidence (capability 있을 때) |
| 비활성 action | #applyCode |
| 숨김 action | #saveProject |
| 금지 장애 안내 | 서버 응답 없음; 서버 연결 끊김 |

## UF-17

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

| 상태 축 | 기대값 |
|---|---|
| server | REACHABLE |
| dashboard | AUTH_INVALID/REJECTED |
| runtime | UNKNOWN/current state not assumed |
| extension | actual state/unknown after failed read |
| provider | not exercised |
| workflow | state unknown until authenticated |

인증 실패/거부 표시; 서버 정상; mutation 차단; 정상 session 이후 복구

| 구분 | 객체/조건 |
|---|---|
| 관찰 객체 | #apiHealth; #sessionHealth; #connectionNotice |
| 활성 action | 없음 |
| 비활성 action | #chooseFolder; #planRun |
| 숨김 action | #applyCode |
| 금지 장애 안내 | 서버 응답 없음; 서버 연결 끊김 |

## UF-18

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

| 상태 축 | 기대값 |
|---|---|
| server | REACHABLE |
| dashboard | AUTHENTICATED |
| runtime | READY under Given |
| extension | AUTHENTICATED under Given; stale/disconnected tracked separately |
| provider | actual selected role readiness; configuration does not imply success |
| workflow | HOLD/AWAITING_APPLY unchanged |

역할 응답/전송 상태 표시; 자연어만으로 verdict/apply 권한 변경 없음; 미확정 결과는 자동 재전송 없음

| 구분 | 객체/조건 |
|---|---|
| 관찰 객체 | #reviewDiscussionPanel; #reviewDiscussionStatus; #conversationPanel |
| 활성 action | #sendReviewDiscussion (settled 및 입력) |
| 비활성 action | #sendReviewDiscussion (unconfirmed) |
| 숨김 action | #saveProject |
| 금지 장애 안내 | 서버 응답 없음; 서버 연결 끊김 |

## UF-19

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

| 상태 축 | 기대값 |
|---|---|
| server | REACHABLE |
| dashboard | AUTHENTICATED |
| runtime | READY under Given |
| extension | AUTHENTICATED under Given; stale/disconnected tracked separately |
| provider | actual selected role readiness; configuration does not imply success |
| workflow | current phase unchanged |

기록 종류/내용/phase가 목록에 표시; 새로고침 후 유지; 단순 메모가 검토 verdict를 바꾸지 않음

| 구분 | 객체/조건 |
|---|---|
| 관찰 객체 | #operatorNotePanel; #operatorNoteList; #operatorNoteStatus |
| 활성 action | #addOperatorNote (입력 및 capability) |
| 비활성 action | #addOperatorNote (빈 입력) |
| 숨김 action | #saveProject |
| 금지 장애 안내 | 서버 응답 없음; 서버 연결 끊김 |

## UF-20

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

| 상태 축 | 기대값 |
|---|---|
| server | REACHABLE |
| dashboard | AUTHENTICATED |
| runtime | READY under Given |
| extension | AUTHENTICATED under Given; stale/disconnected tracked separately |
| provider | actual selected role readiness; configuration does not imply success |
| workflow | APPLIED → new PREPARE |

폴더 유지; 새 목표; 이전 적용 작업 링크; follow-up lineage와 기준 handoff 유지

| 구분 | 객체/조건 |
|---|---|
| 관찰 객체 | #startPanel; #planningFollowUp; #openFollowUp |
| 활성 action | #continueProject (APPLIED) |
| 비활성 action | #continueProject (미적용) |
| 숨김 action | #applyCode (새 준비) |
| 금지 장애 안내 | 서버 응답 없음; 서버 연결 끊김 |

## UF-21

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

| 상태 축 | 기대값 |
|---|---|
| server | REACHABLE |
| dashboard | AUTHENTICATED |
| runtime | READY under Given |
| extension | AUTHENTICATED under Given; stale/disconnected tracked separately |
| provider | actual selected role readiness; configuration does not imply success |
| workflow | terminal phase unchanged |

보관 상태와 목록/필터 일치; 해제 후 다시 표시; 적용한 target 코드 변경 없음

| 구분 | 객체/조건 |
|---|---|
| 관찰 객체 | #archiveRun; #runList; #historyStatusFilter |
| 활성 action | #archiveRun (settled terminal) |
| 비활성 action | #archiveRun (active) |
| 숨김 action | #saveProject |
| 금지 장애 안내 | 서버 응답 없음; 서버 연결 끊김 |

## UF-22

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

| 상태 축 | 기대값 |
|---|---|
| server | REACHABLE |
| dashboard | AUTHENTICATED |
| runtime | READY under Given |
| extension | AUTHENTICATED under Given; stale/disconnected tracked separately |
| provider | actual selected role readiness; configuration does not imply success |
| workflow | cancel/discard lifecycle projection |

cancel과 unresolved discard 구분; 이력과 이유 표시; 자동 재전송 없음; 새 작업 조건 갱신

| 구분 | 객체/조건 |
|---|---|
| 관찰 객체 | #projectPanel; #preparationException; #proposalStatus; #discardDeliveryButton |
| 활성 action | #discardDeliveryButton (확인 및 사유 충족) |
| 비활성 action | #discardDeliveryButton (미확인) |
| 숨김 action | #applyCode |
| 금지 장애 안내 | 서버 응답 없음; 서버 연결 끊김 |

## UF-23

Spec/Wave: **W1-4 COMPLETE** · Execution: **RUNNABLE**

| 상태 축 | 기대값 |
|---|---|
| server | REACHABLE |
| dashboard | AUTHENTICATED |
| runtime | READY under Given |
| extension | AUTHENTICATED under Given; stale/disconnected tracked separately |
| provider | actual selected role readiness; configuration does not imply success |
| workflow | WORKER_RUNNING unchanged |

현재 turn에 개입 상태 표시; stale turn/요구사항 변경 차단; 승인 기준 유지

| 구분 | 객체/조건 |
|---|---|
| 관찰 객체 | #workerInterventionPanel; #workerInterventionStatus; #workerProvenance |
| 활성 action | #sendWorkerIntervention (steer 지원 및 입력) |
| 비활성 action | #sendWorkerIntervention (stale/지원 없음) |
| 숨김 action | #saveProject |
| 금지 장애 안내 | 서버 응답 없음; 서버 연결 끊김 |
