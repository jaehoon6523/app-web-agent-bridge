# 대시보드 상태·권한 계약 대조

기준 HEAD는 `bef58bccead1f9a205ae9044940655044dabe304`, 브랜치는 `forensics-20261110`이다. 종료 작업을 시작할 때 추적 파일 수정 36개와 미추적 파일 4개가 있었다. 이번 작업의 시작 상태는 별도 스냅샷에 남겼다. 현행 대시보드에서 사용자가 호출하는 기능 34개를 집계했다. 동일한 `run.delete`의 코드 변경·구형 대화 처리기는 한 행에서 각각 확인했다. 조회·시스템용 별칭과 구형 API 전용 명령은 아래에 별도로 기록했다.

대조 경계는 일곱 개다. ① 영속·런타임 원본 → 서버 투영 ② 투영 → HTTP 응답 ③ 응답 → 계약 검증·정규화 ④ 정규 상태 → 기능 가용성 ⑤ 가용성 → DOM ⑥ 사용자 동작과 요청 → 서버 최종 검증 ⑦ 명령 결과·영수증 → 재조회·화면 갱신. 각 행은 해당 기능에 적용되는 경계를 코드로 따라갔으며, 동작 증거는 기존 테스트와 이번 표적 검증 범위를 구분했다.

## 공통 호출 경로

- [HTTP 라우트](../src/server.js) → [DashboardController.snapshot](../src/orchestration/dashboard-controller.js) 및 [PreparationService.project](../src/orchestration/preparation-service.js) → [normalizeDashboardState](../public/dashboard-model.js) → [가용성 투영](../public/dashboard-action-capabilities.js)·[시작 가용성](../public/dashboard-start-actions.js) → [대시보드 DOM](../public/app.js). 시작·프로젝트 화면은 전역 `activePreparation`과 조회 가능한 실행 목록을 사용한다. 선택한 실행의 준비 기록은 별도로 표시된다.
- 실행 명령은 `workflow.runId`·`workflow.runVersion`과 요청 ID를 보낸다. 서버는 실행 버전을 확인한 뒤 대상별 명령을 처리한다. 후보·검토·패치·Worker turn·전송·탭 ID는 각 명령의 별도 입력이다. 준비 변경은 준비 ID와 표시된 버전을 사용한다. Web 작업은 세션·대화·전송 ID도 비교한다. 초기 시작은 아직 준비 ID가 없다.
- 상태 요청의 순번과 선택 대상을 응답 적용 전에 확인한다. 현행 런타임 맵은 구형 Judge 필드보다 우선하며 명시적 `null`을 보존한다. `id/status` 별칭을 정규화한 뒤 workflow와 실행 ID·버전을 비교한다. 로딩이나 상태 검증 실패 중에는 서버 변경 명령이 비활성화된다.

## 명령별 판정

**일치**는 표에 적은 상태와 입력에 대해 대조한 조건이 일치한다는 뜻이다. 현재 실행 전용 외부 검증 및 동시 상태 변경으로 발생하는 정상 충돌은 별도다. **수정**은 불일치에 연결된 변경을 포함한다. **보류**는 양쪽 동작의 차이가 확인됐으나 별도의 정책이 필요한 항목이다.

| # | 명령 또는 사용자 기능 | 판정 | 조건 및 대조 근거 |
| --- | --- | --- | --- |
| 1 | `preparation.start` | 수정 | 직접 호출도 활성 준비가 있으면 거절한다. 신규 준비가 이전 소유자를 가리는 경로를 제거했다. 이전 DB에서 종료 기록을 가리키는 `currentId` 아래에 활성 기록이 남으면 그 기록을 다시 투영한다. 격리 SQLite에서 최초 실패, 재시작 후 차단 및 명시적으로 닫은 뒤 정상 생성 확인. |
| 2 | `preparation.reply` | 수정 | 같은 준비 ID와 화면 버전, 답변 본문을 전달한다. 서버는 활성 전송이 없을 때 같은 세션을 사용한다. 이전 버전은 응답 예약 전에 거부한다. |
| 3 | `preparation.approve` | 수정 | 수동·자동 승인 모두 화면 버전을 전달한다. 서버는 준비 가능 상태와 시작 조건을 확인하고 버전을 비교한 뒤 실행을 만든다. 재시작과 같은 요청 ID의 재조회에선 결과를 재사용한다. |
| 4 | `preparation.cancel` | 수정 | 준비 ID와 버전을 비교한다. 로컬 취소와 내구성 있는 응답의 ACK가 필요한 취소는 기존 가용성 계약이 구분한다. |
| 5 | `preparation.discard` | 수정 | 준비·버전과 화면에 표시한 전송 ID를 보낸다. 대상 전송이 바뀌면 확인을 초기화한다. 서버가 같은 전송과 확장 소유권을 확인한 뒤에만 폐기한다. |
| 6 | `web.inspect` | 일치 | 세션·대화·전송을 지정한다. 새 관측을 표시할 수 있고, 재전송이나 자동 ACK를 수행하는 명령은 아니다. |
| 7 | `web.focus` | 미확정 | UF-22에서 Chromium DOM → 실제 HTTP → 인증 확장 프로토콜 → 올바른 탭과 창 API 호출을 확인했다. 창 API는 제어 fixture이고 운영 Chrome 확장과 Windows 전경 전환은 미검증이다. |
| 8 | `web.stop` | 수정 | 화면 버전과 정확한 전송 ID를 사용한다. 가용성에는 `canStop`이 필요하며 실행 시 같은 전송의 생성 상태를 다시 확인한다. |
| 9 | `web.reconcile` | 수정 | 화면 버전과 세션·대화·전송 ID를 함께 보낸다. 준비 서비스와 DOM 테스트에서 저장된 응답 복구·ACK와 재전송 금지를 대조했다. |
| 10 | `web.rebind` | 일치 | 전송 전 실패로 확인된 준비의 기록된 후보 tab ID만 선택할 수 있다. 다시 연결한 대상의 세션·대화와 예약 상태를 확인한 뒤 재개한다. |
| 11 | 준비 후보 `tab-focus` | 미확정 | UF-24에서 후보 탭 ID의 HTTP 200, 정확한 탭·창 API 호출, 준비 버전·전송 원본 유지 및 무전송 확인. 제어 fixture의 탭을 전면에 올렸다. 실제 Chrome 확장 권한과 Windows 전경 창은 미검증이다. |
| 12 | 프로젝트 폴더 선택 | 미확정 | 격리 HTTP에서 Windows PowerShell 자식과 네이티브 선택 창을 확인했다. HTTP 200으로 경로가 반환됐다. 창이 자동화 목록에 나오지 않아 지정한 임시 폴더 선택과 취소, DOM 반영은 확인하지 못했다. |
| 13 | `run.stop` | 일치 | 서버와 화면의 실행 대상·버전이 일치한다. 코드 변경의 종료·적용 중 상태는 제외한다. 종료를 확인하지 못한 경우 취소 완료 대신 복구 상태가 된다. |
| 14 | `run.retry` | 일치 | 종료된 Worker의 후보 생성 전 타임아웃과 작업·Worker 소유권을 투영 및 실행에서 확인한다. 실행 단계에서 대상 HEAD도 검사한다. |
| 15 | `code.review.retry` | 수정 | 다른 감사자 turn이 바쁠 때 투영과 실행에서 모두 막는다. `HOLD`, 기존 단일 감사의 `AWAITING_APPLY`, ACK 복구의 `RECOVERY_REQUIRED`에서 서버가 허용한 재시도를 표시한다. |
| 16 | `code.decision.reply` | 수정 | 재감사와 동일한 작업·Worker·감사자 소유권을 사용한다. 결정 대기와 요청 항목 ID·답변 수·길이는 전용 검증을 유지한다. |
| 17 | `code.review.discuss` | 일치 | 역할별 정규화 런타임, provider 일치, 확정 대화, 후보, 미확정 전송 부재를 확인한다. 구형 Judge 값은 Critic에 사용하지 않는다. |
| 18 | `code.review.discuss.discard` | 일치 | 미확정 discussion ID와 역할의 활성 전송 일치, 확인과 사유가 필요하다. 서비스 회귀가 미확정 전송의 자동 재전송 금지를 확인한다. |
| 19 | `code.review.rebind` | 일치 | 복구 대상 역할과 후보 탭의 provider·tab ID를 같은 실행에서 대조한다. 잘못된 후보·provider 거부와 재연결 후 재감사를 서비스 회귀에서 확인한다. |
| 20 | `code.worker.intervene` | 수정 | 진단 이벤트의 turn ID와 영속 실행의 현재 turn을 구분한다. 현재 실행 ID·버전·turn으로 보내고 전달 결과와 새 버전을 다시 읽는다. |
| 21 | `run.note.add` | 수정 | 실행 ID·버전, 메모 종류와 본문을 검증한다. 메모는 실행에 귀속되며 승인 권한을 바꾸지 않는다. 늦은 실패·영수증은 다른 실행에 표시하지 않는다. UF-19에서 명령 UUID와 HTTP 관측 ID, SQLite 영수증, 영속 메모, 후속 DOM을 연결했다. |
| 22 | `run.reconcile` | 수정 | 실행 ID·버전으로 진단한다. 응답의 후속 감사 명령은 권한 투영과 같은 활성 작업 판정을 사용한다. 결과가 외부 종료를 승인하지 않는다. |
| 23 | `run.abandon` | 일치 | 복구 상태, 정지한 작업·Worker, 외부 종료 및 대상 검사에 대한 확인을 요구한다. 상태를 바꾸며 대상 저장소에는 적용하지 않는다. |
| 24 | `run.archive` | 일치 | 종료·작업·Worker·해당 감사자 turn·보관 상태를 비교한다. 영속 이력과 근거를 유지한다. |
| 25 | `run.unarchive` | 일치 | 보관 상태에서만 복원하며 나머지 안정성 조건을 보관·삭제와 공유한다. |
| 26 | `run.delete` | 수정 | 코드 변경의 정리·이력 삭제 경로와 구형 대화의 처리 작업을 별도로 대조했다. 구형 대화도 작업 해제 전에는 권한을 내보내지 않는다. 늦은 성공 응답은 사용자가 이후에 선택한 화면을 바꾸지 않는다. |
| 27 | `code.apply` | 일치 | 화면과 명령의 후보 ID·감사 ID·패치 해시·base commit을 비교한다. 최종 적용은 감사 독립성·근거·manifest·대상 HEAD를 재검증한다. |
| 28 | `evidence.export` | 일치 | 현재 실행 ID·버전의 근거를 읽는다. 선택 대상과 다운로드 흐름, 구형 대화의 기록 내보내기를 코드와 기존 회귀에서 대조했다. |
| 29 | `evidence.get` | 일치 | UF-19의 Chromium DOM에서 선택 근거 ID·실행 버전·요청 범위를 실제 HTTP 결과와 발췌 대화상자까지 확인했다. 0행 시작은 HTTP 400이다. 다중 페이지 이동과 실행 도중 삭제는 검증 범위 밖이다. |
| 30 | `delivery-review` 조회 | 일치 | 전송·세션·실행·대화의 네 값으로 소유권을 확인한다. `MATCHED`, `MISMATCH`, `MISSING`을 구분하며 세션 만료 때 읽기만 다시 시도한다. |
| 31 | `delivery-review/ack` | 수정 | 소유권·저장 응답·다른 활성 전송의 차단 조건을 서버 조회와 처리기가 공유한다. 성공 표시는 영속 ACK와 확장 영수증을 재조회한 뒤에만 한다. |
| 32 | `delivery-review/discard` | 일치 | 같은 소유권과 응답 증거, 활성 상태, 사용자 확인을 대조한다. 처리 후 영속 기록과 확장 영수증을 재조회한다. |
| 33 | `extension-pairing` 조회 | 일치 | 대시보드 인증 후 검증된 후보와 현재 연결 대상, 인증 상태를 읽는다. 후보가 승인 가능하다는 판정은 별도 필드로 표시한다. |
| 34 | `extension-pairing` 승인 | 수정 | 후보뿐 아니라 다른 활성 전송·ACK 대기·작업이 없는지를 조회와 처리기가 같은 조건으로 확인한다. 승인은 현재 대상·후보와 사용자 확인을 재검증한다. |

집계는 일치 16개, 수정 15개, 보류 0개, 미확정 3개다. 준비 생성과 늦은 메모 영수증의 화면 귀속을 수정했고, 근거 발췌의 기본 조회와 잘못된 범위를 실행했다. 영수증 귀속은 `run.note.add`로 재현한 공통 명령 경계다.

### 구형 API 및 보조 경로

`state.get`은 대시보드가 사용하는 GET 상태 조회의 내부 명령 별칭이다. `run.start`는 서버의 내부 실행·격리 테스트에서 사용되며 사용자 HTTP 경로는 준비 승인 우회를 막는다. 기존 대화의 `run.pause`, `run.resume`, `run.interrupt`, `run.steer`, `web.session.focus`, `web.session.rebind`도 서버 목록과 처리기를 확인했다. 현재 DOM에 전용 조작이 없어 전체 판정은 미확정이다. 예를 들어 legacy Web 재연결은 투영이 유휴 상태만 보지만 실행은 실제 세션과 전송 바인딩까지 요구한다. 진단 내보내기와 프로젝트 설정 조회는 보조 읽기이며 명령 가용성 집계에서 제외했다.

## 확인된 최초 불일치

| 경계 | 재현된 차이 | 수정 파일 |
| --- | --- | --- |
| 정규 상태 → 명령 대상 | `worker-live` v4에서 기록의 현재 turn은 `turn-1`, 늦은 진단 값은 `previous-turn`이었다. 이전 화면은 후자를 보냈다. | [app.js](../public/app.js) |
| 요청 → 서버 검증 | 준비 `p1` v3을 표시하면서 `expectedVersion`을 생략했다. 서비스는 이전 버전의 승인·답변·취소까지 수락했다. 동일한 버전 전달과 검증을 Web 복구 변경에도 사용한다. | [app.js](../public/app.js), [preparation-service.js](../src/orchestration/preparation-service.js) |
| DOM의 확인 대상 → 요청 | 준비의 이전 전송을 확인한 뒤 현재 전송이 바뀌어도 확인값이 유지됐고, 서버는 요청에서 그 전송을 식별할 수 없었다. | [app.js](../public/app.js), [preparation-service.js](../src/orchestration/preparation-service.js) |
| 원본 소유권 → API 권한·복구 진단 | 다른 감사자 turn이 활성인 같은 실행 버전에서 재시도 권한과 복구 진단의 후속 재시도가 제공됐으나 실행기는 바쁨을 검사했다. | [code-change-service.js](../src/orchestration/code-change-service.js) |
| 권한 → DOM | `AWAITING_APPLY`의 구형 감사 업그레이드와 `RECOVERY_REQUIRED`의 ACK 복구에 `code.review.retry`가 있어도 화면은 이를 사용할 수 없었다. | [app.js](../public/app.js) |
| 결과 영수증 → API | `stale-stop`의 HTTP 409와 `RUN_VERSION_CONFLICT`가 저장됐는데, 조회는 영수증의 영속화 완료를 실행 성공으로 해석했다. | [server.js](../src/server.js), [app.js](../public/app.js) |
| 소유권 관측 → ACK 가용성 | 다른 활성 전송이나 해당 실행 작업이 있을 때 서버가 ACK를 거부했지만 화면에서는 클릭 가능했다. | [delivery-recovery-actions.js](../src/orchestration/delivery-recovery-actions.js), [delivery-recovery.js](../public/delivery-recovery.js) |
| 원본 작업 상태 → API 권한 | 구형 대화가 종료 단계에 들어갔어도 종료 처리 작업이 남아 있으면 삭제가 거부된다. 이전 투영은 종료 단계만 확인했다. | [dashboard-controller.js](../src/orchestration/dashboard-controller.js) |
| 늦은 명령 결과 → 화면 선택 | 실행 A 삭제 응답이 사용자가 이후 선택한 실행 B를 초기화했다. | [app.js](../public/app.js) |
| 소유권 → 연결 승인 조회 | 검증된 후보가 있으면 화면이 승인할 수 있었지만 실행기는 활성 소유권 때문에 거절했다. | [server.js](../src/server.js), [extension-pairing.js](../public/extension-pairing.js) |

## 기존 추적의 관측 범위

- [기존 10단계 Process 테스트](../tests/public/dashboard-io-depth.test.js)는 `run.stop`의 원본 ID·버전, 정규화, workflow, 대역 DOM, POST 본문까지 연결한다. 마지막 요청의 응답은 테스트 대역이 제공하므로 실제 처리기의 가용성이나 영속 결과를 증명하지 않는다. Worker 표적 테스트는 이 공백을 메워 실제 컨트롤러 결과를 다시 화면으로 공급했다.
- [서버 관측기](../src/diagnostics/server-observer.js)의 HTTP `requestId`는 서버 관측 번호다. 브라우저의 명령 UUID, 실행·준비 버전, DOM 상태와 공통 식별자가 아니다. 명령 영수증과 준비·전송 이벤트에는 각 대상 ID가 있으나, 모든 명령의 동일 상태 판정 근거를 경계 전체에서 조인할 수 있는 증거는 없다.
- 실제 브라우저에서 수집하는 E2E 자료는 HTTP 경로·상태, DOM, 해당 시나리오의 별도 영속 증거를 제공한다. 모든 가용성 판정과 모든 legacy 조합을 기록하는 체계는 아니다. 브라우저에서 조작할 수 있는 경로와 서비스 단위에서만 확인한 경로를 구분해야 한다.
- 기존 준비의 변경 API에 정수 버전이 필요하다. 누락·형식 오류는 `PREPARATION_VERSION_REQUIRED`, 불일치는 `PREPARATION_VERSION_CONFLICT`다. 승인·취소·폐기 등에서 외부 상태를 기다린 뒤 버전을 다시 검사한다. 폐기는 정확한 전송 ID도 요구한다. 구형 클라이언트는 현재 버전을 읽어야 하며, 같은 요청 ID와 본문의 기존 영수증은 재실행 없이 조회한다. [준비 계약](../public/WORKFLOW_CONTRACT.md)
- 확정 결과가 없는 동안 `NOT_FOUND` 또는 `UNAVAILABLE`은 미확정 상태를 해제하지 않는다. 결과를 읽었을 때 대상 실행이 바뀌었으면 기존 작업의 메시지를 그 화면에 표시하지 않는다. 요청 자동 재전송은 없다.

## 종료 검증 증거

### 준비 소유권·버전·진단

- 최초 불일치는 [준비 처리기와 투영](../src/orchestration/preparation-service.js)이 서로 다른 활성 준비 범위를 사용한 지점이다. 기존 활성 준비가 있을 때 직접 POST가 다른 루트를 생성할 수 있었고, 선택 포인터가 종료 기록에 있으면 활성 기록을 가렸다. 이제 처리기, `busy`와 `activePreparation`이 같은 활성 준비를 사용한다. 기존 복수 활성 기록을 발견해도 제거·재전송하지 않는다. 선택된 활성 기록을 닫으면 다음 활성 기록을 조회할 수 있다. 시작 차단·재시작·정상 생성은 격리 SQLite에서 확인했다.
- 준비 변경 API는 영수증 조회를 먼저 수행한 뒤 기존 준비의 정수 버전을 검사한다. 폐기·취소·승인 등은 외부 조회 이후에도 현재 버전을 다시 검사한다. 폐기 도중 버전이 갱신되는 회귀는 수정 전 폐기를 진행했고 수정 후 `PREPARATION_VERSION_CONFLICT`를 반환했다. 다른 전송 ID, 누락 버전, 오래된 버전, 같은 본문 재조회 및 승인 후 한 개의 실행 생성을 [서비스 회귀](../tests/preparation-service.test.js)와 [격리 HTTP 회귀](../tests/preparation-api.test.js)로 대조했다.
- [확장 복구 응답 검증](../src/runtime/web/delivery-inspection.js)의 원문 콘솔 출력을 제거했다. `DELIVERY_RECOVERY_MISMATCH`와 검사 단계, 고정된 실패 검사 이름만 기존 영수증 진단에 기록한다. [개인정보 회귀](../tests/delivery-inspection-privacy.test.js)에서 다른 turn 응답은 거절됐고 콘솔 호출과 본문·바인딩 데이터 노출은 없었다.
- 기존 13개 수정 중 개별 증거가 약한 준비 stop은 버전 누락·충돌의 공통 서비스 회귀로 확인했다. UF-22는 검사·포커스·폐기를 실서버와 SQLite에서 연결하며, 생성이 계속될 때만 stop을 실행하는 분기다. 실제 stop 분기 실행은 별도로 확정하지 않았다. 승인·폐기는 실제 격리 HTTP/Chromium 증거를 추가했다. 재감사 가용성은 기존 동일 후보·활성 turn 회귀, 감사자 결정은 UF-19의 실제 HTTP/Chromium, ACK·연결 승인은 이전 심사 자료의 격리 실서버·소유권 증거를 재사용했다. 통합 게이트의 비공개 ACK 복구 파일 타임아웃은 별도 미해결 위험이다.

### 같은 실행의 DOM → HTTP → SQLite → DOM

UF-19는 실제 Windows Chromium, 별도 서버·SQLite, 제어된 제공자와 Worker를 사용했다. 서버가 투영한 `run.note.add`, 실행 버전과 버튼 가용성을 확인하고 DOM에서 클릭했다. [서버 관측](../src/server.js)은 UUID 형식의 명령 ID만 기존 HTTP 관측 이벤트에 연결한다. HTTP 관측 ID는 서버의 정수이며 명령 UUID와 별개다. [검증 코드](../scripts/e2e/helpers/operations.mjs)는 명령 본문의 정규 해시, SQLite 영수증의 UUID·실행 ID, 실제 메모 ID와 재조회 후 DOM의 문구를 비교한다.

격리 실행은 `code_3c9b9564-c774-4f47-8492-3de47affc6da`였다.

| HTTP 관측 ID | 명령 UUID | 요청 버전 | 응답과 영속 결과 |
| --- | --- | --- | --- |
| 74 | `18c9ef7e-7089-4384-9bd3-b8ddf405cbfe` | 29 | HTTP 200, v30, `note_61433518-8c43-4ef9-ae6d-5c685746eb99` |
| 77 | `f68eeed1-e34e-42cb-a4ae-8e007a17d84f` | 30 | HTTP 200, v31, `note_c063f399-46c6-41c8-a804-abab1d069e90` |
| 80 | `d12ff8dc-2df6-4326-807c-a11f772f8b9b` | 29 | HTTP 409, `RUN_VERSION_CONFLICT`, 조회 영수증 `FAILED`, 새 메모 없음 |
| 84 | `62dbd2d8-c946-4696-9b37-5e928319aa97` | 31 | 서버가 v32에 `note_5bc93d8c-ee92-425e-ac67-ad34cf8e4640` 저장 후 브라우저 응답 유실. 단일 POST, 재조회 영수증 `COMPLETED` |

응답 유실 테스트는 서버에 실제 요청을 전달한 뒤 브라우저 응답만 차단했다. 명령 미확정 상태의 버튼 잠금을 확인하고, 영수증 조회를 보류한 채 격리 기록 `receipt-history`로 이동했다. 영수증을 받은 뒤 그 화면에는 원래 메모와 처리 메시지가 나타나지 않았고, 원래 실행을 열면 영속 메모를 확인할 수 있었다. 변경 전 대역 DOM 회귀에서는 이전 실행의 `FAILED` 메시지가 다른 실행을 덮어썼다. 요청이 수신됐는지 모르는 경우 영수증 미발견 자체로 잠금을 해제하지 않는 분기도 별도 대역 DOM에서 확인했다.

### 변경 귀속과 통합 게이트

- 종료 작업의 주요 구현 변경은 `preparation-service.js`, `preparation-diagnostics.js`, `preparation-follow-up.js`, `delivery-inspection.js`, `server.js`, `app.js`, `dashboard-status-view.js`에 있다. 테스트는 준비 HTTP·서비스·개인정보·대역 DOM 회귀와 기존 E2E UF-19/22/24에 추가했다. 린트 정리를 위해 Web 소켓 대역을 테스트 헬퍼로 옮겼고, 세션 어댑터의 불필요한 빈 줄을 제거했다. 줄 수 상한은 그대로다.
- 시작 스냅샷에는 확장 재연결, 제공자 메시지 역할 판정, 일반 텍스트 준비 응답, 이전 계약 감사 변경이 혼재했다. 종료 작업은 이 별도 기능들을 되돌리지 않았다. 종료 작업보다 이전의 각 변경이 어느 세션에서 유입됐는지는 완전히 구분할 수 없다.
- 현재 소스의 `lint`, `architecture:check`, `typecheck`, `git diff --check`는 통과했다. 격리 복제본에서 실행한 통합 `npm run check`는 정적 검사를 통과한 뒤 200개 테스트 파일 중 10개를 처리하고 중단됐다. 8개 파일 통과, `aud14-role-provenance.test.js`에서 역할 근거 거절 3건 실패, `audit-ack-private-recovery.test.js`에서 180초 프로세스 종료 기한 초과로 결과 영수증 미생성이었다. 전자의 변경된 ChatGPT 제공자 파일은 종료 작업 착수 전부터 동일했다. 후자의 시간 초과 원인은 확정하지 못했다. 검사 실행 로그를 임시 복제본 내부로 리디렉션해 로그 자체가 소스 해시 변경으로 집계된 오류도 있었다. 전체 테스트 게이트는 통과하지 못했고, 이후 확인된 회귀는 관련 표적만 실행했다.
- UF-19, UF-22, UF-24는 각각 해당 경계에서 PROFILE_PASS와 자원 종료를 확인했다. 실제 운영 8787, Default 확장, 운영 복구 데이터에는 접근하거나 변경하지 않았다. 이 보고는 통합 게이트 실패와 운영 미검증이 남아 있으므로 배포 승인 근거로 충분하지 않다.
