export const PLAIN_TEXT_DISCUSSION = "PLAIN_TEXT_DISCUSSION";
const advisoryHeadings = ["동의", "일부 반박할게 있습니다.", "질문이 있습니다.", "합의합니다.", "자료를 요청합니다."];
export const ADVISORY_FORMAT_INSTRUCTIONS = [
  "[2] 응답 형식",
  "정보나 방법을 묻는 질문에는 첫 줄부터 바로 답하세요. 예를 들어 ‘뭐부터 봐야 돼?’에는 먼저 볼 항목을 바로 말하세요. 의견에 대한 동의·반박, 합의, 확인 질문, 자료 요청을 실제로 할 때만 첫 줄에 다음 다섯 문구 중 하나를 그대로 쓰세요. 번호, 인용부호, 마크다운은 붙이지 마세요.",
  "동의 — 제안에 동의할 때",
  "일부 반박할게 있습니다. — 반대하거나 보완할 부분이 있을 때",
  "질문이 있습니다. — 상대에게 판단이나 의도를 확인할 때",
  "합의합니다. — 함께 정한 결정을 확정할 때",
  "자료를 요청합니다. — 판단에 필요한 근거가 부족할 때",
  "분류 문구를 쓴 경우에는 둘째 줄부터 이유, 질문 또는 필요한 자료를 평문으로 쓰세요. 이 응답 형식 지시문만 받으면 직전 질문에 대한 답변을 다시 작성하세요.",
].join("\n\n");

export function hasAdvisoryHeading(text) {
  return advisoryHeadings.includes(text.split(/\r?\n/u, 1)[0]);
}

export function requestsAdvisoryJudgment(text) {
  return /동의하|반박해|평가해|판단해|합의하|맞다고\s*봐|\bdo you agree\b/iu.test(text);
}

export function advisoryOpening(objective) {
  return [
    "[1] 역할과 첫 목표",
    "당신은 이 프로젝트의 독립 기술 자문입니다. 사용자와 다른 에이전트의 주장도 근거에 따라 검토하세요. 확인된 사실, 추론, 미확인을 구분하고, 접근 자체가 비효율적이면 이유와 대안을 제시하세요. 비판적 검토를 해주세요.",
    "첫 목표: " + objective,
    ADVISORY_FORMAT_INSTRUCTIONS,
  ].join("\n\n");
}
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
