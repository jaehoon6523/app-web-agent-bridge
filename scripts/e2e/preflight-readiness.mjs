export async function waitForPreflight(url, { timeoutMs = 15000, checkAlive = () => {}, fetchResponse = fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastObservation = { kind:'NO_RESPONSE' };
  while (Date.now() < deadline) {
    await checkAlive();
    try {
      const response = await fetchResponse(url, { signal:AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now()))) });
      const body = await response.json();
      // Keep unsuccessful observations separate from the successfully confirmed value.
      lastObservation = { kind:'HTTP_RESPONSE', status:response.status,
        checksPresent:Boolean(body?.checks && typeof body.checks === 'object' && !Array.isArray(body.checks)) };
      if (response.status === 200 && lastObservation.checksPresent) return { preflight:body, lastObservation };
    } catch (error) {
      const cause = error.cause;
      lastObservation = { kind:'READ_FAILURE', errorName:error.name,
        errorCode:error.code ?? null, causeCode:cause?.code ?? null,
        causeSyscall:['connect','read','write','getaddrinfo'].includes(cause?.syscall) ? cause.syscall : null,
        nestedCauseCodes:Array.isArray(cause?.errors) ? cause.errors.slice(0,4).map(item=>item?.code ?? null) : [] };
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)));
  }
  throw Object.assign(new Error(`Preflight readiness failed: ${JSON.stringify(lastObservation)}`), { lastObservation });
}
