import { randomUUID } from "node:crypto";
import { projectDiagnostics } from "./preparation-diagnostics.js";

const pending = new WeakMap();
// A shared, bounded read. Inspection never prepares, injects or sends a prompt.
export function collectSelectorDiagnostics(transport, { timeoutMs = 10000 } = {}) {
  if (!transport?.authenticated) return Promise.reject(Object.assign(new Error("Connect the extension first."), { code:"EXTENSION_NOT_AUTHENTICATED" }));
  if (pending.has(transport)) return pending.get(transport);
  const requestId = randomUUID();
  const result = new Promise((resolve, reject) => {
    let timer;
    const finish = (error, value) => {
      clearTimeout(timer); transport.off("message", receive);
      error ? reject(error) : resolve(value);
    };
    const receive = message => {
      if (message.type !== "extension.diagnostics.inspected" || message.requestId !== requestId) return;
      const tabs = message.payload?.tabs;
      if (!Array.isArray(tabs)) return finish(Object.assign(new Error("Tab inspection failed."), {code:"TAB_INSPECTION_FAILED"}));
      finish(null, { inspectedAt:new Date().toISOString(), tabs:tabs.slice(0, 8).map(projectDiagnostics) });
    };
    timer = setTimeout(() => finish(Object.assign(new Error("Tab inspection timed out."), { code:"TAB_INSPECTION_TIMEOUT" })), timeoutMs);
    transport.on("message", receive);
    try { transport.send({ type:"controller.diagnostics.inspect", requestId }); }
    catch (error) { finish(error); }
  });
  pending.set(transport, result);
  result.finally(() => pending.delete(transport)).catch(() => {});
  return result;
}
