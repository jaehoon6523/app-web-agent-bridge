const $ = id => document.getElementById(id);
const query = new URLSearchParams(location.search);
const owner = Object.fromEntries(['currentDeliveryId', 'sessionId', 'runId', 'conversationUrl'].map(key => [key, query.get(key)]));
$('owner').textContent = JSON.stringify(owner, null, 2);
$('target').textContent = '대상 전송: ' + (owner.currentDeliveryId || '확인 불가');
try {
  const url = new URL(owner.conversationUrl);
  if (url.protocol === 'https:' && ['chatgpt.com', 'claude.ai'].includes(url.hostname)) {
    $('conversation').href = url.href; $('conversation').hidden = false;
  }
} catch {}
let token = '', observation = null, busy = false;
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000), cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || '전송 상태를 확인하지 못했습니다.');
    error.httpStatus = response.status || 409;
    throw error;
  }
  return result;
}
async function readObservation() {
  if (!token) token = (await request('/api/dashboard/session', { method: 'POST', body: '{}' })).token;
  return request('/api/delivery-review?' + new URLSearchParams(owner));
}
const terminalRecord = record => record?.active === false && ['DISCARDED', 'RECOVERY_DISCARDED'].includes(record.state)
  && record.responseStored === false && !['ACK_PENDING', 'ACKNOWLEDGED'].includes(record.processingState);
const responseEvidence = record => record?.responseStored === true
  || ['ACK_PENDING', 'ACKNOWLEDGED'].includes(record?.processingState)
  || ['ACK_PENDING', 'ACKNOWLEDGED'].includes(record?.state);
const pageUnconfirmed = (seen, terminal) => !seen?.pageReachable || (terminal && !seen.pageIdentityConfirmed)
  || seen.pageBusy !== false || seen.generating !== false;
function clearObservation() {
  observation = null;
  $('recordStatus').textContent = '브리지 기록: 확인 불가';
  $('serverState').textContent = '서버 기록: 확인 불가';
  $('extensionState').textContent = '확장 기록: 확인 불가';
  $('chatgptState').textContent = 'ChatGPT 처리 결과: 미확정';
  $('actionState').textContent = '조치 상태: 최종 확인 필요';
  $('details').textContent = '';
}
function renderObservation(value) {
  observation = value;
  const { server, extension: seen } = value;
  const record = server?.records?.[0], terminal = terminalRecord(record);
  const aligned = server?.status === 'MATCHED' && ((record?.active && seen?.exact)
    || (!record?.active && terminal && seen?.discardConfirmed)
    || (!record?.active && record?.state === 'ACKNOWLEDGED' && seen?.ackConfirmed));
  const status = !server || !seen || server.status === 'UNAVAILABLE' ? '확인 불가'
    : aligned ? '일치' : '기록 불일치';
  $('recordStatus').textContent = '브리지 기록: ' + status;
  $('serverState').textContent = '서버 기록: ' + (server?.status === 'MATCHED'
    ? record?.active ? '해당 전송이 활성 상태입니다.' : terminal ? '해당 전송은 이미 폐기되었습니다.' : '해당 전송이 종료되어 있습니다.'
    : server?.status === 'MISSING' ? '대응 전송 기록이 없습니다.'
      : server?.status === 'MISMATCH' ? '전송 식별자가 다른 기록이 있습니다.' : '확인 불가');
  $('extensionState').textContent = '확장 기록: ' + (seen?.exact ? '해당 전송의 소유권이 남아 있습니다.'
    : seen?.discardConfirmed ? '해당 전송의 소유권 정리 영수증이 확인됐습니다.'
      : seen?.ackConfirmed ? 'ACK 영수증이 확인됐습니다.' : seen?.recordMissing ? '대응 전송 기록이 없습니다.' : '소유권 확인 불가');
  $('chatgptState').textContent = 'ChatGPT 처리 결과: ' + (record?.responseStored
    ? '응답 저장 근거가 있습니다. 실제 페이지 상태는 별도 확인이 필요합니다.'
    : responseEvidence(record) ? '서버의 ACK 상태와 응답 저장 근거가 일치하지 않습니다. 기록을 보존하고 다시 확인하세요.'
      : seen?.hasCompletedDelivery === true || seen?.phase === 'RESPONSE_OBSERVED'
        ? '확장에 완료 응답이 남아 있습니다. 다른 전송의 응답일 수도 있으므로 기록을 보존하고 귀속을 확인하세요.'
        : seen?.hasCompletedDelivery !== false ? '확장의 완료 응답 보유 여부를 확인할 수 없습니다. 기록을 보존하세요.'
          : '응답 저장 근거 없음 · 실제 전송·응답 여부 미확정. 원래 페이지의 상태는 별도 확인이 필요합니다.');
  $('details').textContent = JSON.stringify(value, null, 2);
  $('discardTitle').textContent = terminal ? '확장에 남은 이 전송의 소유권 기록 정리' : '이 전송의 브리지 소유권 기록 정리';
  $('ownershipText').textContent = terminal
    ? '서버에서 이미 폐기된 이 전송의 확장 잔존 소유권만 정리하며, ChatGPT 결과 미확정 및 자동 재전송하지 않음을 확인했습니다.'
    : seen?.recordMissing
      ? '확장에 대응 기록이 없어 이 전송의 서버 기록만 정리하며, ChatGPT 결과 미확정 및 자동 재전송하지 않음을 확인했습니다.'
      : '대상 전송의 브리지 소유권 기록만 정리하며, ChatGPT 결과 미확정 및 자동 재전송하지 않음을 확인했습니다.';
  capabilities();
}
function capabilities() {
  const seen = observation?.extension;
  const record = observation?.server?.records?.[0];
  const terminal = terminalRecord(record);
  const canDiscard = observation?.server?.status === 'MATCHED' && !responseEvidence(record)
    && seen?.phase !== 'RESPONSE_OBSERVED' && seen?.hasCompletedDelivery === false
    && !observation.server.otherActive && !seen.otherActive
    && (seen?.exact || seen?.discardConfirmed || seen?.recordMissing) && (record?.active || terminal)
    && ['PREPARATION', 'REVIEW'].includes(record.kind) && !seen.extensionBusy && !seen.pageBusy && !seen.generating
    && (!terminal || (seen.terminalDiscardProtocol === 1 && !seen.ackConfirmed && (seen.exact || seen.discardConfirmed)));
  $('discardPanel').hidden = !canDiscard;
  const unknown = pageUnconfirmed(seen, terminal);
  $('pageUnknownLabel').hidden = !canDiscard || !unknown;
  $('ack').hidden = !(record?.kind === 'REVIEW' && record?.active && seen?.phase === 'ACK_PENDING' && (seen.exact || seen.ackConfirmed));
  $('ack').disabled = busy || seen?.extensionBusy || seen?.pageBusy || seen?.generating;
  $('preparationRecovery').hidden = !(record?.kind === 'PREPARATION' && record?.active);
  const action = !observation ? '확인 불가'
    : seen?.generating || seen?.pageBusy || seen?.extensionBusy || observation.server?.otherActive || seen?.otherActive ? '다른 작업 또는 생성 중 · 정리 불가'
        : (responseEvidence(record) || seen?.hasCompletedDelivery || seen?.phase === 'RESPONSE_OBSERVED') && record?.active
          ? '응답 상태 확인 또는 ACK 필요 · 기록 정리 불가'
          : seen?.discardConfirmed && terminal ? '브리지 소유권 기록 정리 완료'
            : seen?.ackConfirmed && record?.state === 'ACKNOWLEDGED' ? 'ACK 확인 완료'
            : canDiscard ? '정리 가능 · 명시적 확인 필요'
              : observation.server?.status === 'MISSING' ? '서버 기록 없음 · 확장 팝업에서 확인'
                : '정리 불가 · 상태 또는 대상 확인 필요';
  $('actionState').textContent = '조치 상태: ' + action;
  $('discard').disabled = busy || !canDiscard || !$('ownership').checked || $('reason').value.trim().length < 3
    || (unknown && !$('pageUnknown').checked);
}
async function inspect() {
  if (busy) return;
  busy = true; $('inspect').disabled = true;
  $('ownership').checked = false; $('pageUnknown').checked = false; capabilities();
  try {
    renderObservation(await readObservation());
    $('status').textContent = '상태 확인 완료. 브리지 기록과 ChatGPT 처리 결과는 별개입니다.';
  } catch (error) {
    clearObservation();
    $('status').textContent = error.message + '\n기록은 변경하지 않았습니다.';
  } finally { busy = false; $('inspect').disabled = false; capabilities(); }
}
$('inspect').addEventListener('click', () => void inspect());
for (const id of ['ownership', 'pageUnknown', 'reason']) $(id).addEventListener('input', capabilities);
$('ack').addEventListener('click', async () => {
  if ($('ack').disabled) return;
  busy = true; capabilities();
  let accepted = false;
  try {
    await request('/api/delivery-review/ack', { method: 'POST', body: JSON.stringify(owner) });
    accepted = true;
    const latest = await readObservation();
    renderObservation(latest);
    const record = latest.server?.records?.[0];
    $('status').textContent = latest.server?.status === 'MATCHED' && record?.active === false
      && record.state === 'ACKNOWLEDGED' && latest.extension?.ackConfirmed
      ? '저장된 응답 ACK 확인 완료. 실행은 HOLD 상태입니다. ChatGPT 페이지 상태는 별도로 확인하세요.'
      : 'ACK 요청은 접수됐지만 최종 영수증을 확인하지 못했습니다. 상태를 다시 확인하세요.';
  } catch (error) {
    clearObservation();
    $('status').textContent = (accepted ? 'ACK 요청 후 최종 재확인 실패: '
      : error.httpStatus ? 'ACK 실행 거절: ' : 'ACK 요청 결과 확인 불가: ') + error.message;
  } finally { busy = false; capabilities(); }
});
$('discard').addEventListener('click', async () => {
  if ($('discard').disabled) return;
  busy = true; capabilities();
  let accepted = false;
  try {
    const seen = observation.extension, record = observation.server.records[0];
    const confirmation = $('ownership').checked;
    const result = await request('/api/delivery-review/discard', { method: 'POST', body: JSON.stringify({ ...owner,
      unresolvedResultConfirmed: confirmation, noAutomaticResendConfirmed: confirmation,
      terminalDiscardConfirmed: terminalRecord(record) && confirmation,
      extensionRecordMissingConfirmed: seen.recordMissing && confirmation,
      pageStateUnconfirmedConfirmed: $('pageUnknown').checked, reason: $('reason').value.trim() }) });
    accepted = true;
    const latest = await readObservation();
    renderObservation(latest);
    const finalRecord = latest.server?.records?.[0];
    $('status').textContent = result.discarded === true && latest.server?.status === 'MATCHED'
      && terminalRecord(finalRecord) && latest.extension?.discardConfirmed
      ? '브리지 소유권 기록 정리 완료. ChatGPT 처리 결과는 미확정이며 원래 요청을 재전송하지 않았습니다.'
      : '정리 요청에 응답이 있었으나 최종 폐기 영수증을 확인하지 못했습니다. 상태를 다시 확인하세요.';
  } catch (error) {
    clearObservation();
    $('status').textContent = (accepted ? '정리 요청 후 최종 재확인 실패: '
      : error.httpStatus ? '기록 정리 실행 거절: ' : '기록 정리 요청 결과 확인 불가: ')
      + error.message + '\nChatGPT 결과는 미확정입니다. 자동 재전송하지 않습니다. 상태를 다시 확인하세요.';
  } finally { busy = false; capabilities(); }
});
void inspect();
