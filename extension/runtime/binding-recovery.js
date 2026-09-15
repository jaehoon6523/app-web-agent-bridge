export const BindingRecoveryCode = Object.freeze({
  ROOT_RECOVERED: "STORED_AMBIGUOUS_ROOT_RECOVERED",
  DELIVERY_REVIEW_REQUIRED: "STORED_AMBIGUOUS_DELIVERY_REVIEW_REQUIRED",
  REBIND_REQUIRED: "STORED_AMBIGUOUS_REBIND_REQUIRED",
});

const MESSAGES = Object.freeze({
  [BindingRecoveryCode.ROOT_RECOVERED]: "동일한 ChatGPT 시작 탭 하나를 확인해 새 대화 준비 상태로 복구했습니다.",
  [BindingRecoveryCode.DELIVERY_REVIEW_REQUIRED]: "미확정 전송이 남아 있어 자동 복구하지 않았습니다. 전송 상태를 확인하거나 폐기하세요.",
  [BindingRecoveryCode.REBIND_REQUIRED]: "저장된 바인딩과 현재 ChatGPT 탭이 정확히 일치하지 않습니다. 대상 탭을 다시 바인딩하세요.",
});

export function bindingRecoveryMessage(code) {
  return MESSAGES[code] ?? null;
}

export function classifyStoredAmbiguousRoot({ state, roots, rootPage, busy }) {
  if (state?.bindingStatus !== "AMBIGUOUS") return null;

  const activeDelivery = typeof state.currentDeliveryId === "string" && state.currentDeliveryId.length > 0;
  if (activeDelivery || busy === true) {
    const code = BindingRecoveryCode.DELIVERY_REVIEW_REQUIRED;
    return Object.freeze({ recovered: false, code, message: bindingRecoveryMessage(code) });
  }

  const root = Array.isArray(roots) && roots.length === 1 ? roots[0] : null;
  const exactRoot = root
    && root.id === state.tabId
    && root.windowId === state.windowId
    && state.conversationUrl === "https://chatgpt.com/"
    && state.conversationId === null
    && rootPage?.ok === true
    && rootPage.ready === true
    && rootPage.busy === false
    && rootPage.generating === false
    && rootPage.url === "https://chatgpt.com/"
    && rootPage.conversationId === null
    && typeof rootPage.documentId === "string"
    && rootPage.documentId.length > 0
    && rootPage.frameId === 0;

  if (exactRoot) {
    const code = BindingRecoveryCode.ROOT_RECOVERED;
    return Object.freeze({
      recovered: true,
      code,
      message: bindingRecoveryMessage(code),
      patch: Object.freeze({
        documentId: rootPage.documentId,
        frameId: rootPage.frameId,
        bindingStatus: "ROOT_READY",
        bindingError: null,
      }),
    });
  }

  const code = BindingRecoveryCode.REBIND_REQUIRED;
  return Object.freeze({ recovered: false, code, message: bindingRecoveryMessage(code) });
}
