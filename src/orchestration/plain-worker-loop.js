import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ArtifactStore } from "../evidence/artifact-store.js";
import { GitChangeWorkspace } from "../repository/git-change-workspace.js";
import { createCodeChangeWorker } from "../runtime/code-change-worker.js";
import { runPlainRoleLoop } from "./plain-role-loop.js";

const outputSchema = {
  type: "object", properties: { answer: { type: "string",
    description: "답변 본문은 일반 문장으로 작성하고 백틱, 코드 블록, 마크다운 서식을 쓰지 마세요." } },
  required: ["answer"], additionalProperties: false,
};

export async function runPlainWorkerLoop({ web, config, objective, directory, runId, onTurn }) {
  await mkdir(directory, { recursive: true });
  const transcript = path.join(directory, "transcript.jsonl");
  const artifacts = new ArtifactStore(path.join(directory, "artifacts"));
  const workspace = GitChangeWorkspace.create({ targetRoot: config.workspace,
    workspaceRoot: path.join(directory, "worktree"), artifactStore: artifacts });
  let threadId;
  const worker = await createCodeChangeWorker({ workspace, executablePath: config.codex.executablePath,
    authPathKeys: config.codex.authPathKeys, approvalPolicy: "never", model: config.codeWorker.model,
    persistThreadId: async binding => {
      await writeFile(path.join(directory, "worker-thread.json"), JSON.stringify(binding), { flag: "wx" });
      threadId = binding.threadId;
    },
    persistCapture: async ({ turnId, capture }) =>
      writeFile(path.join(directory, `${turnId}.diff`), artifacts.read(capture.artifact.sha256), { flag: "wx" }),
  });
  const record = async turn => {
    await appendFile(transcript, JSON.stringify(turn) + "\n");
    onTurn?.(turn);
  };
  try {
    await worker.start();
    return await runPlainRoleLoop(web, objective, record, async ({ runId, text, initial }) => {
      const handle = await worker.submitTurn({ text, outputSchema });
      const result = await handle.completion;
      if (!threadId || result.threadId !== threadId) throw new Error("Worker thread changed.");
      const { answer } = JSON.parse(result.text);
      if (typeof answer !== "string" || !answer.trim()) throw new Error("Worker returned no answer.");
      const patch = artifacts.read(result.capture.artifact.sha256);
      const diff = patch.toString("utf8");
      await record({ role: "WORKER", runId, threadId, turnId: result.turnId, sent: text,
        received: result.text, answer, diffSha256: result.capture.artifact.sha256,
        changedFiles: result.capture.changedFiles });
      if (initial && (!patch.length || !Buffer.from(diff).equals(patch))) {
        throw new Error("The Worker must produce a nonempty UTF-8 Git Diff.");
      }
      return { received: answer, diff, diffSha256: result.capture.artifact.sha256 };
    }, runId);
  } finally {
    await worker.close();
  }
}
