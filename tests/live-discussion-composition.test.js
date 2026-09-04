import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/evidence/artifact-store.js";
import { AgentActor, AgentPacketType, RunPhase } from "../src/domain/vocabulary.js";
import { createDiscussionRunPolicy } from "../src/domain/run-policy.js";
import {
  createInitialWebSessionBinding,
  LiveDiscussionComposition,
} from "../src/orchestration/live-discussion-composition.js";
import { SqliteStore } from "../src/persistence/sqlite-store.js";
import {
  createFakeDiscussionSessions,
  ScriptedDiscussionRuntime,
} from "./support/fake-discussion-sessions.js";

function proposal(body) {
  return {
    type: AgentPacketType.PROPOSAL,
    summary: "Durable live composition fixture",
    body,
    assumptions: [],
    open_decisions: [],
  };
}

test("composition provisions durable runtime identities before queueing the first delivery", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "live-discussion-composition-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SqliteStore(join(directory, "controller.sqlite"));
  const artifacts = new ArtifactStore(join(directory, "artifacts"));
  const runtime = new ScriptedDiscussionRuntime([
    { actor: AgentActor.CODEX_AGENT, packet: proposal("Proposal X") },
  ]);
  const sessions = createFakeDiscussionSessions(runtime);
  let nextId = 0;
  const composition = new LiveDiscussionComposition({
    store,
    artifactStore: artifacts,
    idFactory: () => String(++nextId).padStart(4, "0"),
    createCodexSession: ({ persistThreadBinding }) => {
      persistThreadBinding({ actor: AgentActor.CODEX_AGENT, threadId: sessions.CODEX_AGENT.externalSessionId });
      return sessions.CODEX_AGENT;
    },
    createWebSession: () => sessions.CHATGPT_WEB_AGENT,
  });

  const firstBinding = createInitialWebSessionBinding({
    runId: "run-live-composition",
    sessionId: "planned-web-session",
    conversationUrl: "https://chatgpt.com/c/conversation-web?ignored=value",
  });
  assert.equal(firstBinding.bindingStatus, "NEEDS_REBIND");
  assert.equal(firstBinding.conversationUrl, "https://chatgpt.com/c/conversation-web");
  const provisioned = await composition.provisionRun({
    runId: "run-live-composition",
    objective: "Reach one identical accepted proposal.",
    policy: createDiscussionRunPolicy({ maxTurns: 8 }),
    webConversationUrl: firstBinding.conversationUrl,
  });
  assert.equal(provisioned.run.phase, RunPhase.CODEX_TURN_PENDING);
  assert.equal(store.getAgentSession(provisioned.codexSessionId).externalSessionId, "thread-codex");
  assert.equal(store.getAgentSession(provisioned.webSessionId).externalSessionId, "conversation-web");

  assert.equal(composition.getDispatcher("run-live-composition"), provisioned.dispatcher);
  assert.equal(store.listDispatchableDeliveries({ runId: "run-live-composition" }).length, 1);
  composition.close();
  store.close();
});
