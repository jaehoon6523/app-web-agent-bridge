import fs from "node:fs";
import path from "node:path";
import { closeSteps } from '../diagnostics/shutdown.js';
import { ArtifactStore } from "../evidence/artifact-store.js";
import { LiveDiscussionComposition } from "../orchestration/live-discussion-composition.js";
import { SqliteStore } from "../persistence/sqlite-store.js";
import { CodeChangeStore } from "../persistence/code-change-store.js";
import { initializeSqlite, DEFAULT_SQLITE_BUSY_TIMEOUT_MS } from "../persistence/sqlite-initialization.js";
import { CodeChangeService } from "../orchestration/code-change-service.js";
import { readAuditProject } from "../orchestration/audit-project.js";
import {
  CodexProcessManager,
  createCodexAgentSessionAdapter,
} from "./codex/index.js";

export class LiveDiscussionRuntimeError extends Error {
  constructor(message, code = "LIVE_DISCUSSION_RUNTIME_ERROR", details = null) {
    super(message);
    this.name = "LiveDiscussionRuntimeError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Creates the production composition without opening a thread or submitting a
 * prompt. provisionRun() is the explicit effect boundary.
 */
/** @param {{runtimeConfig: any, webSession: any, reviewerWebSessions?: {JUDGE?: any, CRITIC?: any} | null, reviewerWebProviders?: Record<string, any> | null, onDiagnostic?: (event: any) => void, initializationSignal?: AbortSignal}} input */
export async function createLiveDiscussionRuntime({
  runtimeConfig,
  webSession,
  reviewerWebSessions = null,
  reviewerWebProviders = null,
  onDiagnostic,
  initializationSignal,
}) {
  if (runtimeConfig?.demoMode === true) {
    throw new LiveDiscussionRuntimeError("Demo mode cannot create a live discussion runtime.", "DEMO_MODE_FORBIDDEN");
  }
  if (!webSession || typeof webSession.start !== "function") {
    throw new LiveDiscussionRuntimeError("A ChatGPT Web session adapter is required.", "WEB_ADAPTER_REQUIRED");
  }

  // DatabaseSync creates the database file but not its parent directory. The
  // persistence root must exist before any live run is provisioned.
  fs.mkdirSync(path.dirname(runtimeConfig.persistence.databasePath), { recursive: true });
  // Only unpublished SQLite setup is retried. Recovery, provider commands and
  // user mutations run once, after both handles have been acquired.
  const {store, codeStore, artifactStore} = await initializeSqlite(() => {
    const store = new SqliteStore({filename:runtimeConfig.persistence.databasePath, busyTimeoutMs:0, onDiagnostic});
    try {
      let artifactStore;
      try { artifactStore = new ArtifactStore(runtimeConfig.persistence.artifactDirectory); }
      catch (cause) {
        throw new LiveDiscussionRuntimeError("Artifact store initialization failed before runtime startup.",
          "ARTIFACT_STORE_INITIALIZATION_FAILED", {cause});
      }
      const codeStore = new CodeChangeStore(runtimeConfig.persistence.databasePath, {busyTimeoutMs:0, onDiagnostic, verification:"background"});
      return {store, codeStore, artifactStore};
    } catch (error) {
      try { store.close(); }
      catch (cleanup) { throw Object.assign(new AggregateError([error, cleanup], "Runtime setup and controller store close failed.", {cause:error}), {code:"LIVE_RUNTIME_CLEANUP_FAILED"}); }
      throw error;
    }
  }, {signal:initializationSignal, onBusy:() => onDiagnostic?.({type:"runtime.initialization.sqlite-busy"})});
  let manager;
  try {
    initializationSignal?.throwIfAborted();
    await codeStore.prepareForRead({signal:initializationSignal});
    initializationSignal?.throwIfAborted();
    const composition = new LiveDiscussionComposition({
      store,
      artifactStore,
      createCodexSession: async ({ persistThreadBinding }) => {
        if (!manager) manager = await CodexProcessManager.create({ executablePath: runtimeConfig.codex?.executablePath,
          workspaceRoot: runtimeConfig.workspace, authPathKeys: runtimeConfig.codex?.authPathKeys });
        return createCodexAgentSessionAdapter({ manager, workspaceRoot: runtimeConfig.workspace, mode: "DISCUSSION",
          approvalPolicy: runtimeConfig.codex.approvalPolicy, persistThreadId: persistThreadBinding });
      },
      createWebSession: () => webSession,
    });

    let closePromise;
    const codeChanges = new CodeChangeService({ filename: runtimeConfig.persistence.databasePath, store:codeStore,
      artifactStore, webSession, reviewerWebSessions, reviewerWebProviders,
      project: runtimeConfig.auditProject ?? readAuditProject(runtimeConfig.auditProjectFile).project, codex: {
        executablePath: runtimeConfig.codex?.executablePath, authPathKeys: runtimeConfig.codex?.authPathKeys,
        approvalPolicy: runtimeConfig.codex?.approvalPolicy,
      }, workerConfig: runtimeConfig.codeWorker, onDiagnostic });
    // Keep the established contention policy for ordinary runtime transactions.
    // The no-wait policy is confined to unpublished initialization and recovery.
    store.setBusyTimeout(DEFAULT_SQLITE_BUSY_TIMEOUT_MS);
    codeStore.setBusyTimeout(DEFAULT_SQLITE_BUSY_TIMEOUT_MS);
    return Object.freeze({
      codeChanges,
      artifactStore,
      composition,
      get manager() { return manager; },
      store,
      async close() {
        if (!closePromise) closePromise = closeSteps([
          ['composition.close',()=>composition.close()],
          ['worker registry close',()=>codeChanges.close()],
          ['Codex process close',()=>manager?.close()],
          ['controller store close',()=>store.close()],
        ], (type,detail)=>onDiagnostic?.({type,...detail}));
        return closePromise;
      },
    });
  } catch (error) {
    const errors = [error];
    try { await codeStore.close(); } catch (cleanup) { errors.push(cleanup); }
    try { store.close(); } catch (cleanup) { errors.push(cleanup); }
    if (errors.length > 1) throw Object.assign(new AggregateError(errors, "Runtime initialization and resource cleanup failed.", {cause:error}), {code:"LIVE_RUNTIME_CLEANUP_FAILED"});
    throw error;
  }
}
