import fs from "node:fs";
import path from "node:path";
import { ArtifactStore } from "../evidence/artifact-store.js";
import { LiveDiscussionComposition } from "../orchestration/live-discussion-composition.js";
import { SqliteStore } from "../persistence/sqlite-store.js";
import { CodeChangeService } from "../orchestration/code-change-service.js";
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
/** @param {{runtimeConfig: any, webSession: any}} input */
export async function createLiveDiscussionRuntime({ runtimeConfig, webSession }) {
  if (runtimeConfig?.demoMode === true) {
    throw new LiveDiscussionRuntimeError("Demo mode cannot create a live discussion runtime.", "DEMO_MODE_FORBIDDEN");
  }
  if (!runtimeConfig?.codex?.executablePath) {
    throw new LiveDiscussionRuntimeError(
      "CODEX_EXECUTABLE must name an absolute Codex executable before live runtime composition.",
      "CODEX_EXECUTABLE_NOT_CONFIGURED",
    );
  }
  if (!webSession || typeof webSession.start !== "function") {
    throw new LiveDiscussionRuntimeError("A ChatGPT Web session adapter is required.", "WEB_ADAPTER_REQUIRED");
  }

  // DatabaseSync creates the database file but not its parent directory. The
  // persistence root must exist before any live run is provisioned.
  fs.mkdirSync(path.dirname(runtimeConfig.persistence.databasePath), { recursive: true });
  const store = new SqliteStore(runtimeConfig.persistence.databasePath);
  let artifactStore;
  let manager;
  try {
    artifactStore = new ArtifactStore(runtimeConfig.persistence.artifactDirectory);
    manager = await CodexProcessManager.create({
      executablePath: runtimeConfig.codex.executablePath,
      workspaceRoot: runtimeConfig.workspace,
      authPathKeys: runtimeConfig.codex.authPathKeys,
    });
  } catch (cause) {
    store.close();
    throw new LiveDiscussionRuntimeError(
      "Codex executable validation failed before app-server startup.",
      "CODEX_RUNTIME_CONFIGURATION_INVALID",
      { cause },
    );
  }

  const composition = new LiveDiscussionComposition({
    store,
    artifactStore,
    createCodexSession: ({ sessionId, persistThreadBinding }) => createCodexAgentSessionAdapter({
      manager,
      workspaceRoot: runtimeConfig.workspace,
      mode: "DISCUSSION",
      approvalPolicy: runtimeConfig.codex.approvalPolicy,
      persistThreadId: persistThreadBinding,
    }),
    createWebSession: () => webSession,
  });

  let closed = false;
  const codeChanges = new CodeChangeService({ filename: runtimeConfig.persistence.databasePath,
    artifactStore, webSession, codex: {
      executablePath: runtimeConfig.codex.executablePath, authPathKeys: runtimeConfig.codex.authPathKeys,
      approvalPolicy: runtimeConfig.codex.approvalPolicy,
    } });
  return Object.freeze({
    codeChanges,
    artifactStore,
    composition,
    manager,
    store,
    async close() {
      if (closed) return;
      closed = true;
      composition.close();
      await codeChanges.close();
      try { await manager.close(); }
      finally { store.close(); }
    },
  });
}
