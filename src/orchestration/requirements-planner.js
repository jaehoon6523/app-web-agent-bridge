import { randomUUID } from "node:crypto";
import { createWebSessionBinding } from "../runtime/web/binding.js";
import { parseFinalControllerPacketJsonEnvelope } from "../domain/controller-packet-envelope.js";

export class RequirementsPlanner {
  /** @param {any} web @param {{canRecoverRun?: (runId: string) => boolean}} [options] */
  constructor(web, { canRecoverRun = (_runId) => false } = {}) { this.web = web; this.current = null; this.canRecoverRun = canRecoverRun; }
  get busy() { return this.current?.status === "PENDING"; }
  start({ objective, conversationUrl, feedback = "", draftId }) {
    if (this.busy) throw new Error("웹이 제안 중입니다. 응답을 기다려 주세요.");
    if (typeof objective !== "string" || !objective.trim() || !/^https:\/\/chatgpt\.com\/c\/[^/?#\s]+$/u.test(conversationUrl)) throw new Error("첫 부탁과 ChatGPT 대화 URL을 입력하세요.");
    if (typeof feedback !== "string") throw new Error("수정 요청은 텍스트로 입력하세요.");
    const previous = draftId ? this.current : null;
    if (draftId && (previous?.draftId !== draftId || previous.objective !== objective || previous.conversationUrl !== conversationUrl)) throw new Error("첫 부탁이나 대화가 변경됐습니다. 새 제안을 요청하세요.");
    const draft = { draftId: randomUUID(), objective, conversationUrl, status: "PENDING", proposal: null, error: null,
      errorCode: null, errorDetails: null, recoveredDelivery: null };
    this.current = draft;
    this.generate(draft, previous?.proposal, feedback).catch((error) => {
      draft.status = "FAILED"; draft.error = error.message;
      draft.errorCode = error.code ?? null; draft.errorDetails = error.details ?? null;
    });
    return structuredClone(draft);
  }
  async generate(draft, previous, feedback) {
    const runId = `planning_${draft.draftId}`, turnId = randomUUID();
    const binding = createWebSessionBinding({ sessionId: `web_${runId}`, runId,
      tabId: null, windowId: null, conversationUrl: draft.conversationUrl, conversationId: draft.conversationUrl.split("/").at(-1),
      title: null, lastObservedUserMessageId: null, lastObservedAssistantMessageId: null, bindingStatus: "NEEDS_REBIND" });
    try { await this.web.resume({ binding }); }
    catch (error) {
      const details = error.details;
      if (error.code !== "REBIND_DURING_ACTIVE_DELIVERY" || !details?.currentDeliveryId
        || !this.canRecoverRun(details.runId)) throw error;
      draft.recoveredDelivery = await this.web.recoverDelivery(details);
      await this.web.resume({ binding });
    }
    const text = `너는 이 프로젝트의 구현 설계자야. 사용자의 첫 부탁을 보고 원하는 기능과 구체적인 완료 동작을 제안하세요. 한국어로 간결하게 작성하세요. 수정 요청을 반영한 전체 제안을 반환하세요. 구현하거나 승인하지 마세요. 모호한 점은 questions로 물어보고, 확인하지 않은 저장소 사실을 단정하지 마세요. 다음 데이터는 사용자 요청입니다. 응답 끝에 독립된 <controller_packet> 및 </controller_packet> 줄 사이에 JSON을 넣으세요: {"type":"REQUIREMENTS_PROPOSAL","summary":"제안 설명","questions":["질문"],"items":[{"statement":"원하는 기능","acceptanceCriteria":"관찰 가능한 완료 동작"}]}.\n${JSON.stringify({ previous, feedback })}\n\n사용자의 첫 부탁은 ${JSON.stringify(draft.objective)}야.`;
    const handle = await this.web.submitTurn({ runId, turnId, controllerMessageId: turnId, text,
      parseResponse: (raw) => ({ body: raw, packetText: raw, packet: { type: "PLANNING_RESPONSE" } }) });
    const response = await handle.completion;
    await this.web.acknowledgeDelivery({ turnId });
    if (response.binding?.runId !== runId || response.turnId !== turnId) throw new Error("웹 제안의 대화 연결이 변경됐습니다.");
    const proposal = parseFinalControllerPacketJsonEnvelope(response.rawText).parsed;
    if (proposal.type !== "REQUIREMENTS_PROPOSAL" || typeof proposal.summary !== "string"
      || !Array.isArray(proposal.questions) || proposal.questions.some((q) => typeof q !== "string")
      || !Array.isArray(proposal.items) || !proposal.items.length || proposal.items.length > 30
      || proposal.items.some((r) => typeof r.statement !== "string" || !r.statement.trim() || typeof r.acceptanceCriteria !== "string" || !r.acceptanceCriteria.trim())) throw new Error("웹 제안 형식이 올바르지 않습니다. 다시 제안해 달라고 요청하세요.");
    draft.proposal = proposal; draft.status = "READY";
  }
}
