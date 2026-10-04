/** @typedef {{code: number | null, signal: NodeJS.Signals | null}} CloseResult */
/** @param {import('node:child_process').ChildProcess} child */
// Observe from spawn, not from exit: descendants may retain the stdio pipes.
export function observeChildClose(child) {
  /** @type {CloseResult | undefined} */
  let result;
  let exited, ipcClosed = !child.connected;
  const streams = [child.stdin, child.stdout, child.stderr].filter(Boolean);
  /** @type {Promise<CloseResult>} */
  const promise = new Promise(resolve => {
    const finish = value => {
      if (result) return;
      result = value;
      child.off('close', closed); child.off('exit', exit); child.off('disconnect', disconnect);
      for (const stream of streams) stream.off('close', check);
      resolve(result);
    };
    // Parent-initiated IPC disconnect can omit the aggregate ChildProcess close
    // event. Public resource observations still require exit, every stdio close,
    // and IPC disconnect; an inherited descendant pipe cannot satisfy this.
    const check = () => { if (exited && ipcClosed && streams.every(stream => stream.closed)) finish(exited); };
    const closed = (code, signal) => finish({code,signal});
    const exit = (code, signal) => {exited={code,signal}; check();};
    const disconnect = () => {ipcClosed=true; check();};
    child.once('close', closed); child.once('exit', exit); child.once('disconnect', disconnect);
    for (const stream of streams) stream.once('close', check);
  });
  return {promise,get result() { return result; }};
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {ReturnType<typeof observeChildClose>} observation
 * @param {{timeoutMs: number, request?: () => void, onDeadline?: () => void, forceClose?: () => any}} options
 * @returns {Promise<CloseResult>}
 */
export async function waitChildClose(child, observation, {timeoutMs, request = () => {}, onDeadline = () => {},
  forceClose = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }}) {
  if (observation.result) return observation.result;
  let timer, forcedCleanup = Promise.resolve();
  try {
    /** @type {Promise<never>} */
    const deadline = new Promise((_,reject) => {
      timer = setTimeout(() => {
        try { onDeadline(); } catch {}
        const error = Object.assign(new Error('Child process resource closure deadline exceeded'),
          {code:'CHILD_CLOSE_DEADLINE',pid:child.pid,cleanupError:null});
        // The harness may own a whole tree. Production's default owns the direct child.
        forcedCleanup = Promise.resolve().then(forceClose).catch(cause => {
          error.cleanupError = cause?.code ?? 'FORCED_CLEANUP_FAILED';
          try { child.kill('SIGKILL'); } catch {}
        });
        reject(error);
      }, timeoutMs);
    });
    request();
    try { return await Promise.race([observation.promise,deadline]); }
    catch (error) {
      if (error.code === 'CHILD_CLOSE_DEADLINE') {
        await forcedCleanup;
        let drain;
        try { await Promise.race([observation.promise,new Promise(resolve => {drain=setTimeout(resolve,1000);})]); }
        finally {clearTimeout(drain);}
      }
      throw error;
    }
  } finally { clearTimeout(timer); }
}
