const $ = id => document.getElementById(id);
let token, snapshot, busy = false, approvedIdentity = null, auditUnconfirmed = false;
async function session() {
  if (token) return token;
  const response = await fetch('/api/dashboard/session', { method: 'POST' });
  if (!response.ok) throw new Error('로컬 컨트롤러 인증 정보를 확인하지 못했습니다.');
  token = (await response.json()).token;
  return token;
}
async function request(method, body) {
  const response = await fetch('/api/extension-pairing', { method,
    headers: { Authorization: 'Bearer ' + await session(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.code || 'PAIRING_UNAVAILABLE'), { code: result.code });
  return result;
}
async function refresh() {
  if (busy) return;
  try {
    snapshot = await request('GET');
    $('current').textContent = '서버의 현재 연결 대상: ' + snapshot.currentIdentity;
    $('candidate').textContent = '접속한 확장: ' + (snapshot.candidate?.identity ?? '확인된 후보 없음');
    $('state').textContent = snapshot.authenticated
      ? (auditUnconfirmed ? '확장 인증 완료. 연결 승인 감사 기록은 확인되지 않았습니다.' : '확장 연결 인증 완료')
      : approvedIdentity === snapshot.currentIdentity
        ? (auditUnconfirmed ? '연결 대상으로 저장했지만 완료 감사 기록은 확인되지 않았습니다. 자동 재연결을 기다립니다.'
          : '연결 대상으로 저장했습니다. 확장 자동 재연결을 기다리는 중입니다.')
      : snapshot.candidate ? '공유 비밀키를 확인했습니다. 연결할 확장을 확인하세요.'
        : '연결 후보 대기 중입니다. 확장 팝업에서 Reconnect를 누르면 다시 확인합니다.';
    $('approve').disabled = !snapshot.candidate || !$('confirm').checked;
  } catch (error) { snapshot = null; $('state').textContent = '상태 확인 실패: ' + error.message; $('approve').disabled = true; }
}
$('confirm').addEventListener('change', () => { $('approve').disabled = busy || !snapshot?.candidate || !$('confirm').checked; });
$('refresh').addEventListener('click', refresh);
$('approve').addEventListener('click', async () => {
  if (busy || !snapshot?.candidate || !$('confirm').checked) return;
  busy = true; $('approve').disabled = true;
  try {
    const result = await request('POST', { candidateIdentity: snapshot.candidate.identity,
      expectedCurrentIdentity: snapshot.currentIdentity, unresolvedStateConfirmed: true });
    approvedIdentity = result.identity;
    auditUnconfirmed = result.status === 'APPROVED_AUDIT_UNCONFIRMED';
    $('state').textContent = result.status === 'APPROVED_AUDIT_UNCONFIRMED'
      ? '연결 대상은 저장됐지만 완료 감사 기록 확인에 실패했습니다. 연결 상태와 로그를 확인하세요.'
      : '연결 대상으로 저장했습니다. 확장의 자동 재연결과 인증 결과를 확인 중입니다.';
    $('confirm').checked = false;
  } catch (error) { $('state').textContent = '승인 확인 실패 (' + error.message + '). 저장 여부를 다시 조회하세요.'; }
  finally { busy = false; await refresh(); }
});
void refresh();
setInterval(() => { if (!busy && !snapshot?.authenticated) void refresh(); }, 5_000);
