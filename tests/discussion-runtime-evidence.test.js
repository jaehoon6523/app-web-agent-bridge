import assert from "node:assert/strict";
import test from "node:test";
import { AgentPacketParserStage } from "../src/domain/agent-packet-rejection.js";
import { canonicalJson } from "../src/domain/canonical-json.js";
import { AgentActor, AgentPacketType } from "../src/domain/vocabulary.js";
import {
  DISCUSSION_RUNTIME_EVIDENCE_SCHEMA,
  buildDiscussionRuntimeEvidence,
  parseDiscussionRuntimeEvidence,
} from "../src/orchestration/discussion-runtime-evidence.js";

test("Codex runtime evidence retains only an allowlisted closed packet type", () => {
  const text = buildDiscussionRuntimeEvidence({
    actor: AgentActor.CODEX_AGENT,
    parserStage: AgentPacketParserStage.SCHEMA_VALIDATION,
    rawText: JSON.stringify({
      type: AgentPacketType.PROPOSAL,
      password: "private-password",
      body: "private repository content",
    }),
  });
  assert.deepEqual(JSON.parse(text), {
    actor: AgentActor.CODEX_AGENT,
    observedCandidatePacketType: AgentPacketType.PROPOSAL,
    parserStage: AgentPacketParserStage.SCHEMA_VALIDATION,
    schema: DISCUSSION_RUNTIME_EVIDENCE_SCHEMA,
  });
  assert.doesNotMatch(text, /private-password|private repository content|password|body/u);
});

test("Web candidate type requires an exact standalone final controller packet", () => {
  const exact = buildDiscussionRuntimeEvidence({
    actor: AgentActor.CHATGPT_WEB_AGENT,
    parserStage: AgentPacketParserStage.SCHEMA_VALIDATION,
    rawText: [
      "review body with private text",
      "<controller_packet>",
      JSON.stringify({ type: AgentPacketType.CRITIQUE, cookie: "private-cookie" }),
      "</controller_packet>",
    ].join("\n"),
  });
  assert.equal(JSON.parse(exact).observedCandidatePacketType, AgentPacketType.CRITIQUE);
  assert.doesNotMatch(exact, /private text|private-cookie|cookie/u);

  for (const rawText of [
    `> <controller_packet>\n${JSON.stringify({ type: AgentPacketType.CRITIQUE })}\n> </controller_packet>`,
    `\`\`\`\n<controller_packet>\n${JSON.stringify({
      type: AgentPacketType.CRITIQUE,
    })}\n</controller_packet>\n\`\`\``,
    `<controller_packet>\n{"type":\n</controller_packet>`,
  ]) {
    const ambiguous = buildDiscussionRuntimeEvidence({
      actor: AgentActor.CHATGPT_WEB_AGENT,
      parserStage: AgentPacketParserStage.SCHEMA_VALIDATION,
      rawText,
    });
    assert.equal(JSON.parse(ambiguous).observedCandidatePacketType, null);
  }
});

test("untyped parser stages cannot manufacture a repair packet type", () => {
  const text = buildDiscussionRuntimeEvidence({
    actor: AgentActor.CODEX_AGENT,
    parserStage: AgentPacketParserStage.JSON_PARSE,
    rawText: JSON.stringify({ type: AgentPacketType.PROPOSAL }),
  });
  assert.equal(JSON.parse(text).observedCandidatePacketType, null);

  const forged = canonicalJson({
    actor: AgentActor.CODEX_AGENT,
    observedCandidatePacketType: AgentPacketType.PROPOSAL,
    parserStage: AgentPacketParserStage.JSON_PARSE,
    schema: DISCUSSION_RUNTIME_EVIDENCE_SCHEMA,
  });
  assert.throws(
    () => parseDiscussionRuntimeEvidence(forged, {
      actor: AgentActor.CODEX_AGENT,
      parserStage: AgentPacketParserStage.JSON_PARSE,
    }),
    (error) => error.code === "INVALID_DISCUSSION_RUNTIME_EVIDENCE",
  );
});

test("runtime evidence is canonical and bound to exact actor and parser stage", () => {
  const text = buildDiscussionRuntimeEvidence({
    actor: AgentActor.CODEX_AGENT,
    parserStage: AgentPacketParserStage.DOMAIN_VALIDATION,
    rawText: JSON.stringify({ type: AgentPacketType.BLOCKED }),
  });
  assert.equal(parseDiscussionRuntimeEvidence(text, {
    actor: AgentActor.CODEX_AGENT,
    parserStage: AgentPacketParserStage.DOMAIN_VALIDATION,
  }).observedCandidatePacketType, AgentPacketType.BLOCKED);
  assert.throws(
    () => parseDiscussionRuntimeEvidence(text, {
      actor: AgentActor.CHATGPT_WEB_AGENT,
      parserStage: AgentPacketParserStage.DOMAIN_VALIDATION,
    }),
    (error) => error.code === "RUNTIME_EVIDENCE_CONTEXT_MISMATCH",
  );
  assert.throws(
    () => parseDiscussionRuntimeEvidence(`${text}\n`, {
      actor: AgentActor.CODEX_AGENT,
      parserStage: AgentPacketParserStage.DOMAIN_VALIDATION,
    }),
    (error) => error.code === "INVALID_DISCUSSION_RUNTIME_EVIDENCE",
  );
});
