import { createCodeChangeWorker as createCodexWorker } from "../code-change-worker.js";
import { createGenericJsonlWorker } from "./generic-jsonl-worker.js";

export async function createRegisteredCodeWorker({
  workerConfig,
  workspace,
  codex,
  persistThreadId,
  persistCapture,
}) {
  const provider = workerConfig?.provider || "codex";
  if (provider === "codex") {
    return createCodexWorker({
      workspace,
      ...codex,
      persistThreadId,
      persistCapture,
    });
  }
  const worker = await createGenericJsonlWorker({
    provider,
    model: workerConfig?.model ?? null,
    executablePath: workerConfig?.executablePath,
    args: workerConfig?.args ?? [],
    workspaceRoot: workspace.root,
  });
  return Object.freeze({
    ...worker,
    get externalSessionId() { return worker.externalSessionId; },
    async submitTurn(input) {
      const started = await worker.start();
      await persistThreadId(started.sessionId);
      const handle = await worker.submitTurn(input);
      const completion = Promise.resolve(handle.completion).then(async (result) => {
        const capture = workspace.capture({ allowUnchanged: true });
        await persistCapture({ threadId: result.sessionId, turnId: result.turnId, capture });
        return Object.freeze({ ...result, threadId: result.sessionId, capture });
      });
      return Object.freeze({ ...handle, completion });
    },
  });
}
