import { performance } from "node:perf_hooks";

// Runs in the supervisor process: a timer in the blocked server cannot report a stall.
export function watchServerProcess(child, record, { intervalMs=250, staleMs=1500 } = {}) {
  let lastHeartbeat = performance.now();
  let missing = false;
  let lastStage = "process.starting";
  let request = {};
  function message(event) {
    if (!event || typeof event.type !== "string") return;
    if (event.type === "heartbeat") {
      const now = performance.now();
      if (missing) record({ type:"watchdog.resumed", silenceMs:now-lastHeartbeat, loopDelayMs:event.loopDelayMs, lastStage, ...request });
      else if (event.loopDelayMs >= staleMs) record({ type:"event-loop.delay", loopDelayMs:event.loopDelayMs, lastStage, ...request });
      missing = false;
      lastHeartbeat = now;
      return;
    }
    if (event.type === "request.received" || event.type === "request.express") {
      lastStage = event.type;
      request = {requestId:event.requestId, route:event.route};
    }
    if (/^(?:runtime|preparation)\.initialization\.|^preparation\.mutation\.|^state\.|^persistence\./u.test(event.type)) {
      lastStage = event.type;
      if (event.requestId !== undefined) request = {requestId:event.requestId,route:event.route};
    }
    record(event);
  }
  child.on("message", message);
  const timer = setInterval(() => {
    const silenceMs = performance.now()-lastHeartbeat;
    if (!missing && silenceMs >= staleMs) {
      missing = true;
      // Missing heartbeat alone cannot distinguish CPU stall, process pause or IPC failure.
      record({ type:"watchdog.unresponsive", silenceMs, lastStage, ...request });
    }
  }, intervalMs);
  return () => { clearInterval(timer); child.off("message", message); };
}
