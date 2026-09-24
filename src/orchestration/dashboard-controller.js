import { createDiscussionRunPolicy } from "../domain/run-policy.js";
import { isTerminalRunPhase } from "../domain/run-state-machine.js";
import { canonicalConversationUrl } from "../runtime/web/binding.js";
import { redactForEvidence } from "../security/redaction.js";
import { sha256CanonicalJson } from "../domain/canonical-json.js";

function reject(message, code = "INVALID_COMMAND") {
  throw Object.assign(new Error(message), { code });
}

function preserveArtifactReferences(value, hashes) {
  if (typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value)) hashes.add(value);
  else if (value && typeof value === "object") for (const child of Object.values(value)) preserveArtifactReferences(child, hashes);
}

function provisioningErrorMessage(error) {
  const code = error?.details?.cause?.code;
  const guidance = {
    NEEDS_REBIND: "Open the entered ChatGPT conversation URL in the browser with the connected extension, leave exactly one matching tab open, then retry Start.",
    AMBIGUOUS: "Close duplicate tabs for this conversation, leave one exact tab open, then retry Start.",
    REBIND_TAB_REQUIRED: "Select the exact ChatGPT conversation tab before reconnecting.",
    REBIND_CONVERSATION_MISMATCH: "The selected tab does not match the requested conversation URL.",
    CONTENT_SCRIPT_UNAVAILABLE: "Refresh the exact ChatGPT tab and verify the extension is enabled.",
    COMPOSER_UNAVAILABLE: "Wait for the ChatGPT composer to load, then refresh and reconnect.",
    UI_CONTRACT_CHANGED: "Wait for the ChatGPT composer to load. If it remains unavailable, refresh the conversation tab and check the extension, then retry Start.",
    SESSION_AUTH_REQUIRED: "Sign in to ChatGPT in the connected browser, open the entered conversation URL, then retry Start.",
  }[code];
  return guidance ? `${error.message} [${code}] ${guidance}` : error.message;
}

/** Authenticated dashboard projection and commands over the existing runtime. */
export class DashboardController {
  #getRuntime;
  #preflight;
  #webSession;
  #transport;
  #starting = false;
  #jobs = new Map();
  #errors = new Map();
  #closed = false;
  #drafts = new Map();
  #receipts = new Map();

  constructor({ getRuntime, preflight, webSession, transport }) {
    this.#getRuntime = getRuntime;
    this.#preflight = preflight;
    this.#webSession = webSession;
    this.#transport = transport;
  }

  isDispatching() { return this.#starting || this.#jobs.size > 0; }

  async snapshot(runId = null) {
    const live = await this.#getRuntime();
    const store = live.store;
    const codeRuns = live.codeChanges?.list() ?? [];
    const runs = [...store.listRuns(), ...codeRuns.map((r) => live.codeChanges.snapshot(r.runId, this.#preflight()).run)]
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const run = runId ? store.getRun(runId) : runs.at(-1) ?? null;
    const codeRun = codeRuns.find((r) => r.runId === (runId || run?.runId));
    if (codeRun) {
      const snapshot = live.codeChanges.snapshot(codeRun.runId, this.#preflight());
      snapshot.runs = runs.map(({ runId, objective, phase, projectRef, targetRoot }) =>
        ({ runId, objective, phase, targetRoot:projectRef?.targetRoot ?? targetRoot ?? null }));
      return snapshot;
    }
    if (runId && !run) reject("Run not found.", "RUN_NOT_FOUND");
    const commands = ["state.get", "evidence.export"];
    const sessions = run ? store.listAgentSessions(run.runId) : [];
    const runtimes = run ? live.composition.getRuntimeSessions(run.runId) : null;
    if (run && !isTerminalRunPhase(run.phase)) {
      commands.push("run.pause", "run.stop");
      const deliveries = store.listDeliveries(run.runId);
      const restorable = !runtimes && !run.blocker && deliveries.some((d) => d.state === "PENDING")
        && deliveries.every((d) => ["PENDING", "RELAYED", "RESPONSE_COMPLETED"].includes(d.state));
      if ((runtimes && run.paused && !this.#errors.has(run.runId)) || (restorable && this.#preflight().readyForProvisioning)) commands.push("run.resume");
      if (run.activeActor && runtimes) commands.push("run.interrupt");
      if (run.activeActor === "CODEX_AGENT" && runtimes?.CODEX_AGENT?.steer) commands.push("run.steer");
    }
    if (run && isTerminalRunPhase(run.phase)) commands.push("run.delete");
    if (run && !run.activeActor && !this.#jobs.has(run.runId)) {
      commands.push("web.session.focus", "web.session.rebind");
    }
    const messages = run ? store.listAgentMessages(run.runId) : [];
    const inputs = run ? store.listAgentTurnInputs(run.runId) : [];
    return {
      run,
      runs: runs.map(({ runId: id, objective, phase, projectRef, targetRoot }) =>
        ({ runId: id, objective, phase, targetRoot:projectRef?.targetRoot ?? targetRoot ?? null })),
      sessions: sessions.map((session) => ({
        ...session,
        ...(session.actor === "CHATGPT_WEB_AGENT" && this.#transport?.snapshot?.binding?.runId === run.runId
          ? this.#transport.snapshot.binding : {}),
        activeTurnId: runtimes?.[session.actor]?.activeTurnId ?? session.activeTurnId,
      })),
      messages: [
        ...messages,
        ...inputs.map((input, index) => ({
          messageId: input.inputId, runId: input.runId, toActor: input.targetActor,
          fromActor: "CONTROLLER", origin: "CONTROLLER", kind: input.kind,
          content: JSON.stringify(input.payload, null, 2), createdAt: input.createdAt,
          sequence: index + 0.5,
        })),
      ],
      deliveries: run ? store.listDeliveries(run.runId) : [],
      approvals: run ? store.listApprovals({ runId: run.runId }) : [],
      events: run ? store.listDomainEvents(run.runId) : [],
      outcome: run ? store.getRunOutcome(run.runId) : null,
      commandCapabilities: commands,
      preflight: this.#preflight(),
      error: run ? this.#errors.get(run.runId) ?? (runtimes || isTerminalRunPhase(run.phase)
        ? null : "이 실행은 이전 서버 세션의 기록입니다. 자동 재전송하지 않습니다. 기록을 확인한 뒤 중단하고 새 실행을 시작하세요.") : null,
      starting: this.#starting,
      drafts: this.#drafts.get(run?.runId) ?? {},
    };
  }

  #launch(live, runId) {
    if (this.#jobs.has(runId) || this.#closed) return;
    const drafts = {};
    this.#drafts.set(runId, drafts);
    const listeners = Object.entries(live.composition.getRuntimeSessions(runId) || {}).map(([actor, session]) =>
      /** @type {any} */ (session).onEvent((event) => {
        if (event.type === "TEXT_DELTA") drafts[actor] = String(drafts[actor] || "") + String(event.delta ?? event.payload?.text ?? event.payload?.delta ?? "");
        if (["TURN_COMPLETED", "TURN_FAILED", "TURN_INTERRUPTED"].includes(event.type)) drafts[actor] = "";
      }));
    const job = Promise.resolve().then(() => live.composition.dispatchUntilSettled({ runId }))
      .catch((error) => {
        if (!this.#closed && !isTerminalRunPhase(live.store.getRun(runId)?.phase)) this.#errors.set(runId, redactForEvidence(error.message || "Run failed."));
      }).finally(() => {
        for (const unsubscribe of listeners) if (typeof unsubscribe === "function") unsubscribe();
        this.#jobs.delete(runId);
      });
    this.#jobs.set(runId, job);
  }

  /** @param {{type: string, payload?: any}} command */
  async execute({ type, payload = {} }) {
    if (this.#closed) reject("Server is shutting down.");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) reject("Invalid command payload.");
    const live = await this.#getRuntime();
    if (type === "state.get") return this.snapshot(payload.runId ?? null);
    if (this.#starting) reject("Session provisioning is still in progress.", "RUN_BUSY");
    if (live.codeChanges?.get(payload.runId)) {
      if (type !== "run.delete") return live.codeChanges.command(type, payload);
      const history = live.codeChanges.store.history(payload.runId);
      const removed = new Set();
      for (const record of history) preserveArtifactReferences(record, removed);
      const result = await live.codeChanges.command(type, payload);
      const remaining = live.store.listArtifactHashes();
      for (const record of live.codeChanges.store.list()) {
        for (const version of live.codeChanges.store.history(record.runId)) preserveArtifactReferences(version, remaining);
      }
      for (const hash of removed) live.artifactStore?.removeIfUnreferenced?.(hash, remaining);
      return result;
    }
    if (type === "run.start") {
      if (this.#starting || this.#jobs.size || live.codeChanges?.busy()) reject("Another run is active.", "RUN_BUSY");
      const preflight = this.#preflight();
      if (!(payload.mode === "DISCUSSION" ? preflight.readyForDiscussion ?? preflight.readyForProvisioning : preflight.readyForProvisioning)) reject("Check project configuration and browser extension before starting.", "PREFLIGHT_INCOMPLETE");
      if (live.store.listRuns().some((run) => !isTerminalRunPhase(run.phase))) reject("Stop the unfinished run before starting another.", "RUN_BUSY");
      if (payload.expectedVersion !== 0) reject("New runs require expectedVersion 0.");
      if (payload.mode === "CODE_CHANGE" || payload.mode === undefined) {
        if (!live.codeChanges) reject("Code change runtime is unavailable.");
        const allowed = new Set(["objective", "conversationUrl", "mode", "expectedVersion"]);
        if (Object.keys(payload).some((key) => !allowed.has(key))) reject("Project settings must come from server configuration.");
        this.#starting = true;
        try { return await live.codeChanges.start(payload); }
        catch (error) { error.message = provisioningErrorMessage(error); throw error; }
        finally { this.#starting = false; }
      }
      if (payload.mode !== "DISCUSSION") reject("Only DISCUSSION mode is supported.");
      if (typeof payload.objective !== "string" || !payload.objective.trim()) reject("Enter an objective.");
      if (!canonicalConversationUrl(payload.conversationUrl)) reject("Enter an exact ChatGPT conversation URL.");
      const policy = createDiscussionRunPolicy({ maxTurns: payload.maxTurns });
      this.#starting = true;
      try {
        const result = await live.composition.provisionRun({ objective: payload.objective.trim(), policy, webConversationUrl: payload.conversationUrl });
        this.#launch(live, result.run.runId);
        return { runId: result.run.runId };
      } catch (error) {
        error.message = provisioningErrorMessage(error);
        if (error.details?.runId) this.#errors.set(error.details.runId, redactForEvidence(error.message));
        throw error;
      } finally { this.#starting = false; }
    }
    const run = live.store.getRun(payload.runId);
    if (!run) reject("Run not found.", "RUN_NOT_FOUND");
    if (payload.expectedVersion !== run.version) reject("Run changed; refresh and try again.", "RUN_VERSION_CONFLICT");
    const input = { runId: run.runId, expectedVersion: run.version };
    const sessions = live.composition.getRuntimeSessions(run.runId);
    switch (type) {
      case "run.delete":
        if (!isTerminalRunPhase(run.phase)) reject("Only finished runs can be deleted.", "RUN_NOT_TERMINAL");
        if (this.#jobs.has(run.runId)) reject("Wait for the run to finish.", "RUN_BUSY");
        const runArtifacts = live.store.listArtifactHashes(run.runId);
        live.store.deleteRun(run.runId);
        const remainingArtifacts = live.store.listArtifactHashes();
        for (const codeRun of live.codeChanges?.list() ?? []) {
          preserveArtifactReferences(codeRun, remainingArtifacts);
        }
        for (const hash of runArtifacts) live.artifactStore?.removeIfUnreferenced?.(hash, remainingArtifacts);
        if (this.#drafts.has(run.runId)) this.#drafts.delete(run.runId);
        this.#errors.delete(run.runId);
        return { runId: run.runId, deleted: true };
      case "run.pause": return live.composition.runService.pause(input);
      case "run.resume":
        if (this.#errors.has(run.runId)) reject("Inspect the failed run before restarting.", "RECOVERY_REQUIRED");
        if (!sessions) {
          this.#starting = true;
          try { await live.composition.restorePendingRun(run.runId); }
          finally { this.#starting = false; }
        }
        live.composition.runService.resume(input);
        this.#launch(live, run.runId);
        return { runId: run.runId };
      case "run.stop": {
        const active = sessions?.[run.activeActor];
        const turnId = active?.activeTurnId;
        const stopped = live.composition.runService.stop(input);
        if (turnId) await active.interrupt({ turnId });
        return stopped;
      }
      case "run.interrupt": {
        const session = sessions?.[run.activeActor];
        if (!session || payload.actor !== run.activeActor || !payload.turnId || payload.turnId !== session.activeTurnId) reject("Active turn changed.");
        live.composition.runService.pause(input);
        return session.interrupt({ turnId: payload.turnId });
      }
      case "run.steer": {
        const session = sessions?.[payload.actor];
        if (payload.actor !== "CODEX_AGENT" || run.activeActor !== payload.actor || !session?.steer || payload.turnId !== session.activeTurnId) reject("Steering requires the active Codex turn.");
        if (typeof payload.text !== "string" || !payload.text.trim()) reject("Enter steering text.");
        return session.steer({ turnId: payload.turnId, text: payload.text });
      }
      case "web.session.focus":
      case "web.session.rebind": {
        if (run.activeActor || this.#jobs.has(run.runId)) reject("Wait for the active turn to finish.");
        const record = live.store.listAgentSessions(run.runId).find((s) => s.actor === "CHATGPT_WEB_AGENT");
        const binding = this.#transport?.snapshot?.binding;
        if (record?.sessionId !== payload.sessionId || binding?.runId !== run.runId) reject("Exact Web session binding is unavailable.");
        return this.#webSession.resume({ binding, focus: type === "web.session.focus" });
      }
      case "evidence.export":
        return redactForEvidence({ ...(await this.snapshot(run.runId)), proposals: live.store.listProposalArtifacts(run.runId) });
      default: reject(`Unsupported command: ${type}`, "COMMAND_UNAVAILABLE");
    }
  }

  async executeDurable(command) {
    if (typeof command.requestId !== "string" || !command.requestId || command.requestId.length > 200) reject("A bounded command requestId is required.");
    const live = await this.#getRuntime();
    const store = live.codeChanges?.store;
    if (!store) reject("Durable command storage is unavailable.");
    const hash = sha256CanonicalJson(command);
    const existing = store.receipt(command.requestId);
    if (existing && existing.request_hash !== hash) reject("requestId was already used for a different command.", "RUN_VERSION_CONFLICT");
    if (this.#receipts.has(command.requestId)) return this.#receipts.get(command.requestId);
    if (existing) {
      if (existing.status !== "COMPLETED") reject("Previous command outcome is uncertain; inspect the run before acting. No automatic resubmission.", "RECOVERY_REQUIRED");
      const result = JSON.parse(String(existing.result_json));
      if (result.error) reject(result.error.message, result.error.code);
      return result.payload;
    }
    store.beginCommand(command.requestId, hash, command.payload?.runId ?? null);
    const promise = this.execute(command).then((payload) => {
      store.finishCommand(command.requestId, { payload: redactForEvidence(payload) }); return payload;
    }, (error) => {
      store.finishCommand(command.requestId, { error: { message: redactForEvidence(error.message), code: error.code || "COMMAND_FAILED" } }); throw error;
    }).finally(() => this.#receipts.delete(command.requestId));
    this.#receipts.set(command.requestId, promise);
    return promise;
  }

  close() { this.#closed = true; }

  async waitUntilSettled(runId) {
    await this.#jobs.get(runId);
    if (this.#errors.has(runId)) reject(this.#errors.get(runId), "LIVE_RUN_FAILED");
    const live = await this.#getRuntime();
    const run = live.store.getRun(runId);
    return { runId, status: run.phase, outcome: live.store.getRunOutcome(runId) };
  }
}
