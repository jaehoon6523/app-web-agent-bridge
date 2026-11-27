import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../src/config.js";
import { createBridgeServer } from "../src/server.js";
import { runPlainRoleLoop } from "../src/orchestration/plain-role-loop.js";
import { ArtifactStore } from "../src/evidence/artifact-store.js";
import { GitChangeWorkspace } from "../src/repository/git-change-workspace.js";
import { createCodeChangeWorker } from "../src/runtime/code-change-worker.js";

const [objectiveFile, transcriptFile, worktreePath] = process.argv.slice(2);
if (!objectiveFile || !transcriptFile || !process.env.CONTROLLER_DATA_DIR || !process.env.PORT) {
  throw new Error("Set CONTROLLER_DATA_DIR and PORT, then provide an objective file and a new transcript file.");
}
const objective = (await readFile(objectiveFile, "utf8")).trim();
if (!objective) throw new Error("The objective file is empty.");
const config = loadConfig();
const bridge = createBridgeServer({ runtimeConfig: config });
if (!bridge.extensionTransport || !bridge.webSession) throw new Error("Configure the isolated browser extension first.");
await appendFile(transcriptFile, "", { flag: "wx" });
let worker;
let threadId;
let workspace;
const record = async turn => {
  await appendFile(transcriptFile, JSON.stringify(turn) + "\n");
  console.log(turn.role, turn.runId, turn.conversationId ?? turn.threadId);
};

try {
  await bridge.listen();
  console.log(`Waiting for the isolated extension on port ${process.env.PORT}.`);
  const deadline = Date.now() + 180_000;
  while (!bridge.extensionTransport.authenticated) {
    if (Date.now() >= deadline) throw new Error("The isolated extension did not connect.");
    await delay(1_000);
  }
  const runId = await runPlainRoleLoop(bridge.webSession, objective, record, worktreePath
    ? async ({ runId, text, initial }) => {
      if (initial) {
        const artifacts = new ArtifactStore(path.join(path.dirname(path.resolve(transcriptFile)), "worker-artifacts"));
        workspace = GitChangeWorkspace.create({ targetRoot: config.workspace,
          workspaceRoot: path.resolve(worktreePath), artifactStore: artifacts });
        worker = await createCodeChangeWorker({ workspace, executablePath: config.codex.executablePath,
          authPathKeys: config.codex.authPathKeys, approvalPolicy: "never", model: config.codeWorker.model,
          persistThreadId: async binding => {
            await writeFile(transcriptFile + ".thread.json", JSON.stringify(binding), { flag: "wx" });
            threadId = binding.threadId;
          },
          persistCapture: async ({ turnId, capture }) =>
            writeFile(transcriptFile + `.${turnId}.diff`, artifacts.read(capture.artifact.sha256), { flag: "wx" }),
        });
        await worker.start();
      }
      const handle = await worker.submitTurn({ text, outputSchema: {
        type: "object", properties: { answer: { type: "string",
          description: "답변 본문은 일반 문장으로 작성하고 백틱, 코드 블록, 마크다운 서식을 쓰지 마세요." } },
        required: ["answer"], additionalProperties: false,
      } });
      const result = await handle.completion;
      if (!threadId || result.threadId !== threadId) throw new Error("Worker thread changed.");
      const diff = workspace.artifactStore.read(result.capture.artifact.sha256).toString("utf8");
      const { answer } = JSON.parse(result.text);
      if (typeof answer !== "string" || !answer.trim()) throw new Error("Worker returned no answer.");
      await record({ role: "WORKER", runId, threadId, turnId: result.turnId, sent: text,
        received: result.text, answer, diffSha256: result.capture.artifact.sha256, changedFiles: result.capture.changedFiles });
      if (initial && (result.capture.unchanged || result.capture.changedFiles.join() !== "status.txt")) {
        throw new Error("The isolated fixture must change status.txt only.");
      }
      return { received: answer, diff };
    } : undefined);
  console.log("Completed", runId);
} finally {
  try { await worker?.close(); } finally { await bridge.close(); }
}
