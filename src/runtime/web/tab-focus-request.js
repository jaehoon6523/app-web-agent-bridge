import { WebProtocolError } from './protocol.js';

export function webMessageError(message) {
  return new WebProtocolError(message.payload?.message || 'ChatGPT Web extension operation failed',
    message.payload?.code || 'WEB_EXTENSION_ERROR', message.payload?.details ?? null);
}

export function traceTabFocus(message, requestId, phase) {
  if (message.type !== 'web.tab.focus') return;
  console.info('[bridge:tab-focus]', JSON.stringify({phase,requestId,tabId:message.payload?.tabId ?? null}));
}

export async function requestCandidateFocus(expected, busy, request) {
  if (busy) throw new WebProtocolError('Web 작업이 진행 중입니다. 상태를 다시 확인하세요.', 'WEB_SESSION_BUSY');
  const message = await request({type:'web.tab.focus',payload:{...expected,expiresAt:Date.now()+10_000}}, new Set(['web.tab.focused','web.session.error']), 10_000);
  if (message.type === 'web.session.error') throw webMessageError(message);
  if (message.payload?.opened !== true || message.payload?.tabId !== expected.tabId) {
    throw new WebProtocolError('탭 이동 응답의 대상 또는 결과를 확인하지 못했습니다.', 'TAB_FOCUS_UNCONFIRMED');
  }
  return message.payload;
}
