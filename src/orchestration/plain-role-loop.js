import { randomUUID } from "node:crypto";
import { createWebSessionBinding } from "../runtime/web/binding.js";
import { ADVISORY_FORMAT_INSTRUCTIONS, hasAdvisoryHeading } from "./preparation-plain-text.js";

export async function runPlainRoleLoop(web, objective, record, workerTurn) {
  const runId = `plain_${randomUUID()}`;
  const conversations = new Map();
  const usedConversations = new Set();

  async function send(role, text) {
    const previous = conversations.get(role);
    const sessionId = previous?.sessionId ?? `web_${runId}_${role}`;
    const turnId = `plain_turn_${randomUUID()}`;
    const target = {
      binding: previous ?? createWebSessionBinding({
        sessionId, runId, bindingStatus: "NEEDS_REBIND", tabId: null, windowId: null,
        conversationId: null, conversationUrl: null, title: null,
        lastObservedUserMessageId: null, lastObservedAssistantMessageId: null,
      }),
      focus: !previous,
      createNewConversation: !previous,
    };
    let binding;
    try {
      binding = await web.resume(target);
    } catch (error) {
      if (previous || error.code !== "CONTENT_SCRIPT_MESSAGE_TIMEOUT" || error.details?.stage !== "LOAD") throw error;
      // The new tab exists, but no prompt has been submitted.
      binding = await web.resume({ ...target, createNewConversation: false });
    }
    if (binding.sessionId !== sessionId || binding.runId !== runId
      || (previous && binding.conversationId !== previous.conversationId)) {
      throw new Error(`${role} conversation changed before sending.`);
    }
    const handle = await web.submitTurn({
      runId, turnId, controllerMessageId: turnId, text, plainText: true,
      parseResponse: raw => ({ body: raw, packetText: raw, packet: {} }),
    });
    const response = await handle.completion;
    const returned = response.binding;
    if (response.turnId !== turnId || returned?.runId !== runId || returned.sessionId !== sessionId
      || !returned.conversationId || (previous && returned.conversationId !== previous.conversationId)
      || (!previous && usedConversations.has(returned.conversationId))
      || response.confidence !== "CONFIRMED_BY_UI_STATE"
      || response.evidence?.responseAssociation !== "DIRECT_DOM_ORDER"
      || typeof response.rawText !== "string" || !response.rawText.trim()) {
      throw new Error(`${role} response could not be attributed to its conversation.`);
    }
    await record({ runId, role, turnId, conversationId: returned.conversationId,
      sent: text, received: response.rawText });
    const ack = await web.acknowledgeDelivery({ turnId });
    if (ack?.currentDeliveryId !== null || ack.runId !== runId || ack.sessionId !== sessionId
      || ack.conversationUrl !== returned.conversationUrl) {
      throw new Error(`${role} delivery acknowledgement was not confirmed.`);
    }
    conversations.set(role, returned);
    usedConversations.add(returned.conversationId);
    return response.rawText;
  }

  async function review(role, opening) {
    const answer = await send(role, `${opening}\n\n${ADVISORY_FORMAT_INSTRUCTIONS}`);
    if (hasAdvisoryHeading(answer)) return answer;
    const corrected = await send(role, ADVISORY_FORMAT_INSTRUCTIONS);
    if (!hasAdvisoryHeading(corrected)) throw new Error(`${role} response format was not corrected.`);
    return corrected;
  }

  const opening = `넌 이 작업의 구현 담당이야.\n${objective} 라는 명령을 받았는데 어떻게 해야할까.`;
  const worker = workerTurn ? await workerTurn({ runId, text: opening, initial: true })
    : { received: await send("WORKER", opening) };
  const implementation = worker.diff === undefined ? worker.received
    : `${worker.received}\n\n실제 Git Diff야.\n--- Git Diff 시작 ---\n${worker.diff}--- Git Diff 끝 ---`;
  const judge = await review("JUDGE", `넌 이 작업의 의견 담당이야.\n${objective} 라는 명령을 받았고, 구현부는 이렇게 답했어.\n\n${implementation}\n\n구현부가 말한 방식으로 해도 괜찮을까? 네 의견이랑 그 이유를 말해줘.`);
  const critic = await review("CRITIC", `넌 이 작업의 비판 담당이야.\n${objective} 라는 명령을 받았고, 구현부는 이렇게 답했어.\n\n${implementation}\n\n그걸 보고 의견부는 이렇게 답했어.\n\n${judge}\n\n둘 다 보고 놓친 점이나 근거가 부족한 부분이 있는지 봐줘. 구현부가 다시 확인하거나 바꿔야 할 게 있으면 이유랑 같이 말해줘.`);
  const followUp = `비판부가 이렇게 답했어.\n\n${critic}\n\n이거 보고 다시 확인하거나 바꿀 게 있으면 해줘. 그대로 가도 된다고 보면 왜 그런지도 말해줘.`;
  if (workerTurn) await workerTurn({ runId, text: followUp, initial: false });
  else await send("WORKER", followUp);
  return runId;
}
