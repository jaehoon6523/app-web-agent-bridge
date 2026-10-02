import { performance } from "node:perf_hooks";

// Diagnostic events never include URLs, queries, headers, bodies or credentials.
function routeLabel(url) {
  const pathname = String(url ?? "").split("?")[0];
  if (["/api/state", "/api/preflight", "/api/health", "/api/dashboard/session", "/api/commands"].includes(pathname)) return pathname;
  return pathname.startsWith("/api/") ? "other-api" : "static";
}

/** @param {((event: any) => void) | undefined} sink */
export function createServerObserver(sink) {
  const requests = new WeakMap();
  let sequence = 0;
  function emit(type, detail = {}) {
    if (typeof sink !== "function") return;
    try { sink({ type, at:new Date().toISOString(), pid:process.pid, ...detail }); }
    catch { /* A diagnostic sink cannot change API or mutation results. */ }
  }
  function received(req, res) {
    if (typeof sink !== "function") return;
    const detail = { requestId:++sequence, method:req.method, route:routeLabel(req.url) };
    const started = performance.now();
    requests.set(req, detail);
    emit("request.received", detail);
    res.once("finish", () => emit("request.completed", { ...detail, status:res.statusCode, elapsedMs:performance.now()-started }));
    res.once("close", () => {
      if (!res.writableFinished) emit("request.closed", { ...detail, elapsedMs:performance.now()-started });
    });
  }
  function middleware(req, _res, next) {
    const detail = requests.get(req);
    if (detail) emit("request.express", detail);
    next();
  }
  return { emit, received, middleware };
}
