// Read each response once, while its document still owns the network resource.
export function waitForState(page, predicate, { timeout = 90000 } = {}) {
  let timer, settled = false;
  const pending = new Promise((resolve, reject) => {
    const finish = (error, body) => {
      if (settled) return;
      settled = true; clearTimeout(timer); page.off('response', observe); page.off('close', closed);
      if (error) reject(error); else resolve(body);
    };
    const closed = () => finish(new Error('Dashboard closed while waiting for state'));
    const observe = async response => {
      if (settled || new URL(response.url()).pathname !== '/api/state' || response.status() !== 200) return;
      let body;
      try {
        body = await response.json();
      } catch (error) {
        // An old document's in-flight body may disappear during reload. Wait for
        // the new document's next actual state response; never synthesize state.
        if (/No resource with given identifier|No data found for resource|Response body is not available|navigated away/u.test(error.message)) return;
        finish(error); return;
      }
      try { if (!settled && await predicate(body)) finish(null, body); }
      catch (error) { finish(error); }
    };
    page.on('response', observe); page.once('close', closed);
    timer = setTimeout(() => finish(new Error(`Dashboard state predicate did not match within ${timeout}ms`)), timeout);
  });
  // A UI action may take time before its caller awaits this already-registered
  // observation. Preserve rejection for the caller without unhandled rejection.
  pending.catch(() => {});
  return pending;
}

export const canonicalText = text => text.replace(/\r\n/gu, '\n');
