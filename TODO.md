# 구현과 검증 범위

기준: 사용자 「CLI 구현·웹 감사 시스템 통합 기준안」 v1.0, REQ-01~21.
현재 코드의 소유 위치와 연결 제안 검토는 [MIGRATION_PLAN](MIGRATION_PLAN.md)에 있다.
이 목록은 대상 프로젝트 RequirementsSet을 대신하지 않는다. 과거 테스트 개수는 Git 이력에서 확인하고 현재 성공 근거로 재사용하지 않는다.

## 구현된 경로

| 범위 | 구현 | 확인할 검사 / 남은 한계 |
|---|---|---|
| 기준 고정·시작, REQ-01~03 | 프로젝트 설정, preparation 합의, revision/hash, 비동기 접수 | preparation/API/domain 검사. 실제 운영 기준은 사용자가 지정 |
| 작업 분리·후보 고정, REQ-04~05 | 런별 Git worktree, 회차별 새 Worker, tree/patch/blob 캡처 | Git/Worker 검사와 browser fixture 연결. worktree는 OS 보안 경계가 아님 |
| 실행 기록, REQ-06 | 실제 Node 명령, 결과 디렉터리, 시간/종료/오류/후보 불변 검사 | candidate evidence 검사. 출력 제한·바이너리 수집·프로세스 트리 한계 유지 |
| 감사·추가 조회, REQ-07~09 | 고정 후보/요구사항/증거 전달, 등록 검증 ID만 실행 | 감사 서비스·Web Adapter·browser fixture. 실 ChatGPT의 충분한 자료 검토는 별도 |
| 판정·지적·수정, REQ-10~15 | 요구사항별 판정, Controller 지적 ID, 새 Worker, 재검토, 형식 보완 분리 | domain/service 검사. browser fixture는 캡처 patch를 읽어 REWORK→PASS |
| 한도, REQ-16 | 회차·증거·형식·전체/턴 시간 한도 | 경계 검사. 운영 숫자를 예제로 대신 확정하지 않음 |
| 적용, REQ-17 | 별도 code.apply, candidate/review/base/hash/version 검사 | 임시 Git 적용/재시작 검사. 자동 merge/commit/push 없음 |
| 화면, REQ-18~19 | 준비·작업·결과·지적·증거 표시 | test:ui는 실제 브라우저 + API fixture. 제품 제공자 연결 검증과 별개 |
| 중단·재시작, REQ-20~21 | 늦은 응답 차단, 복구 필요, 자동 재전송 금지, 적용 상태 조정 | fake process/adapter/persistence 검사. 실제 제공자 crash/restart는 미검증 |

## 자동 검사의 역할

- `npm run check`: 정적 검사와 Node 테스트. fixture 제공자 성공을 실제 제공자 성공으로 계산하지 않는다.
- `npm run test:browser`: 전체 extension scripts + 실제 Web Adapter/HMAC/WebSocket + Chromium DOM. 실제 Codex Adapter와 fixture subprocess를 더한 2회차 감사 흐름도 검사한다. Chrome API와 제공자 페이지/응답은 fixture다.
- `npm run test:ui`: 콘솔 화면과 입력. 준비·실행 상태는 API fixture다.
- `npm run certify`: 저장된 후보/리뷰/요구사항/증거 정합성. 실 제공자 출처나 artifact 원문을 독립 인증하지 않는다.

`tests/web-root-start.test.js`는 recovery 모듈의 경계 검사다. 이전의 함수 문자열 추출·가짜 완료 테스트가 다루던 root/역할/문서 이동 흐름은 `scripts/test-extension.mjs`의 실제 DOM 검사로 이동했다. 다른 legacy VM 테스트가 남아 있으므로 저장소 전체가 browser integration으로 전환됐다는 뜻은 아니다.

## 남은 실제 환경 검증

1. 대상 Git repo, RequirementsSet, 등록 검증, 한도와 외부 제공자 전송 범위를 확정한다.
2. 설치된 Codex app-server 버전·인증과 실제 thread/turn 왕복을 확인한다.
3. 설치된 Chrome extension, 로그인된 ChatGPT와 실제 메시지/응답/문서 binding을 확인한다. `/uc/` DOM을 처리하는 코드가 있다는 것이 인증된 계정 검증을 뜻하지 않는다.
4. 실제 누락 발견→새 Worker 수정→새 후보→실제 재감사 PASS를 확인한다. 초기 PASS로 correction loop를 검증했다고 하지 않는다.
5. 별도 crash/timeout/reload/restart 실행에서 불확실한 전송 보존·늦은 응답 차단·자동 재전송 금지를 확인한다.
6. OS 접근 제한과 검증 프로세스 자식 트리 종료는 독립적으로 검증/보완한다.

## 현재 검토 시 유의할 변경

폐기 요청은 현재 전송·세션·런·대화 identity가 모두 일치해야 한다. 일반 복구 응답도 `forced` 값으로 identity 검사를 우회하지 않는다. 이 검사를 복원했으며, fixture 검사의 성공을 실제 제공자 복구 검증으로 확대하지 않는다.

현재 `candidatePacketType` 관련 repair 권한은 `src/domain/protocol-repair-policy.js`와 `tests/discussion-protocol-failure.test.js`에서 Controller 입력 기반으로 분리되어 있다. 과거 위험을 현재 미해결 P0로 재기재하지 않는다. 점수 threshold 판정이나 새 Artifact wrapper도 현재 계약으로 도입하지 않는다.
