import { performance } from "node:perf_hooks";

// Runs in the supervisor process: a timer in the blocked server cannot report a stall.
export function watchServerProcess(child, record, { intervalMs=250, staleMs=1500 } = {}) {
  let lastHeartbeat = performance.now();
  let missing = false;
  let lastStage = "process.starting";
  function message(event) {
    if (!event || typeof event.type !== "string") return;
    if (event.type === "heartbeat") {
      const now = performance.now();
      if (missing) record({ type:"watchdog.resumed", silenceMs:now-lastHeartbeat, loopDelayMs:event.loopDelayMs, lastStage });
      else if (event.loopDelayMs >= staleMs) record({ type:"event-loop.delay", loopDelayMs:event.loopDelayMs, lastStage });
      missing = false;
      lastHeartbeat = now;
      return;
    }
    if (/^(?:runtime|preparation)\.initialization\.|^state\./u.test(event.type)) lastStage = event.type;
    record(event);
  }
  child.on("message", message);
  const timer = setInterval(() => {
    const silenceMs = performance.now()-lastHeartbeat;
    if (!missing && silenceMs >= staleMs) {
      missing = true;
      // Missing heartbeat alone cannot distinguish CPU stall, process pause or IPC failure.
      record({ type:"watchdog.unresponsive", silenceMs, lastStage });
    }
  }, intervalMs);
  return () => { clearInterval(timer); child.off("message", message); };
}
