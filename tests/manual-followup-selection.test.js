import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../extension/runtime/manual-followup.js", import.meta.url), "utf8");
const context = vm.createContext({});
vm.runInContext(source, context);
const select = context.ChatGptBridgeManualFollowup.selectExplicitManualFollowup;

const base = [
  { id: "u-controlled", role: "user", index: 0 },
  { id: "a-controlled", role: "assistant", index: 1 },
];

test("explicit manual follow-up adopts exactly one complete trailing user/assistant pair", () => {
  const result = select([...base,
    { id: "u-manual", role: "user", index: 2 },
    { id: "a-manual", role: "assistant", index: 3 },
  ], "a-controlled");
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    status: "MATCHED", userMessageId: "u-manual", assistantMessageId: "a-manual",
  });
});

test("no manual follow-up preserves original response recheck behavior", () => {
  assert.equal(select(base, "a-controlled").status, "NONE");
});

test("a manual user message without a completed assistant stays waiting", () => {
  const result = select([...base, { id: "u-manual", role: "user", index: 2 }], "a-controlled");
  assert.equal(result.status, "WAITING");
  assert.equal(result.userMessageId, "u-manual");
});

test("multiple manual turns are ambiguous and never auto-adopted", () => {
  const result = select([...base,
    { id: "u-manual-1", role: "user", index: 2 },
    { id: "a-manual-1", role: "assistant", index: 3 },
    { id: "u-manual-2", role: "user", index: 4 },
    { id: "a-manual-2", role: "assistant", index: 5 },
  ], "a-controlled");
  assert.equal(result.status, "AMBIGUOUS");
});

test("missing original assistant identity is never guessed", () => {
  assert.equal(select([...base,
    { id: "u-manual", role: "user", index: 2 },
    { id: "a-manual", role: "assistant", index: 3 },
  ], "missing").status, "UNAVAILABLE");
});
