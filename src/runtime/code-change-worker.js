import { CodexProcessManager, createCodexAgentSessionAdapter } from "./codex/index.js";

/**
 * Uses the existing Codex adapter in a Controller-created Git worktree.
 * Persistence callbacks must finish before a captured result becomes available
 * to the caller. Review/approval and repeated dispatch remain Controller work.
 */
export async function createCodeChangeWorker({
  workspace, executablePath, authPathKeys = [], approvalPolicy,
  persistThreadId, persistCapture,
}) {
  if (typeof persistThreadId !== "function" || typeof persistCapture !== "function") {
    throw new TypeError("Controller thread and capture persistence callbacks are required.");
  }
  if (approvalPolicy === undefined) throw new TypeError("An explicit approval policy is required.");
  const manager = await CodexProcessManager.create({
    executablePath, workspaceRoot: workspace.root, authPathKeys,
  });
  try {
    const session = createCodexAgentSessionAdapter({
      manager, workspaceRoot: workspace.root, mode: "CODE_CHANGE", approvalPolicy, persistThreadId,
    });
    return bindCodeChangeCapture({
      session, workspace, persistCapture,
      close: async () => { try { await session.close(); } finally { await manager.close(); } },
    });
  } catch (error) {
    await manager.close();
    throw error;
  }
}

export function bindCodeChangeCapture({ session, workspace, persistCapture, close }) {
  let busy = false;
  let unavailable = false;
  return Object.freeze({
    start: () => session.start(),
    resume: (input) => session.resume(input),
    inspect: () => session.inspect(),
    steer: (input) => session.steer(input),
    interrupt: (input) => session.interrupt(input),
    respondToApproval: (input) => session.respondToApproval(input),
    onEvent: (listener) => session.onEvent(listener),
    close: async () => { unavailable = true; await close(); },
    async submitTurn(input) {
      if (busy || unavailable) throw new Error("Worker is active or requires recovery.");
      busy = true;
      try {
        const threadId = session.externalSessionId;
        if (typeof threadId !== "string" || !threadId) throw new Error("Worker has no persisted thread binding.");
        const handle = await session.submitTurn(input);
        if (typeof handle?.turnId !== "string" || !handle.turnId) throw new Error("Worker returned no turn binding.");
        const completion = Promise.resolve(handle.completion).then(async (result) => {
          if (result?.threadId !== threadId || result.turnId !== handle.turnId
            || result.status !== "completed" || session.externalSessionId !== threadId) {
            throw new Error("Worker completion does not match its submitted thread and turn.");
          }
          if (unavailable) throw new Error("Worker was stopped before capture.");
          const capture = workspace.capture({ allowUnchanged: true });
          await persistCapture({ threadId, turnId: handle.turnId, capture });
          return Object.freeze({ ...result, capture });
        }).catch((error) => {
          unavailable = true;
          throw error;
        }).finally(() => { busy = false; });
        return Object.freeze({ ...handle, completion });
      } catch (error) {
        busy = false;
        unavailable = true;
        throw error;
      }
    },
  });
}
