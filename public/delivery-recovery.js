const $ = id => document.getElementById(id);
const query = new URLSearchParams(location.search);
const owner = Object.fromEntries(['currentDeliveryId', 'sessionId', 'runId', 'conversationUrl'].map(key => [key, query.get(key)]));
$('owner').textContent = JSON.stringify(owner, null, 2);
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
  if (!response.ok) throw new Error(result.error || '전송 상태를 확인하지 못했습니다.');
  return result;
}
function capabilities() {
  const seen = observation?.extension;
  const record = observation?.server.records[0];
  const terminal = record?.active === false && ['DISCARDED', 'RECOVERY_DISCARDED'].includes(record.state)
    && record.responseStored === false && !['ACK_PENDING', 'ACKNOWLEDGED'].includes(record.processingState);
  $('terminalLabel').hidden = !terminal;
  const canDiscard = observation?.server.status === 'MATCHED' && (seen?.exact || seen?.discardConfirmed || seen?.recordMissing) && (record?.active || terminal)
    && ['PREPARATION', 'REVIEW'].includes(record.kind) && !seen.extensionBusy && !seen.pageBusy && !seen.generating
    && (!terminal || (seen.terminalDiscardProtocol === 1 && !observation.server.otherActive && !seen.otherActive && !seen.ackConfirmed && (seen.exact || seen.discardConfirmed)));
  $('discardPanel').hidden = !canDiscard;
  $('extensionMissingLabel').hidden = !seen?.recordMissing;
  $('ack').hidden = !(record?.kind === 'REVIEW' && record?.active && seen?.phase === 'ACK_PENDING' && (seen.exact || seen.ackConfirmed));
  $('ack').disabled = busy || seen?.extensionBusy || seen?.pageBusy || seen?.generating;
  $('preparationRecovery').hidden = !(record?.kind === 'PREPARATION' && record?.active);
  $('discard').disabled = busy || !canDiscard || !$('unresolved').checked || !$('noResend').checked
    || $('reason').value.trim().length < 3 || (terminal && !$('terminal').checked)
    || (seen?.recordMissing && !$('extensionMissing').checked)
    || ((!seen.pageReachable || (terminal && !seen.pageIdentityConfirmed) || seen.pageBusy !== false || seen.generating !== false) && !$('pageUnknown').checked);
}
async function inspect() {
  if (busy) return;
  busy = true; $('inspect').disabled = true; capabilities();
  try {
    if (!token) token = (await request('/api/dashboard/session', { method: 'POST', body: '{}' })).token;
    observation = await request('/api/delivery-review?' + new URLSearchParams(owner));
    const { server, extension } = observation;
    const phases = { ACK_PENDING: '응답 영속화됨 · ACK 확인 대기', RESPONSE_OBSERVED: '응답 관측됨 · 서버 검증·저장 확인 필요', UNRESOLVED: '전송 결과 미확정', ACKNOWLEDGED: 'ACK 확인 완료', DISCARDED: '사용자의 명시적 폐기 확인 완료' };
    const labels = { MATCHED: '대상 전송 기록 일치', MISSING: '서버에 대응 기록 없음 · 확장 팝업에서 명시적 폐기 가능', MISMATCH: '서버 기록 불일치 · 기록 보존' };
    $('status').textContent = `${labels[server.status] || '기록 확인 불가'}\n${phases[extension.phase]}${extension.terminalDiscardProtocol !== 1 ? '\n복구 기능 사용 전 확장을 업데이트·Reload하세요.' : ''}\n전송 결과: ${extension.resultStatus === 'RESPONSE_STORED' ? '응답 저장 근거 있음' : '미확정'}\n원래 페이지: ${extension.pageReachable && extension.pageIdentityConfirmed ? '원래 문서 접근됨' : '접근 불가 또는 문서 불일치 · 실제 전송·응답·생성 종료 확인 불가'}\n확장 전송 소유권: ${extension.exact ? '일치' : '불일치 또는 해소됨'}`;
    $('details').textContent = JSON.stringify(observation, null, 2);
  } catch (error) { observation = null; $('status').textContent = error.message + '\n기록을 보존했습니다.'; }
  finally { busy = false; $('inspect').disabled = false; capabilities(); }
}
$('inspect').addEventListener('click', () => void inspect());
for (const id of ['unresolved', 'noResend', 'pageUnknown', 'reason', 'extensionMissing', 'terminal']) $(id).addEventListener('input', capabilities);
$('ack').addEventListener('click', async () => {
  if ($('ack').disabled) return;
  busy = true; capabilities();
  try {
    await request('/api/delivery-review/ack', { method: 'POST', body: JSON.stringify(owner) });
    observation = null; $('status').textContent = '저장된 응답의 ACK를 확인했습니다. 원래 요청을 다시 전송하지 않았습니다. 실행은 HOLD 상태로 유지됩니다.';
  } catch (error) { $('status').textContent = error.message + '\n상태를 다시 확인하세요.'; }
  finally { busy = false; capabilities(); }
});
$('discard').addEventListener('click', async () => {
  if ($('discard').disabled) return;
  busy = true; capabilities();
  try {
    const result = await request('/api/delivery-review/discard', { method: 'POST', body: JSON.stringify({ ...owner,
      unresolvedResultConfirmed: $('unresolved').checked, noAutomaticResendConfirmed: $('noResend').checked,
      terminalDiscardConfirmed: $('terminal').checked,
      extensionRecordMissingConfirmed: $('extensionMissing').checked,
      pageStateUnconfirmedConfirmed: $('pageUnknown').checked, reason: $('reason').value.trim() }) });
    observation = null; $('status').textContent = result.disposalStatus === 'BOTH_DISCARDED' ? '양쪽 폐기 처리 완료 · 실제 전송 결과 미확정. 원래 요청을 다시 전송하지 않았습니다.' : '대상 전송을 폐기했습니다. 원래 요청을 다시 전송하지 않았습니다.';
  } catch (error) { $('status').textContent = error.message + '\n상태를 다시 확인하세요.'; }
  finally { busy = false; capabilities(); }
});
void inspect();
