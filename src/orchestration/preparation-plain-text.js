export const PLAIN_TEXT_DISCUSSION = "PLAIN_TEXT_DISCUSSION";
const packetMarker = /<\/?controller_packet\b|CONTROLLER_PACKET_BEGIN|CONTROLLER_PACKET_END/i;

export function hasControllerPacketMarker(rawText) {
  return typeof rawText === "string" && (packetMarker.test(rawText) || /^[\t >]*(?:답변시작|답변끝)[\t \\]*\r?$/mu.test(rawText));
}

export function isPlainTextDiscussionCandidate({ context, response, packetParseError, validationStatus }) {
  return context.acceptPlainTextDiscussion === true
    && context.lifecycle === "ACTIVE"
    && context.agreement.status !== "APPROVED"
    && validationStatus === "CONFIRMED"
    && packetParseError?.code === "CONTROLLER_PACKET_MISSING"
    && response?.confidence === "CONFIRMED_BY_UI_STATE"
    && response.evidence?.responseAssociation === "DIRECT_DOM_ORDER"
    && typeof response.rawText === "string" && response.rawText.trim().length > 0
    && !hasControllerPacketMarker(response.rawText);
}

export function preservesPlainTextDiscussion(context, delivery) {
  return context.acceptPlainTextDiscussion === true
    && delivery.validation?.status === "CONFIRMED"
    && delivery.validation.format === PLAIN_TEXT_DISCUSSION
    && (delivery.state === "ACKNOWLEDGED"
      ? delivery.processingState === "COMPLETE" : delivery.processingState === "ACK_PENDING");
}

export function plainTextDiscussionAgreement(agreement) {
  return { ...agreement, status: "DISCUSSING", summary: "웹 설계자의 평문 응답을 확인하고 대화를 이어가세요." };
}
