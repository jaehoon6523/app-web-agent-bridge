export function renderInvalidAbandonment($, active, pending) {
  $("discardHeading").textContent = active ? "무효 응답을 보존하고 준비 포기" : "확인되지 않은 요청 정리";
  $("discardExplanation").textContent = pending ? "저장된 종결 요청을 같은 ID로 계속합니다." : active
    ? "응답 원문과 검증 실패를 보존합니다. 이 준비는 포기되며 정상 수신 확인이나 재전송은 하지 않습니다."
    : "응답 결과를 확인할 수 없을 때만 사용합니다. 같은 요청은 자동 재전송하지 않습니다.";
  $("discardConsent").textContent = active ? "이 무효 응답을 채택하지 않고 해당 준비를 포기합니다."
    : "원래 ChatGPT 응답 결과를 확인하지 못했습니다.";
  $("discardPageRisk").hidden = !active || Boolean(pending);
  $("discardDeliveryButton").textContent = pending ? "같은 종결 요청 계속" : $("discardHeading").textContent;
}

export function invalidAbandonmentInput($, preparation) {
  const session = preparation.webSession;
  const pending = preparation.deliveries.find(d => d.deliveryId === session.activeDeliveryId)?.invalidAbandonmentIntent;
  return {
    deliveryId:session.activeDeliveryId, sessionId:session.sessionId, runId:preparation.preparationId,
    conversationId:session.conversationId, conversationUrl:session.conversationUrl,
    abandonInvalidResponseConfirmed:pending?.abandonInvalidResponseConfirmed ?? $("discardUnresolved").checked,
    noAutomaticResendConfirmed:pending?.noAutomaticResendConfirmed ?? $("discardNoResend").checked,
    pageStateUnconfirmedConfirmed:pending?.pageStateUnconfirmedConfirmed ?? $("discardPageUnconfirmed").checked,
    reason:pending?.reason ?? $("discardReason").value.trim(),
    ...(pending ? {requestId:pending.requestId, expectedVersion:pending.expectedVersion} : {}),
  };
}
