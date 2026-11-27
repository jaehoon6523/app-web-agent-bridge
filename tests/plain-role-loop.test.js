import assert from "node:assert/strict";
import test from "node:test";
import { runPlainRoleLoop } from "../src/orchestration/plain-role-loop.js";
import { ADVISORY_FORMAT_INSTRUCTIONS } from "../src/orchestration/preparation-plain-text.js";

test("plain role loop forwards replies and corrects the Judge once in the same conversation", async () => {
  const responses = ["구현 답변", "형식 오류", "동의\n의견 답변", "자료를 요청합니다.\n비판 답변", "다시 확인했습니다."];
  const turns = [];
  let binding;
  const adapter = {
    async resume({ binding: target, createNewConversation }) {
      const role = target.sessionId.split("_").at(-1);
      assert.equal(createNewConversation, !target.conversationId);
      binding = { ...target, conversationId: role, conversationUrl: `https://chatgpt.com/c/${role}` };
      return binding;
    },
    async submitTurn({ turnId, plainText }) {
      assert.equal(plainText, true);
      return { completion: Promise.resolve({ turnId, binding, rawText: responses.shift(),
        confidence: "CONFIRMED_BY_UI_STATE", evidence: { responseAssociation: "DIRECT_DOM_ORDER" } }) };
    },
    async acknowledgeDelivery() {
      return { ...binding, currentDeliveryId: null };
    },
  };

  const runId = await runPlainRoleLoop(adapter, "사용자 요청", turn => turns.push(turn));
  assert.deepEqual(turns.map(turn => turn.role), ["WORKER", "JUDGE", "JUDGE", "CRITIC", "WORKER"]);
  assert.ok(turns.every(turn => turn.runId === runId));
  assert.match(turns[1].sent, /구현 답변/u);
  assert.equal(turns[2].sent, ADVISORY_FORMAT_INSTRUCTIONS);
  assert.equal(turns[2].conversationId, turns[1].conversationId);
  assert.match(turns[3].sent, /의견 답변/u);
  assert.equal(turns[4].conversationId, turns[0].conversationId);
  assert.equal(turns[4].sent, "비판부가 이렇게 답했어.\n\n자료를 요청합니다.\n비판 답변\n\n이거 보고 다시 확인하거나 바꿀 게 있으면 해줘. 그대로 가도 된다고 보면 왜 그런지도 말해줘.");
});
