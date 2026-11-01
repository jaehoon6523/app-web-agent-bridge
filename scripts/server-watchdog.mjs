import { performance } from "node:perf_hooks";

// Runs in the supervisor process: a timer in the blocked server cannot report a stall.
/** @param {any} child @param {(event:any)=>void} record @param {any} [options] */
export function watchServerProcess(child, record, { intervalMs=250, staleMs=1500, onHeartbeat } = {}) {
  let lastHeartbeat = performance.now();
  let missing = false;
  let lastStage = "process.starting";
  let lastTick = performance.now();
  let request = {};
  function message(event) {
    if (!event || typeof event.type !== "string") return;
    if (event.type === "heartbeat") {
      onHeartbeat?.(event);
      const now = performance.now();
      if (missing) record({ type:"watchdog.resumed", silenceMs:now-lastHeartbeat,
        loopDelayMs:event.loopDelayMs,
        deliveryLagMs:Number.isFinite(event.monotonicMs)
          ?Math.max(0,performance.timeOrigin+now-event.monotonicMs):null,
        lastStage, ...request });
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
    const now=performance.now();
    const silenceMs = now-lastHeartbeat;
    const watchdogTickDelayMs=Math.max(0,now-lastTick-intervalMs);
    const observerGapMs=now-lastTick;
    lastTick=now;
    if (!missing && silenceMs >= staleMs) {
      if (observerGapMs >= Math.max(intervalMs,staleMs-intervalMs)) {
        // A late observer cannot attribute the missing heartbeat to the server.
        record({ type:"watchdog.observerDelayed", silenceMs, watchdogTickDelayMs, lastStage, ...request });
        return;
      }
      missing = true;
      // Missing heartbeat alone cannot distinguish CPU stall, process pause or IPC failure.
      record({ type:"watchdog.unresponsive", silenceMs, watchdogTickDelayMs, lastStage, ...request });
    }
  }, intervalMs);
  return () => { clearInterval(timer); child.off("message", message); };
}
