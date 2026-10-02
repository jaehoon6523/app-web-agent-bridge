import { performance } from "node:perf_hooks";
import { main } from "../src/server.js";

function send(event) {
  if (process.connected) process.send(event, () => {});
}
let previous = performance.now();
const heartbeat = setInterval(() => {
  const now = performance.now();
  send({ type:"heartbeat", loopDelayMs:Math.max(0, now-previous-250) });
  previous = now;
}, 250);
heartbeat.unref();
process.once("message", async ({ runtimeConfig }) => {
  try { await main(runtimeConfig, { onDiagnostic:send }); }
  catch {
    send({ type:"startup.failed" });
    process.exitCode = 1;
    process.disconnect();
  }
});
