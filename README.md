# Codex / ChatGPT Web Agent Bridge

이 저장소의 목표는 하나의 로컬 Controller가 서로 분리된 두 세션을 중계하는 것입니다.

```text
CODEX_AGENT          = persistent Codex app-server thread
CHATGPT_WEB_AGENT    = Chrome 확장이 결박한 실제 ChatGPT 웹 conversation
Controller           = 상태·전달·복구·종료 판정의 유일한 writer
```

`CODEX_AGENT`는 ChatGPT 데스크톱 앱 화면이 아닙니다. 실제 데스크톱 UI 자동화는 MVP 범위에 포함하지 않습니다. `CHATGPT_WEB_AGENT`는 공식 Agent protocol이 아니라 로그인된 `chatgpt.com` DOM을 관찰·조작하므로 UI 변경, 인증 만료, CAPTCHA 및 계정 정책의 영향을 받습니다.

## 현재 구현 상태

현재 코드는 Controller+SQLite 기준의 durable discussion core와, 아직 연결되지 않은 runtime
surface를 명시적으로 분리합니다.

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
- 한 transaction 안의 response/message/packet/proposal/event/outcome/next-outbox 처리
- 상태별 action matrix, same-actor protocol repair, 동일-hash 양측 consensus
- Controller+SQLite 5-turn integration과 마지막 ACCEPT 뒤 추가 delivery 억제
- Agent-owned BLOCKED 사유와 Controller/runtime-owned operational blocker 사유 분리

동일한 normalized proposal이 다시 제출되면 새 canonical proposal을 만들지 않고 기존
`proposalRefHash`를 재사용합니다. 각 source message의 occurrence는 hash-chained
`AGENT_RESPONSE_STORED` event가 별도로 보존하고 startup verifier가 그 message와 proposal을
다시 결박합니다. Protocol repair는 prior context에서 단 하나의 expected packet type을 증명할
수 있을 때만 자동 생성하며, 허용 타입이 여러 개이거나 근거가 불명확하면 현재는 fail-closed로
중단합니다.

Discussion core의 direct integration은 준비됐지만 dispatcher-backed fake runtime vertical과
production composition root는 아직 연결하지 않았습니다.
따라서 `/api/state`, Dashboard WebSocket, live run mutation은 의도적으로 `503`을 반환합니다.
Health는 이 둘을 하나의 `orchestrationReady` 값으로 뭉개지 않고 다음 사실을 따로 반환합니다.

```text
coreOrchestrationReady=true
fakeVerticalSliceVerified=true
codexRuntimeReady=false
webRuntimeReady=false
liveSessionBindingReady=false
liveOrchestrationReady=false
```

다음 단계의 live dispatcher는 Codex/Web terminal output의 실제 parser evidence를 response
처리기에 결박해야 합니다. 특히 protocol rejection의 packet-type 근거를 caller 문자열로
임의 선택해서는 안 되며, redaction 후 저장된 raw-response artifact를 사용해야 합니다.
현재 Controller는 artifact 존재·hash를 검증하지만 이 내부 port를 HTTP/WS command로 노출하지
않습니다. recovery scan 역시 불확실한 작업을 찾지만 provider reconciliation과 사용자 recovery
decision 실행기는 아직 composition에 연결되지 않았습니다.

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

현재 서버는 extension transport, 정적 Dashboard와 split-readiness health만 확인하는
fail-closed live smoke surface입니다.

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
output validation, durable Controller+SQLite consensus, response fault-injection rollback, extension
authentication/binding/race, DOM fixtures, Dashboard model 및 split readiness를 포함합니다.

2026-09-04 fail-closed foundation checkpoint에서 다음을 로컬로 재현했습니다.

```text
npm run check             306/306 PASS
npm run test:integration   85/85 PASS
server smoke              core ready / live ready false / live api state=503
```

두 test 실행은 fake Codex app-server와 DOM fixture만 사용했으며 네트워크, 실제 Provider 또는 실제 브라우저를 사용하지 않았습니다. 이 수치는 아래 미구현 범위를 통과했다는 뜻이 아닙니다.

아직 검증하지 않은 것은 실제 Codex + 실제 ChatGPT 웹 자동 왕복, 실제 browser DOM interaction,
Controller crash 후 live provider reconciliation, CODE_CHANGE mode, Controller-owned commit 및
exact candidate audit입니다. 이 Live E2E가 없으므로 현재 상태를 "MVP 완료" 또는 "live 통합 완료"로
부르지 않습니다.
