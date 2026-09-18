from pathlib import Path
import sys

ROOT = Path.cwd()
SERVICE = ROOT / 'src/orchestration/code-change-service.js'
APP = ROOT / 'public/app.js'


def fail(msg):
    print(f'[FAIL] {msg}', file=sys.stderr)
    sys.exit(1)


def backup(path):
    bak = path.with_suffix(path.suffix + '.canonical-runtime.bak')
    if not bak.exists():
        bak.write_bytes(path.read_bytes())
        print(f'[backup] {bak}')


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        fail(f'{label}: expected exactly one matching block, found {count}')
    return text.replace(old, new, 1)


for path in (SERVICE, APP):
    if not path.exists():
        fail(f'missing file: {path}')

service = SERVICE.read_text(encoding='utf-8-sig')
app = APP.read_text(encoding='utf-8-sig')

# ------------------------------------------------------------------
# Backend relay, idempotent
# ------------------------------------------------------------------
if 'recordWorkerRuntimeEvent(id, event)' not in service:
    anchor = '  async waitForWorkerCompletion(id, worker, handle) {'
    if anchor not in service:
        fail('waitForWorkerCompletion anchor not found')
    method = '''  recordWorkerRuntimeEvent(id, event) {
    if (!event || event.type === "TEXT_DELTA") return;
    const run = this.get(id);
    if (!run || terminal.has(run.stage)) return;
    const payload = redactForEvidence({
      runtimeType: event.type,
      sourceMethod: event.sourceMethod ?? null,
      threadId: event.threadId ?? null,
      turnId: event.turnId ?? null,
      itemId: event.itemId ?? null,
      toolType: event.toolType ?? null,
      status: event.status ?? null,
      error: event.error ?? null,
      requestId: event.requestId ?? null,
    });
    this.update(id, { events: [...(run.events ?? []), {
      eventId: `event_${randomUUID()}`,
      type: "WORKER_RUNTIME_EVENT",
      createdAt: new Date().toISOString(),
      payload,
    }] });
  }
'''
    service = service.replace(anchor, method + anchor, 1)
    print('[add] recordWorkerRuntimeEvent')
else:
    print('[keep] recordWorkerRuntimeEvent')

if 'unsubscribeWorkerEvents' not in service:
    old = '''      const worker = await this.wait(runId, creation);
      this.workers.set(runId, worker);
      let completed;'''
    new = '''      const worker = await this.wait(runId, creation);
      this.workers.set(runId, worker);
      const unsubscribeWorkerEvents = typeof worker.onEvent === "function"
        ? worker.onEvent((event) => {
          try { this.recordWorkerRuntimeEvent(runId, event); }
          catch {}
        })
        : null;
      let completed;'''
    service = replace_once(service, old, new, 'worker.onEvent relay')

    old_finally = '      } finally { await worker.close(); this.workers.delete(runId); }'
    new_finally = '''      } finally {
        unsubscribeWorkerEvents?.();
        await worker.close();
        this.workers.delete(runId);
      }'''
    service = replace_once(service, old_finally, new_finally, 'worker relay cleanup')
    print('[add] worker.onEvent relay')
else:
    print('[keep] worker.onEvent relay')

# ------------------------------------------------------------------
# Backend canonical projection
# ------------------------------------------------------------------
if 'function projectWorkerRuntime(run, preflight)' not in service:
    class_anchor = '\nexport class CodeChangeService {'
    if class_anchor not in service:
        fail('CodeChangeService class anchor not found')
    projection = '''
function latestWorkerRuntimeEvent(run) {
  const events = run?.events ?? [];
  const workerStage = [...events].reverse().find((event) =>
    event.type === "STAGE_CHANGED" && event.payload?.stage === "WORKER_RUNNING");
  const stageAt = workerStage?.createdAt ?? null;
  return [...events].reverse().find((event) =>
    event.type === "WORKER_RUNTIME_EVENT"
      && (!stageAt || String(event.createdAt) >= String(stageAt))) ?? null;
}

function projectWorkerRuntime(run, preflight) {
  const configured = preflight?.checks?.codeWorkerExecutableConfigured === true;
  const latest = latestWorkerRuntimeEvent(run);
  const runtimeType = latest?.payload?.runtimeType ?? null;
  const phase = run?.stage ?? null;
  let processState = configured ? "IDLE" : "UNCONFIGURED";
  let sessionState = run?.workerThread ? "READY" : "NOT_STARTED";
  let turnState = run?.workerTurnId ? "ACTIVE" : "NOT_STARTED";
  let activity = null;

  if (phase === "WORKER_RUNNING") {
    processState = run?.workerThread ? "RUNNING" : "STARTING";
    if (runtimeType === "SESSION_READY") sessionState = "READY";
    if (runtimeType === "TURN_STARTED") turnState = "ACTIVE";
    if (runtimeType === "TOOL_STARTED") activity = "TOOL_RUNNING";
    if (runtimeType === "TOOL_COMPLETED") activity = "TOOL_COMPLETED";
    if (runtimeType === "APPROVAL_REQUESTED") activity = "APPROVAL_WAIT";
    if (runtimeType === "TURN_FAILED") turnState = "FAILED";
    if (runtimeType === "TURN_INTERRUPTED") turnState = "INTERRUPTED";
    if (runtimeType === "SESSION_DISCONNECTED") processState = "DISCONNECTED";
  } else if (phase === "CANDIDATE_CAPTURE") {
    processState = "COMPLETE"; turnState = "COMPLETED"; activity = "CANDIDATE_CAPTURE";
  } else if (phase === "VERIFYING") {
    processState = "COMPLETE"; turnState = "COMPLETED"; activity = "VERIFYING";
  } else if (["REVIEW_RUNNING", "REPORT_REPAIR", "EVIDENCE_SUPPLEMENT"].includes(phase)) {
    processState = "COMPLETE"; turnState = "COMPLETED"; activity = "WEB_AUDIT";
  } else if (phase === "AWAITING_APPLY") {
    processState = "COMPLETE"; turnState = "COMPLETED"; activity = "AWAITING_APPLY";
  } else if (phase === "APPLIED") {
    processState = "COMPLETE"; turnState = "COMPLETED"; activity = "APPLIED";
  } else if (phase === "RECOVERY_REQUIRED") {
    processState = "RECOVERY_REQUIRED"; activity = "RECOVERY_REQUIRED";
  }

  return Object.freeze({
    configured,
    provider: run?.worker?.provider ?? null,
    model: run?.worker?.model ?? null,
    processState,
    sessionState,
    turnState,
    activity,
    toolType: latest?.payload?.toolType ?? null,
    runtimeType,
    threadId: latest?.payload?.threadId ?? run?.workerThread?.threadId ?? run?.workerThread ?? null,
    turnId: latest?.payload?.turnId ?? run?.workerTurnId ?? null,
    lastActivityAt: latest?.createdAt ?? run?.updatedAt ?? null,
  });
}
'''
    service = service.replace(class_anchor, projection + class_anchor, 1)
    print('[add] projectWorkerRuntime')
else:
    print('[keep] projectWorkerRuntime')

if 'workerRuntime: projectWorkerRuntime(record, preflight),' not in service:
    old = '''      error: record.error, drafts: {}, starting: record.stage === "PROVISIONING", preflight,
      commandCapabilities:'''
    new = '''      error: record.error, drafts: {}, starting: record.stage === "PROVISIONING", preflight,
      workerRuntime: projectWorkerRuntime(record, preflight),
      commandCapabilities:'''
    service = replace_once(service, old, new, 'snapshot workerRuntime')
    print('[add] snapshot.workerRuntime')
else:
    print('[keep] snapshot.workerRuntime')

# ------------------------------------------------------------------
# Frontend canonical renderer
# ------------------------------------------------------------------
canonical_front = '''function workerRuntimeStatus(runtime) {
  if (!connected || !runtime) return { state:"unknown", detail:"확인 전" };
  if (!runtime.configured) return { state:"warn", detail:"경로 설정 필요" };
  const activityAt = runtime.lastActivityAt ? ` · ${time(runtime.lastActivityAt)}` : "";
  const toolLabels = {
    commandExecution:"명령 실행", fileChange:"파일 변경", mcpToolCall:"도구 호출",
    dynamicToolCall:"도구 호출", collabToolCall:"협업 도구", collabAgentToolCall:"협업 에이전트",
    webSearch:"웹 검색", imageView:"이미지 확인",
  };
  const tool = toolLabels[runtime.toolType] ?? runtime.toolType ?? "도구";
  if (runtime.processState === "UNCONFIGURED") return { state:"warn", detail:"경로 설정 필요" };
  if (runtime.processState === "STARTING") return { state:"ok running", detail:"Codex 프로세스 시작 중" };
  if (runtime.processState === "DISCONNECTED") return { state:"warn", detail:`Codex 연결 끊김${activityAt}` };
  if (runtime.processState === "RECOVERY_REQUIRED") return { state:"warn", detail:"최근 Worker 상태 복구 필요" };
  if (runtime.activity === "TOOL_RUNNING") return { state:"ok running", detail:`실행 확인됨 · ${tool} 진행 중${activityAt}` };
  if (runtime.activity === "TOOL_COMPLETED") return { state:"ok running", detail:`실행 확인됨 · ${tool} 완료${activityAt}` };
  if (runtime.activity === "APPROVAL_WAIT") return { state:"warn", detail:`실행 확인됨 · Codex 승인 대기${activityAt}` };
  if (runtime.activity === "CANDIDATE_CAPTURE") return { state:"ok running", detail:"Worker 완료 · 후보 캡처 중" };
  if (runtime.activity === "VERIFYING") return { state:"ok running", detail:"Worker 완료 · 후보 검증 중" };
  if (runtime.activity === "WEB_AUDIT") return { state:"ok running", detail:"Worker 완료 · 웹 감사 진행 중" };
  if (runtime.activity === "AWAITING_APPLY") return { state:"ok", detail:"Worker·웹 감사 완료 · 적용 대기" };
  if (runtime.activity === "APPLIED") return { state:"ok", detail:"Worker·웹 감사 완료 · 적용됨" };
  if (runtime.turnState === "ACTIVE") return { state:"ok running", detail:`실행 확인됨 · Worker turn 진행 중${activityAt}` };
  if (runtime.sessionState === "READY" && runtime.processState === "RUNNING") return { state:"ok running", detail:`Codex 실행 확인 · 세션 준비됨${activityAt}` };
  if (runtime.processState === "COMPLETE") return { state:"ok", detail:"Worker 실행 완료" };
  return { state:"ok", detail:"경로 설정됨 · 실행 전" };
}
'''

if 'function latestWorkerRuntimeEvent(run)' in app:
    start = app.find('function latestWorkerRuntimeEvent(run)')
    end = app.find('function evidenceLinks(', start)
    if end == -1:
        fail('frontend live relay helper end anchor not found')
    app = app[:start] + canonical_front + app[end:]
    print('[replace] frontend local inference -> canonical runtime')
elif 'function workerRuntimeStatus(runtime)' not in app:
    idx = app.find('function evidenceLinks(')
    if idx == -1:
        fail('frontend evidenceLinks anchor not found')
    app = app[:idx] + canonical_front + app[idx:]
    print('[add] frontend canonical renderer')
else:
    print('[keep] frontend canonical renderer')

app = app.replace('const workerStatus = workerRuntimeStatus(run, checks);',
                  'const workerStatus = workerRuntimeStatus(snapshot?.workerRuntime);')

old_health = '''  health("engineHealth", "engine", !connected || typeof checks?.codeWorkerExecutableConfigured !== "boolean" ? "unknown" : "warn",
    !connected || typeof checks?.codeWorkerExecutableConfigured !== "boolean" ? "확인 전" : checks.codeWorkerExecutableConfigured ? "경로 설정됨 · 실제 실행 상태는 확인 전" : "경로 설정 필요");'''
new_health = '''  const workerStatus = workerRuntimeStatus(snapshot?.workerRuntime);
  health("engineHealth", "engine", workerStatus.state, workerStatus.detail);'''
if old_health in app:
    app = app.replace(old_health, new_health, 1)
    print('[replace] hardcoded engine health')
elif 'health("engineHealth", "engine", workerStatus.state, workerStatus.detail);' not in app:
    fail('engineHealth block has an unknown shape')

old_cli_live = '''  const cliConfigured = checks?.codeWorkerExecutableConfigured === true;
  signal("cliSignal", "CLI", connected ? (cliConfigured ? workerStatus.state : "warn") : "warn",
    !connected ? "서버 확인 필요" : cliConfigured ? workerStatus.detail : "경로 설정 필요");'''
old_cli_original = '''  const cliConfigured = checks?.codeWorkerExecutableConfigured === true;
  signal("cliSignal", "CLI", connected ? (cliConfigured ? "ok" : "warn") : "warn",
    !connected ? "서버 확인 필요" : cliConfigured ? "경로 설정됨" : "경로 설정 필요");'''
new_cli = '''  signal("cliSignal", "CLI", connected ? workerStatus.state : "warn",
    !connected ? "서버 확인 필요" : workerStatus.detail);'''
if old_cli_live in app:
    app = app.replace(old_cli_live, new_cli, 1)
    print('[replace] live CLI inference')
elif old_cli_original in app:
    app = app.replace(old_cli_original, new_cli, 1)
    print('[replace] original CLI status')
elif new_cli not in app:
    fail('cliSignal block has an unknown shape')

app = app.replace(
    '  const workerStatus = workerRuntimeStatus(snapshot?.workerRuntime);\n  const workerStatus = workerRuntimeStatus(snapshot?.workerRuntime);',
    '  const workerStatus = workerRuntimeStatus(snapshot?.workerRuntime);'
)

required_service = [
    'recordWorkerRuntimeEvent(id, event)',
    'projectWorkerRuntime(run, preflight)',
    'workerRuntime: projectWorkerRuntime(record, preflight)',
    'worker.onEvent((event)',
]
required_app = [
    'function workerRuntimeStatus(runtime)',
    'workerRuntimeStatus(snapshot?.workerRuntime)',
    'health("engineHealth", "engine", workerStatus.state, workerStatus.detail)',
    'signal("cliSignal", "CLI", connected ? workerStatus.state : "warn"',
]
for marker in required_service:
    if marker not in service:
        fail(f'backend sanity missing: {marker}')
for marker in required_app:
    if marker not in app:
        fail(f'frontend sanity missing: {marker}')
if '경로 설정됨 · 실제 실행 상태는 확인 전' in app:
    fail('stale engine text still remains')

backup(SERVICE)
backup(APP)
SERVICE.write_text(service, encoding='utf-8', newline='\n')
APP.write_text(app, encoding='utf-8', newline='\n')

print('\n[OK] canonical Worker runtime migration applied')
print('Next:')
print('  git diff --check')
print('  git diff -- src/orchestration/code-change-service.js public/app.js')
print('  npm test')
