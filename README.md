# Codex / ChatGPT Web Agent Bridge

이 저장소의 목표는 하나의 로컬 Controller가 서로 분리된 두 세션을 중계하는 것입니다.

```text
CODEX_AGENT          = persistent Codex app-server thread
CHATGPT_WEB_AGENT    = Chrome 확장이 결박한 실제 ChatGPT 웹 conversation
Controller           = 상태·전달·복구·종료 판정의 유일한 writer
```

`CODEX_AGENT`는 ChatGPT 데스크톱 앱 화면이 아닙니다. 실제 데스크톱 UI 자동화는 MVP 범위에 포함하지 않습니다. `CHATGPT_WEB_AGENT`는 공식 Agent protocol이 아니라 로그인된 `chatgpt.com` DOM을 관찰·조작하므로 UI 변경, 인증 만료, CAPTCHA 및 계정 정책의 영향을 받습니다.

## 현재 구현 상태

현재 코드는 Controller+SQLite 기준의 durable discussion core, dispatcher-backed fake runtime
수직 경로 및 authenticated live-start composition을 명시적으로 분리합니다. 실제 Provider E2E와
crash/recovery reconciliation은 아직 별도 검증 대상입니다.

- strict domain records, run state machine, four caller-frozen limits
- SQLite event/projection store, hash chain, transactional relay/outbox
- persistent Codex thread start/resume/inspect/interrupt와 로컬 JSON Schema 검증
- Codex executable pinning, child environment allowlist, fail-closed approval bridge
- HMAC-authenticated extension transport와 exact ChatGPT conversation binding
- prompt marker, 수동 개입·binding drift·ambiguous completion 거부
- selector registry, service-worker state 복원, 동시 delivery reservation
- two-pane Dashboard projection/command model
- redaction, content-addressed artifacts, loopback/origin auth primitives (production persistence pipeline integration pending)
- startup preflight, projection rebuild, recovery candidate scan
- `AgentTurnInput`/`AgentMessage` 분리와 Controller-owned Proposal identity
- hash-chained submission receipt/session/turn과 response/rejection provenance 검증
- 제출 직전 session identity/version snapshot 고정과 submit·response-start·response-final race 검증
- 한 transaction 안의 response/message/packet/proposal/event/outcome/next-outbox 처리
- 상태별 action matrix, same-actor protocol repair, 동일-hash 양측 consensus
- Controller+SQLite 5-turn integration과 마지막 ACCEPT 뒤 추가 delivery 억제
- Agent-owned BLOCKED 사유와 Controller/runtime-owned operational blocker 사유 분리
- PENDING outbox에서 fake Codex/Web session, runtime event consumer, packet parser를 거치는 5-turn 수직 경로
- delivery/input/session/turn의 exact correlation과 stale·foreign·duplicate terminal event 거부
- PENDING 재개와 SUBMITTED 불확실 상태의 자동 재전송 금지
- runtime approval event를 canonical approval로 승격하지 않는 dispatcher fail-closed 경계

동일한 normalized proposal이 다시 제출되면 새 canonical proposal을 만들지 않고 기존
`proposalRefHash`를 재사용합니다. 각 source message의 occurrence는 hash-chained
`AGENT_RESPONSE_STORED` event가 별도로 보존하고 startup verifier가 그 message와 proposal을
다시 결박합니다. Protocol repair 권한은 거부된 원래 turn과 source message의 frozen action policy에서
전체 `allowedPacketTypes`로 재도출하고 `repairPolicyHash`로 결박합니다. Runtime-response evidence의
`observedCandidatePacketType`은 진단값일 뿐 repair 허용 범위나 다음 action을 선택하지 않습니다.
생성, 응답 소비와 startup 재검증이 모두 같은 policy를 다시 계산하며 불일치는 fail-closed입니다.

Dispatcher-backed fake runtime vertical은 test harness에서 연결됐습니다. production composition
factory는 SQLite, artifact store, pinned Codex process manager 및 exact Web adapter를 조립하며,
`provisionRun()`이 호출되기 전에는 thread나 Web prompt를 시작하지 않습니다. 인증된
`POST /api/runs/start`는 exact Web conversation binding을 먼저 완료하고, 그 뒤에만 Codex
thread를 열어 dispatcher를 시작합니다. `/api/state`와 Dashboard WebSocket은 아직 command
projection이 아니므로 `503`을 반환합니다.
현재 Health는 다음 값을 따로 반환합니다. 여기서 `coreOrchestrationReady`와
`fakeVerticalSliceVerified`는 자동 검증 checkpoint이고, 실행 중 production component의
준비 상태는 아닙니다. 이 naming과 runtime readiness 계산은 별도 composition 변경에서
정정해야 합니다.

```text
coreOrchestrationReady=true
fakeVerticalSliceVerified=true
codexRuntimeReady=false
webRuntimeReady=false
liveSessionBindingReady=false
liveOrchestrationReady=false
```

Fake dispatcher는 Codex/Web terminal event와 completion을 exact turn에 결박하고, parser가
검증한 packet만 response 처리기에 전달합니다. Malformed output은 raw provider text를 artifact에
보존하지 않고 actor, parser stage와 strict framing에서 도출된 observed candidate type만 allowlist evidence로
저장합니다. Terminal failure/interruption은 completion promise를 기다리지 않고 즉시 fail-closed하며,
durable response 뒤 callback 실패는 `POST_COMMIT_EFFECT_FAILED`로 이미 commit된 경계와 구분합니다.
이 검증은 synthetic evidence이며 live Codex/Web adapter 조립을 증명하지 않습니다. Fake Web의
durable acknowledgement도 test binding callback으로만 검증됐고 production composition에는 아직
연결되지 않았습니다.
현재 Controller는 artifact 존재·hash를 검증하지만 이 내부 port를 HTTP/WS command로 노출하지
않습니다. recovery scan 역시 불확실한 작업을 찾지만 provider reconciliation과 사용자 recovery
decision 실행기는 아직 composition에 연결되지 않았습니다. `CODEX_EXECUTABLE`을 설정하면
health의 `liveCompositionConfigured`가 true가 되지만, 이는 executable pinning configuration만
뜻하며 Provider 연결 또는 Live E2E 성공을 뜻하지 않습니다.

Agent `BLOCKED`가 operational fact를 만드는 경로는 차단됐습니다. 다만
`requestRuntimeApproval()`의 opaque scope를 실제 runtime request/session/turn evidence에
결박하는 계약과 `SESSION_AUTH` blocker의 trusted creation provenance는 아직 부분 구현입니다.
Fake dispatcher는 correlated approval event를 승인으로 만들지 않고 중단하지만, 이 두 저장소
불변조건 자체는 live composition 전에 별도 변경으로 닫아야 합니다.

## 원본 ZIP 판정

마이그레이션 기준 ZIP은 `app-web-agent-bridge.zip`이며 SHA-256은 다음과 같습니다.

```text
e383f9032c7a6be912f5bb0a28023fd24c6625b0281ab0c469653135df7b2e70
```

ZIP의 28개 파일은 세션·웹 확장·두 pane UI의 초기 골격으로는 맞습니다. 기존 in-memory orchestrator, JSONL store, query-token gateway, demo Agent를 target implementation으로 그대로 쓰는 것은 맞지 않습니다. 파일별 `KEEP / REWRITE / EXTRACT / DELETE` 근거는 `MIGRATION_PLAN.md`에 있습니다.

## 요구 환경

- Node.js 22.5 이상
- Chrome 또는 Edge 116 이상
- 로그인된 `https://chatgpt.com` 세션
- 실제 Codex smoke를 할 때만 Codex CLI 로그인 및 별도 실행 승인

## 설치와 로컬 검증

```powershell
cd app-web-agent-bridge
npm ci
npm run check
npm run test:integration
```

`npm run check`는 lint, typecheck 및 전체 test suite를 실행합니다. 통합 suite는 fake Codex app-server와 DOM fixture를 사용하며 실제 Provider 호출, 비용, credential 또는 live data 전송을 하지 않습니다.

Projection 재생성은 기존 SQLite 파일과 run을 명시해야 합니다.

```powershell
npm run projection:rebuild -- --database <absolute-db-path> --run-id <run-id>
```

## 확장 설정

1. `chrome://extensions`에서 개발자 모드를 켭니다.
2. 이 저장소의 `extension/`을 압축해제된 확장으로 로드합니다.
3. popup에 `ws://127.0.0.1:8787/ws/extension`과 최소 32 UTF-8 바이트의 무작위 shared secret을 저장합니다.
4. popup의 persisted extension identity를 확인합니다.
5. Controller 실행 시 같은 secret과 exact identity를 전달합니다.

WebSocket URL에는 token, query string 또는 fragment를 넣지 않습니다. 신규 미인증 socket은 이미 인증된 session을 교체할 수 없습니다. 대화 URL/ID가 정확히 맞지 않으면 active/latest tab이나 새 conversation으로 자동 fallback하지 않습니다.

## 서버 smoke

현재 서버는 extension transport, 정적 Dashboard, live-composition configuration, split-readiness
health와 인증된 live run start surface를 제공합니다.

```powershell
Copy-Item .env.example .env
$env:DEMO_MODE="true"
npm start
```

Health endpoint:

```text
http://127.0.0.1:8787/api/health
```

`webConnected`는 HMAC 인증까지 끝난 연결만 뜻하며 `webRuntimeReady` 또는
`liveOrchestrationReady`를 뜻하지 않습니다. `DEMO_MODE=true`는 정적 UI/server smoke일 뿐
가짜 Agent 응답이나 합성 성공을 만들지 않습니다.

## 첫 Live run

실제 Codex 또는 ChatGPT Web 호출은 비용·외부 전송을 발생시킬 수 있습니다. 실행 전에 `.env`에
별도 base64url dashboard token을 추가하고 서버를 재시작합니다. Extension secret과 같은 값을 쓰지 않습니다.

```powershell
$bytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
# .env의 DASHBOARD_TOKEN= 뒤에 $token 값을 넣는다.
```

확장이 HMAC 인증을 끝내고 `/api/preflight`의 `readyForProvisioning`이 `true`가 된 뒤,
다음처럼 정확한 ChatGPT conversation URL로 시작합니다. `Origin`은 서버의 `HOST`/`PORT`와 같아야 합니다.

```powershell
$headers = @{
  Authorization = "Bearer <DASHBOARD_TOKEN>"
  Origin = "http://127.0.0.1:8787"
}
$body = @{
  objective = "서로에게 짧게 인사해."
  conversationUrl = "https://chatgpt.com/c/<conversation-id>"
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/api/runs/start" `
  -Headers $headers -ContentType "application/json" -Body $body
```

URL이 결박되지 않거나 확장이 인증되지 않으면 Codex thread를 열지 않고 시작 요청을 거절합니다.
처음 시작하거나 이전 run의 결박이 남아 있어도, active delivery가 없는 상태에서는 확장이 exact URL과
conversation ID가 일치하는 탭을 정확히 하나 찾았을 때만 새 run에 결박합니다. 0개면
`NEEDS_REBIND`, 2개 이상이면 `AMBIGUOUS`로 거절합니다.

## 보안 및 운영 경계

- 서버는 loopback host만 허용합니다.
- Extension content script host는 `chatgpt.com`으로 제한됩니다.
- Extension transport는 credential이 든 query string을 거부합니다. 범용 event/receipt persistence 앞의 중앙 redaction·크기 제한·artifact 분리는 아직 production composition에 연결되지 않았습니다.
- Codex child는 ambient `process.env`를 그대로 상속하지 않습니다.
- Codex app-server의 `readOnly` sandbox는 파일 쓰기를 막는 경계이지 shell 실행 자체를 끄는 계약으로 검증되지 않았습니다. 따라서 `shellExecution=false`를 요구하는 production `DISCUSSION` composition은 아직 열지 않습니다.
- 실제 Provider 호출, 비용 발생, credential 사용 및 live repository 외부 전송은 별도 승인 없이는 수행하지 않습니다.
- pause는 현재 turn을 완료시키고 다음 delivery를 막으며, interrupt와 동일하지 않습니다.
- 제출 뒤 결과가 불확실한 delivery/turn은 자동 재전송하지 않습니다.

## 검증 범위

현재 자동 검증은 domain, SQLite/outbox, hash-chain 변조 탐지, fake Codex lifecycle, strict
output validation, durable Controller+SQLite consensus, response fault-injection rollback,
dispatcher-backed fake Codex/Web 5-turn consensus, restart/reopen 및 exact event correlation,
extension authentication/binding/race, DOM fixtures, Dashboard model 및 split readiness를 포함합니다.

2026-09-04 fail-closed foundation checkpoint에서 다음을 로컬로 재현했습니다.

```text
npm run check             336/336 PASS
npm run test:integration  123/123 PASS
server smoke              core ready / dashboard state API=503
```

두 test 실행은 fake Codex app-server와 DOM fixture만 사용했으며 네트워크, 실제 Provider 또는 실제 브라우저를 사용하지 않았습니다. 이 수치는 아래 미구현 범위를 통과했다는 뜻이 아닙니다.

아직 검증하지 않은 것은 실제 Codex + 실제 ChatGPT 웹 자동 왕복, 실제 browser DOM interaction,
Controller crash 후 live provider reconciliation, CODE_CHANGE mode, Controller-owned commit 및
exact candidate audit입니다. 이 Live E2E가 없으므로 현재 상태를 "MVP 완료" 또는 "live 통합 완료"로
부르지 않습니다.
