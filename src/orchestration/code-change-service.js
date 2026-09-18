import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CodeChangeStore } from "../persistence/code-change-store.js";
import { GitChangeWorkspace } from "../repository/git-change-workspace.js";
import { createRegisteredCodeWorker } from "../runtime/workers/registry.js";
import { canonicalConversationUrl, createWebSessionBinding, extractConversationId } from "../runtime/web/binding.js";
import { validateAuditProject } from "./audit-project.js";
import { requirementsRef, exactObject, uniqueItems, nonempty } from "../domain/audit-contract.js";
import { evidenceRecord, excerpt } from "../evidence/candidate-evidence.js";
import { auditCandidate, auditContext, performVerification } from "./audit-round.js";
import { evaluateCodeReview } from "../domain/code-review.js";
import { canonicalJson } from "../domain/canonical-json.js";
import { redactForEvidence } from "../security/redaction.js";
import { buildCodeWorkerPrompt, workerOutputSchema } from "./code-change-prompts.js";

const terminal = new Set(["APPLIED", "CANCELLED", "INCONCLUSIVE", "FAILED"]);
const stopped = new Set([...terminal, "STOPPING", "RECOVERY_REQUIRED", "HOLD", "AWAITING_APPLY"]);

function retryableWorkerTimeout(run) {
  const lastTurn = run?.workerTurns?.at(-1);
  const timeoutError = "External turn timed out; execution state requires recovery.";
  return run?.schemaVersion === 3
    && run.stage === "RECOVERY_REQUIRED"
    && run.terminationReason === "EXECUTION_UNCERTAIN"
    && lastTurn?.status === "failed"
    && lastTurn?.metadata?.error === timeoutError
    && run.candidate == null && run.capture == null && run.application == null
    && (run.candidates?.length ?? 0) === 0
    && (run.reviews?.length ?? 0) === 0;
}

export class CodeChangeService {
  constructor({ filename, artifactStore, webSession, codex, workerConfig = null, project = null, createWorker = createRegisteredCodeWorker }) {
    this.store = new CodeChangeStore(filename); this.artifactStore = artifactStore; this.web = webSession; this.codex = codex;
    this.project = project; this.workerConfig = workerConfig ?? { provider: "codex", model: null };
    this.createWorker = createWorker;
    this.jobs = new Map(); this.workers = new Map(); this.controls = new Map(); this.closed = false;
    this.recover();
  }
  list() { return this.store.list(); }
  get(id) { return this.store.get(id); }
  busy() { return this.jobs.size > 0 || this.list().some((r) => !terminal.has(r.stage)); }
  update(id, changes) {
    const run = this.get(id);
    const at = new Date().toISOString();
    const event = changes.stage && changes.stage !== run.stage
      ? [{ eventId: `event_${randomUUID()}`, type: "STAGE_CHANGED", createdAt: at, payload: { previous: run.stage, stage: changes.stage, reason: changes.terminationReason ?? changes.error ?? null } }] : [];
    return this.store.save({ ...run, ...redactForEvidence(changes), events: [...(changes.events ?? run.events ?? []), ...event] }, run.version);
  }
  assertActive(id) {
    const run = this.get(id);
    if (this.closed || this.controls.get(id)?.signal.aborted || !run || stopped.has(run.stage)) throw new Error("Run is stopped or requires recovery.");
  }
  async wait(id, promise) {
    this.assertActive(id);
    const control = this.controls.get(id), run = this.get(id);
    let timer, abort;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        abort = () => reject(new Error("Run was interrupted; no further work is permitted."));
        control.signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reject(new Error("External turn timed out; execution state requires recovery.")),
          Math.min(run.policy.turnTimeoutMs, Math.max(1, Date.parse(run.deadlineAt) - Date.now())));
      })]);
    } finally { clearTimeout(timer); control.signal.removeEventListener("abort", abort); }
  }
  recover() {
    for (const run of this.list()) {
      if (run.schemaVersion !== 3) {
        if (!terminal.has(run.stage)) this.update(run.runId, { stage: "RECOVERY_REQUIRED", auditResult: "UNVERIFIED_LEGACY", error: "Historical approval predates the current evidence/authority contract and cannot authorize application." });
        continue;
      }
      if (run.stage === "AWAITING_APPLY" || run.stage === "APPLYING") {
        try {
          this.assertApprovalCandidate(run);
          this.artifactStore.verify(run.capture.artifact.sha256);
          if (run.stage === "APPLYING") {
            if (!run.application || run.application.candidateId !== run.candidate.candidateId || run.application.reviewId !== run.reviews.at(-1).reviewId) throw new Error("Application binding mismatch.");
            const state = GitChangeWorkspace.targetApplicationState({ capture: run.capture, targetRoot: run.targetRoot, artifactStore: this.artifactStore });
            this.update(run.runId, { stage: state === "APPLIED" ? "APPLIED" : state === "NOT_APPLIED" ? "AWAITING_APPLY" : "RECOVERY_REQUIRED",
              application: { ...run.application, status: state }, error: state === "AMBIGUOUS" ? "Target differs from base and approved candidate." : null });
          }
          continue;
        } catch (error) { this.update(run.runId, { stage: "RECOVERY_REQUIRED", error: error.message }); continue; }
      }
      if (!terminal.has(run.stage) && run.stage !== "HOLD") this.update(run.runId, { stage: "RECOVERY_REQUIRED", error: "Server restarted during execution. No automatic resubmission or patch application." });
    }
  }
  async startPrepared(input, preparation) {
    if (preparation.agreement.status !== "APPROVED" || !preparation.reservedRunId) throw new Error("An approved preparation is required.");
    const existing = this.get(preparation.reservedRunId);
    if (existing) {
      if (existing.preparationId !== preparation.preparationId) throw new Error("Preparation/run identity mismatch.");
      return { runId: existing.runId, status: "ACCEPTED" };
    }
    return this.start(input, preparation);
  }
  async start(input, preparation = null) {
    if (this.closed || this.busy()) throw new Error("Another code change is unfinished.");
    nonempty(input.objective, "objective");
    // Project settings are supplied by the server, never selected by a browser command.
    const project = validateAuditProject(this.project);
    const ref = requirementsRef(project.requirements);
    const earlier = this.list().filter((r) => r.requirementsRef?.requirementsId === ref.requirementsId);
    if (earlier.some((r) => r.requirementsRef.revision === ref.revision && r.requirementsRef.hash !== ref.hash)) throw new Error("Changed requirements must use a new revision; previous audit authority cannot be reused.");
    const conversationUrl = canonicalConversationUrl(input.conversationUrl), conversationId = extractConversationId(conversationUrl);
    if (!conversationUrl || !conversationId) throw new TypeError("An exact ChatGPT conversation is required.");
    const target = GitChangeWorkspace.preflight(project.targetRoot);
    const runId = preparation?.reservedRunId ?? `code_${randomUUID()}`, createdAt = new Date().toISOString();
    this.store.save({ schemaVersion: 3, runId, mode: "CODE_CHANGE", stage: "CREATED", objective: input.objective,
      preparationId: preparation?.preparationId ?? null, preparationSnapshot: preparation,
      projectRef: { projectId: project.projectId, targetRoot: target.targetRoot }, ...target,
      workspaceRoot: null, requirements: project.requirements, requirementsRef: ref,
      requirementsChange: earlier.at(-1)?.requirementsRef && earlier.at(-1).requirementsRef.hash !== ref.hash
        ? { previousRef: earlier.at(-1).requirementsRef, currentRef: ref, effect: "Previous reviews remain historical and do not approve this run." } : null,
      policy: project.policy, verifications: project.verifications, maxIterations: project.policy.maxIterations,
      conversationUrl, conversationId, iteration: 0, evidenceRounds: 0, captures: [], capture: null, candidate: null,
      candidates: [], evidence: [], findings: [], reviews: [], requests: [], verificationIntents: [], supplementResults: [],
      worker: { provider: this.workerConfig.provider, model: this.workerConfig.model ?? null },
      workerTurns: [],
      messages: [], events: [{ eventId: `event_${randomUUID()}`, type: "RUN_ACCEPTED", createdAt, payload: { stage: "CREATED" } }],
      auditResult: null, application: null, terminationReason: null, missingInformation: [], error: null, createdAt,
      deadlineAt: new Date(Date.now() + project.policy.totalTimeoutMs).toISOString() });
    this.controls.set(runId, new AbortController());
    const totalTimer = setTimeout(() => {
      const run = this.get(runId);
      if (this.jobs.has(runId) && !stopped.has(run.stage)) {
        void this.terminate(runId).catch(() => {});
        this.update(runId, { stage: "RECOVERY_REQUIRED", terminationReason: "TOTAL_TIME_LIMIT", error: "Total time limit reached; verify external termination before recovery." });
      }
    }, project.policy.totalTimeoutMs);
    const job = Promise.resolve().then(() => this.execute(runId)).catch(async (error) => {
      const run = this.get(runId);
      if (!this.closed && !stopped.has(run.stage)) {
        await this.terminate(runId);
        this.update(runId, { stage: "RECOVERY_REQUIRED", error: error.message, terminationReason: Date.now() >= Date.parse(run.deadlineAt) ? "TOTAL_TIME_LIMIT" : "EXECUTION_UNCERTAIN" });
      }
    }).finally(() => { clearTimeout(totalTimer); this.jobs.delete(runId); });
    this.jobs.set(runId, job);
    return { runId, status: "ACCEPTED" };
  }
  async execute(runId) {
    this.assertActive(runId);
    let run = this.update(runId, { stage: "PROVISIONING" });
    const root = path.join(path.dirname(run.targetRoot), ".bridge-worktrees");
    fs.mkdirSync(root, { recursive: true });
    const workspace = GitChangeWorkspace.create({ targetRoot: run.targetRoot, workspaceRoot: path.join(root, runId), artifactStore: this.artifactStore });
    if (workspace.baseCommit !== run.baseCommit) throw new Error("Target base changed after run acceptance.");
    this.update(runId, { workspaceRoot: workspace.root });
    while (true) {
      this.assertActive(runId);
      run = this.get(runId);
      run = this.update(runId, { stage: "WORKER_RUNNING", iteration: run.iteration + 1, auditResult: null });
      const creation = this.createWorker({ workerConfig: this.workerConfig, workspace, codex: this.codex,
        persistThreadId: async (value) => { this.assertActive(runId); this.update(runId, { workerThread: value }); },
        persistCapture: async (value) => { this.assertActive(runId); this.update(runId, { stage: "CANDIDATE_CAPTURE", capture: value.capture, workerTurnId: value.turnId }); } });
      creation.then(async (worker) => { if (this.controls.get(runId)?.signal.aborted || this.closed) await worker.close(); }).catch(() => {});
      const worker = await this.wait(runId, creation);
      this.workers.set(runId, worker);
      let completed;
      try {
        this.assertActive(runId); await this.wait(runId, worker.start()); this.assertActive(runId);
        const text = buildCodeWorkerPrompt(run);
        const startedAt = new Date().toISOString();
        const inputRef = this.artifactStore.put(redactForEvidence(text), { mimeType: "text/plain", redacted: true });
        const handle = await this.wait(runId, worker.submitTurn({ text, outputSchema: workerOutputSchema }));
        this.assertActive(runId); this.update(runId, { workerTurnId: handle.turnId });
        try {
          completed = await this.wait(runId, handle.completion); this.assertActive(runId);
          const finishedAt = new Date().toISOString();
          const outputRef = this.artifactStore.put(redactForEvidence(completed.text), { mimeType: "text/plain", redacted: true });
          const current = this.get(runId);
          this.update(runId, { worker: {
              provider: completed.provider || this.workerConfig.provider,
              model: completed.model || this.workerConfig.model || null,
              sessionId: completed.sessionId || completed.threadId || current.workerThread || null,
            },
            workerTurns: [...(current.workerTurns ?? []), {
              turnId: handle.turnId,
              sessionId: completed.sessionId || completed.threadId || current.workerThread || null,
              provider: completed.provider || this.workerConfig.provider,
              model: completed.model || this.workerConfig.model || null,
              startedAt,
              finishedAt,
              durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
              status: "completed",
              inputRef,
              outputRef,
              usage: completed.usage ?? null,
              metadata: completed.metadata ?? null,
            }] });
        } catch (error) {
          const finishedAt = new Date().toISOString();
          const current = this.get(runId);
          this.update(runId, { workerTurns: [...(current.workerTurns ?? []), {
            turnId: handle.turnId, sessionId: current.workerThread ?? null,
            provider: this.workerConfig.provider, model: this.workerConfig.model ?? null,
            startedAt, finishedAt,
            durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
            status: "failed", inputRef, outputRef: null, usage: null,
            metadata: { error: redactForEvidence(error.message) },
          }] });
          throw error;
        }
      } finally { await worker.close(); this.workers.delete(runId); }
      this.assertActive(runId);
      if (GitChangeWorkspace.preflight(run.targetRoot).baseCommit !== run.baseCommit) throw new Error("Target changed during implementation; inspect the target before proceeding.");
      const capture = completed.capture;
      workspace.assertCandidate(capture);
      let report;
      try { report = JSON.parse(completed.text); this.validateWorkerReport(report, run); }
      catch (error) { throw new Error(`Worker report is incomplete; candidate retained for recovery: ${error.message}`); }
      const candidateId = `candidate_${randomUUID()}`;
      const candidate = { candidateId, runId, iteration: run.iteration, baseCommit: capture.baseCommit,
        candidateTree: capture.candidateTree, patchHash: capture.artifact.sha256, changedFiles: capture.changedFiles, unchanged: capture.unchanged };
      const patch = this.artifactStore.read(capture.artifact.sha256).toString("utf8");
      run = this.get(runId);
      const findings = run.findings.map((f) => {
        const response = report.findingResponses.find((r) => r.findingId === f.findingId);
        return response ? { ...f, status: "FIX_SUBMITTED", history: [...f.history, { status: "FIX_SUBMITTED", candidateId, at: new Date().toISOString(), reason: response.explanation }] } : f;
      });
      this.update(runId, { stage: "VERIFYING", candidate, capture, candidates: [...run.candidates, candidate], findings,
        evidence: [...run.evidence, evidenceRecord(this.artifactStore, candidateId, "PATCH", patch, { unchanged: capture.unchanged }),
          evidenceRecord(this.artifactStore, candidateId, "AGENT_CLAIM", report, {}, "AGENT")],
        messages: [...run.messages, { messageId: `worker_${run.iteration}`, fromActor: (completed.provider || this.workerConfig.provider) === "codex" ? "CODEX_AGENT" : "CODE_WORKER", workerProvider: completed.provider || this.workerConfig.provider, content: completed.text, createdAt: new Date().toISOString() }] });
      for (const verification of run.verifications) await performVerification(this, runId, workspace, verification);
      run = this.get(runId);
      const binding = createWebSessionBinding({ sessionId: `web_${runId}`, runId, tabId: null, windowId: null,
        conversationUrl: run.conversationUrl, conversationId: run.conversationId, title: null,
        lastObservedUserMessageId: null, lastObservedAssistantMessageId: null, bindingStatus: "NEEDS_REBIND" });
      await this.wait(runId, this.web.resume({ binding }));
      this.assertActive(runId);
      await auditCandidate(this, runId, workspace);
      if (this.get(runId).stage !== "REWORK") return;
    }
  }
  validateWorkerReport(report, run) {
    exactObject(report, ["summary", "requirementClaims", "findingResponses", "unverified"]);
    nonempty(report.summary, "worker summary"); uniqueItems(report.requirementClaims, "requirementId", "worker claims");
    uniqueItems(report.findingResponses, "findingId", "worker finding responses");
    const open = run.findings.filter((f) => ["OPEN", "FIX_SUBMITTED"].includes(f.status));
    if (report.requirementClaims.length !== run.requirements.items.length || report.requirementClaims.some((c) => !run.requirements.items.some((r) => r.requirementId === c.requirementId))) throw new Error("Every requirement needs a claim.");
    if (report.findingResponses.length !== open.length || report.findingResponses.some((r) => !open.some((f) => f.findingId === r.findingId))) throw new Error("Every unresolved finding needs a response.");
    for (const item of report.requirementClaims) nonempty(item.claim, "claim");
    for (const item of report.findingResponses) nonempty(item.explanation, "fix explanation");
    if (!Array.isArray(report.unverified) || report.unverified.some((i) => typeof i !== "string")) throw new Error("unverified must be a string array.");
  }
  assertApprovalCandidate(run) {
    const review = run.reviews?.at(-1);
    if (run.schemaVersion !== 3 || !review || review.decision !== "PASS" || run.auditResult !== "PASS"
      || review.candidateId !== run.candidate?.candidateId || run.capture.candidateTree !== run.candidate.candidateTree
      || run.capture.artifact.sha256 !== run.candidate.patchHash || run.capture.baseCommit !== run.baseCommit
      || canonicalJson(requirementsRef(run.requirements)) !== canonicalJson(run.requirementsRef)
      || canonicalJson(review.requirementsRef) !== canonicalJson(run.requirementsRef)) throw new Error("Approval does not identify a valid reviewed candidate.");
    for (const evidence of run.evidence.filter((e) => e.candidateId === run.candidate.candidateId)) this.artifactStore.verify(evidence.contentRef.sha256);
    if (evaluateCodeReview(review.report, auditContext(run, review.requestId)).decision !== "PASS") throw new Error("Required findings or evidence prevent application.");
  }
  reconcile(run) {
    const observations = [];
    let classification = "CONSISTENT";
    try {
      const target = GitChangeWorkspace.inspectTarget(run.targetRoot);
      observations.push({ source: "target", head: target.head, clean: target.status === "", status: target.status, observedAt: target.observedAt });
      if (run.baseCommit && target.head !== run.baseCommit) classification = "RECOVERY_REQUIRED";
    } catch (error) {
      observations.push({ source: "target", state: "UNAVAILABLE", reason: error.message });
      classification = "RECOVERY_REQUIRED";
    }
    const workspaceExists = typeof run.workspaceRoot === "string" && run.workspaceRoot !== "" && fs.existsSync(run.workspaceRoot);
    observations.push({ source: "workspace", state: workspaceExists ? "PRESENT" : run.workspaceRoot ? "MISSING" : "NOT_CREATED", path: run.workspaceRoot ?? null });
    if (run.workspaceRoot && !workspaceExists && !terminal.has(run.stage)) classification = "ORPHANED";
    observations.push({ source: "controller", localJob: this.jobs.has(run.runId), workerAttached: this.workers.has(run.runId), stage: run.stage });
    if (run.stage === "RECOVERY_REQUIRED") classification = "RECOVERY_REQUIRED";
    if (classification === "CONSISTENT" && ["HOLD", "AWAITING_APPLY"].includes(run.stage)
      && !this.jobs.has(run.runId) && !this.workers.has(run.runId)) classification = "RECOVERABLE";
    if (run.capture && ["AWAITING_APPLY", "APPLYING", "APPLIED", "RECOVERY_REQUIRED"].includes(run.stage)) {
      try {
        const applicationState = GitChangeWorkspace.targetApplicationState({
          capture: run.capture, targetRoot: run.targetRoot, artifactStore: this.artifactStore,
        });
        observations.push({ source: "application", state: applicationState });
        if (run.stage === "AWAITING_APPLY" && applicationState !== "NOT_APPLIED") classification = "RECOVERY_REQUIRED";
        if (run.stage === "APPLIED" && applicationState !== "APPLIED") classification = "RECOVERY_REQUIRED";
        if (run.stage === "APPLYING") classification = "RECOVERY_REQUIRED";
      } catch (error) {
        observations.push({ source: "application", state: "UNAVAILABLE", reason: error.message });
        classification = "RECOVERY_REQUIRED";
      }
    }
    const allowedActions = [];
    if (classification === "RECOVERY_REQUIRED" && run.stage === "RECOVERY_REQUIRED"
      && !this.jobs.has(run.runId) && !this.workers.has(run.runId)) allowedActions.push("run.abandon");
    if (classification === "RECOVERABLE" && run.stage === "AWAITING_APPLY") allowedActions.push("code.apply");
    return redactForEvidence({ runId: run.runId, classification, observations, allowedActions, readOnly: true, observedAt: new Date().toISOString() });
  }
  async terminate(id) {
    this.controls.get(id)?.abort();
    const run = this.get(id), results = [];
    const worker = this.workers.get(id);
    if (worker) {
      try { await worker.close(); results.push({ actor: "CLI", confirmed: true }); }
      catch (error) { results.push({ actor: "CLI", confirmed: false, reason: error.message }); }
    }
    if (["REVIEW_RUNNING", "REPORT_REPAIR"].includes(run.stage) || this.web.activeTurnId === run.reviewTurnId && run.reviewTurnId) {
      try { await this.web.interrupt({ turnId: run.reviewTurnId }); results.push({ actor: "WEB", confirmed: true }); }
      catch (error) { results.push({ actor: "WEB", confirmed: false, reason: error.message }); }
    }
    if (run.stage === "PROVISIONING") results.push({ actor: "WEB_PROVISIONING", confirmed: false, reason: "Provisioning cancellation cannot be confirmed." });
    return results;
  }
  async command(type, payload) {
    const run = this.get(payload.runId);
    if (!run || run.version !== payload.expectedVersion) throw Object.assign(new Error("Run changed; refresh."), { code: "RUN_VERSION_CONFLICT" });
    if (type === "evidence.export") return redactForEvidence(run);
    if (type === "evidence.get") {
      const e = run.evidence?.find((e) => e.evidenceId === payload.evidenceId);
      if (!e) throw new Error("Unknown evidence in this run.");
      return { ...e, ...excerpt(this.artifactStore.read(e.contentRef.sha256).toString("utf8"), payload.startLine, payload.endLine) };
    }
    if (type === "run.reconcile") return this.reconcile(run);
    if (type === "run.retry") {
      if (!retryableWorkerTimeout(run) || this.jobs.has(run.runId) || this.workers.has(run.runId)) {
        throw new Error("Only a settled pre-candidate Worker timeout can be retried.");
      }
      const target = GitChangeWorkspace.preflight(run.targetRoot);
      if (target.baseCommit !== run.baseCommit) {
        throw new Error("Target HEAD changed after the failed Worker turn; retry is refused.");
      }
      if (run.workspaceRoot && fs.existsSync(run.workspaceRoot)) {
        const oldWorkspace = new GitChangeWorkspace({
          workspaceRoot: run.workspaceRoot,
          baseCommit: run.baseCommit,
          artifactStore: this.artifactStore,
          targetRoot: run.targetRoot,
        });
        oldWorkspace.cleanup();
      } else if (run.workspaceRoot) {
        GitChangeWorkspace.pruneMissingWorktrees(run.targetRoot);
      }
      this.controls.set(run.runId, new AbortController());
      const previousError = run.error;
      const previousTurnId = run.workerTurns?.at(-1)?.turnId ?? null;
      const retryAt = new Date().toISOString();
      const reset = this.update(run.runId, {
        stage: "CREATED", workspaceRoot: null, workerThread: null, workerTurnId: null,
        error: null, terminationReason: null, stopRequested: false,
        deadlineAt: new Date(Date.now() + run.policy.totalTimeoutMs).toISOString(),
        recoveryAttempts: [...(run.recoveryAttempts ?? []), {
          kind: "WORKER_TIMEOUT_RETRY", at: retryAt, previousError, previousTurnId,
        }],
      });
      const totalTimer = setTimeout(() => {
        const current = this.get(run.runId);
        if (this.jobs.has(run.runId) && !stopped.has(current.stage)) {
          void this.terminate(run.runId).catch(() => {});
          this.update(run.runId, { stage: "RECOVERY_REQUIRED", terminationReason: "TOTAL_TIME_LIMIT", error: "Total time limit reached; verify external termination before recovery." });
        }
      }, run.policy.totalTimeoutMs);
      const job = Promise.resolve().then(() => this.execute(run.runId)).catch(async (error) => {
        const current = this.get(run.runId);
        if (!this.closed && !stopped.has(current.stage)) {
          await this.terminate(run.runId);
          this.update(run.runId, { stage: "RECOVERY_REQUIRED", error: error.message, terminationReason: Date.now() >= Date.parse(current.deadlineAt) ? "TOTAL_TIME_LIMIT" : "EXECUTION_UNCERTAIN" });
        }
      }).finally(() => { clearTimeout(totalTimer); this.jobs.delete(run.runId); });
      this.jobs.set(run.runId, job);
      return { runId: reset.runId, status: "RETRY_ACCEPTED" };
    }
    if (type === "run.abandon") {
      if (run.stage !== "RECOVERY_REQUIRED" || this.jobs.has(run.runId) || this.workers.has(run.runId)) throw new Error("Recovery abandonment requires settled local work; stop active work or restart after checking external termination.");
      if (payload.externalTerminationConfirmed !== true || payload.targetInspected !== true) throw new Error("Confirm external termination and target inspection before abandonment.");
      nonempty(payload.reason, "Recovery reason");
      const targetObservation = GitChangeWorkspace.inspectTarget(run.targetRoot);
      // This is an authenticated operator attestation, never an automated claim of remote termination.
      return this.update(run.runId, { stage: "CANCELLED", stopRequested: true, terminationReason: "RECOVERY_ABANDONED",
        recovery: { kind: "OPERATOR_ATTESTATION", actor: "LOCAL_AUTHENTICATED_USER", reason: payload.reason.trim(),
          externalTerminationConfirmed: true, targetInspected: true, targetObservation, at: new Date().toISOString(),
          previousReason: run.terminationReason, previousError: run.error } });
    }
    if (type === "run.stop") {
      if (terminal.has(run.stage) || run.stage === "APPLYING") throw new Error("Command unavailable for this run.");
      this.update(run.runId, { stage: "STOPPING", stopRequested: true });
      const results = await this.terminate(run.runId);
      if (["PROVISIONING", "RECOVERY_REQUIRED", "VERIFYING", "EVIDENCE_SUPPLEMENT"].includes(run.stage)) results.push({ actor: "EXTERNAL", confirmed: false, reason: "External state cannot be confirmed at stop acceptance." });
      if (["REVIEW_RUNNING", "REPORT_REPAIR"].includes(run.stage) && !results.some((r) => r.actor === "WEB")) {
        try { await this.web.interrupt({ turnId: run.reviewTurnId }); results.push({ actor: "WEB", confirmed: true }); }
        catch (error) { results.push({ actor: "WEB", confirmed: false, reason: error.message }); }
      }
      const uncertain = results.some((r) => !r.confirmed) || (this.jobs.has(run.runId) && !this.workers.has(run.runId) && run.stage === "WORKER_RUNNING");
      return this.update(run.runId, { stage: uncertain ? "RECOVERY_REQUIRED" : "CANCELLED", stopResults: results, terminationReason: uncertain ? "STOP_UNCERTAIN" : "USER_STOP" });
    }
    if (type !== "code.apply" || run.stage !== "AWAITING_APPLY" || this.jobs.has(run.runId) || run.stopRequested) throw new Error("Command unavailable for this code change.");
    this.assertApprovalCandidate(run);
    const capture = run.capture, review = run.reviews.at(-1);
    if (payload.candidateId !== run.candidate.candidateId || payload.reviewId !== review.reviewId
      || payload.artifactHash !== capture.artifact.sha256 || payload.baseCommit !== run.baseCommit) throw new Error("Approval does not identify the reviewed candidate.");
    const workspace = new GitChangeWorkspace({ workspaceRoot: run.workspaceRoot, baseCommit: run.baseCommit, artifactStore: this.artifactStore, targetRoot: run.targetRoot });
    const application = { applicationId: `application_${randomUUID()}`, candidateId: run.candidate.candidateId, reviewId: review.reviewId, baseCommit: run.baseCommit, status: "APPLYING", createdAt: new Date().toISOString() };
    this.update(run.runId, { stage: "APPLYING", application });
    try {
      const applied = workspace.apply({ capture, targetRoot: run.targetRoot });
      return this.update(run.runId, { stage: "APPLIED", application: { ...application, status: "APPLIED", result: applied }, applied });
    } catch (error) {
      this.update(run.runId, { stage: "RECOVERY_REQUIRED", application: { ...application, status: "UNCERTAIN", result: { error: error.message } }, error: error.message });
      throw error;
    }
  }
  snapshot(runId, preflight) {
    const record = this.get(runId);
    return redactForEvidence({ run: { ...record, phase: record.stage, currentTurn: record.iteration * 2, maxTurns: record.maxIterations * 2,
      activeActor: record.stage === "WORKER_RUNNING"
        ? (record.worker?.provider === "codex" ? "CODEX_AGENT" : "CODE_WORKER")
        : ["REVIEW_RUNNING", "REPORT_REPAIR"].includes(record.stage) ? "CHATGPT_WEB_AGENT" : null },
      sessions: [], messages: record.messages, deliveries: [], approvals: record.application ? [record.application] : [], events: record.events ?? [],
      findings: record.findings ?? [], assessments: record.reviews?.at(-1)?.report.assessments ?? [], evidence: record.evidence ?? [],
      outcome: { type: record.stage, auditResult: record.auditResult, applicationStatus: record.application?.status ?? "NOT_APPLIED", reason: record.terminationReason },
      error: record.error, drafts: {}, starting: record.stage === "PROVISIONING", preflight,
      commandCapabilities: ["state.get", "evidence.export", "evidence.get", "run.reconcile",
        ...(!terminal.has(record.stage) && record.stage !== "APPLYING" ? ["run.stop"] : []),
        ...(retryableWorkerTimeout(record) && !this.jobs.has(runId) && !this.workers.has(runId) ? ["run.retry"] : []),
        ...(record.stage === "RECOVERY_REQUIRED" && !this.jobs.has(runId) && !this.workers.has(runId) ? ["run.abandon"] : []),
        ...(record.stage === "AWAITING_APPLY" && !this.jobs.has(runId) && record.schemaVersion === 3 ? ["code.apply"] : [])] });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const id of this.jobs.keys()) await this.terminate(id);
    await Promise.allSettled([...this.jobs.values()]);
    this.store.close();
  }
}
