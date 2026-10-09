// At most one operation and one latest follow-up exist, regardless of burst size.
export function createCoalescedTask(operation) {
  let running = null, pending = false, latest;
  return value => {
    latest = value; pending = true;
    if (!running) running = Promise.resolve().then(async () => {
      while (pending) { pending = false; await operation(latest); }
    }).finally(() => { running = null; });
    return running;
  };
}
