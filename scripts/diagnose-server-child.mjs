import { performance } from "node:perf_hooks";

const bootstrapStarted = performance.now();

function send(event) {
  if (process.connected) process.send({ ...event,
    bootstrapElapsedMs:Math.round(performance.now()-bootstrapStarted) }, () => {});
}
// Register before loading the server so early configuration is retained.
let receiveConfiguration;
const configuration = new Promise(resolve => { receiveConfiguration = resolve; });
const onConfiguration = ({ runtimeConfig }) => {
  send({ type:"startup.config.received" });
  receiveConfiguration(runtimeConfig);
};
process.once("message", onConfiguration);
send({ type:"startup.receiver.ready" });
let previous = performance.now();
const heartbeat = setInterval(() => {
  const now = performance.now();
  send({ type:"heartbeat", at:new Date().toISOString(),monotonicMs:performance.timeOrigin+now,loopDelayMs:Math.max(0, now-previous-250) });
  previous = now;
}, 250);
heartbeat.unref();
void (async () => {
  let stage = "import";
  try {
    send({ type:"startup.import.started" });
    const server = import("../src/server.js").then(module => {
      send({ type:"startup.import.completed" });
      return module;
    });
    const [{ main }, runtimeConfig] = await Promise.all([server, configuration]);
    stage = "main";
    send({ type:"startup.main.started" });
    // Forward server.listening with the same child bootstrap clock.
    await main(runtimeConfig, { onDiagnostic:send });
    send({ type:"startup.main.completed" });
  } catch (error) {
    const errorCode = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
      ? error.code : "STARTUP_FAILED";
    send({ type:"startup.failed", stage, errorCode });
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  } finally {
    process.off("message", onConfiguration);
  }
})();
