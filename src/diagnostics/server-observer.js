import { performance } from "node:perf_hooks";
import { errorMonitor } from "node:events";

// Diagnostic events never include URLs, queries, headers, bodies or credentials.
function routeLabel(url) {
  const pathname = String(url ?? "").split("?")[0];
  if (["/ws/extension", "/ws/dashboard"].includes(pathname)) return pathname;
  if (["/api/state", "/api/preflight", "/api/health", "/api/dashboard/session", "/api/commands"].includes(pathname)) return pathname;
  if (pathname === "/api/preparations" || /^\/api\/preparations\/[^/]+\/(?:reply|discard|cancel|approve)$/u.test(pathname) || pathname === "/api/preparations/web") return "preparation-mutation";
  return pathname.startsWith("/api/") ? "other-api" : "static";
}

export function diagnosticErrorCode(error) {
  if (!error) return null;
  const label = error.code ?? error.name;
  return typeof label === "string" && /^[A-Za-z0-9_]{1,64}$/u.test(label) ? label : "ERROR";
}

/** @param {((event: any) => void) | undefined} sink */
export function createServerObserver(sink) {
  const requests = new WeakMap();
  const socketRecords = new WeakMap(), sockets = new Map();
  let sequence = 0, socketSequence = 0, shuttingDown = false;
  function emit(type, detail = {}) {
    if (typeof sink !== "function") return;
    try { sink({ type, at:new Date().toISOString(), pid:process.pid, ...detail }); }
    catch { /* A diagnostic sink cannot change API or mutation results. */ }
  }
  function requestSnapshot(entry) {
    return { ...entry.detail, requestComplete:entry.req.complete, requestAborted:entry.req.aborted,
      status:entry.res.statusCode, headersSent:entry.res.headersSent,
      responseWritableEnded:entry.res.writableEnded, responseWritableFinished:entry.res.writableFinished };
  }
  function socketSnapshot(record) {
    const socket = record.socket;
    return { socketId:record.socketId, acceptedAt:record.acceptedAt,
      localPort:record.localPort, remotePort:record.remotePort,
      acceptedDuringShutdown:record.acceptedDuringShutdown, owner:record.owner,
      requestCount:record.requestCount, lastRequest:record.lastRequest,
      activeRequests:[...record.activeRequests.values()].map(requestSnapshot),
      upgrade:record.upgrade, webSocketState:record.ws ? ["CONNECTING","OPEN","CLOSING","CLOSED"][record.ws.readyState] : null,
      destroyed:socket.destroyed, readableEnded:socket.readableEnded,
      writableEnded:socket.writableEnded, writableFinished:socket.writableFinished,
      bytesRead:socket.bytesRead, bytesWritten:socket.bytesWritten,
      // A bounded event tail is retained only while this TCP connection is open.
      history:record.history.map(event => ({...event})) };
  }
  function socketEvent(record, event, detail = {}) {
    record.history.push({ event, at:new Date().toISOString(), ...detail });
    if (record.history.length > 16) record.history.shift();
    if (shuttingDown) emit("shutdown.socket.event", { event, ...socketSnapshot(record), ...detail });
  }
  function connected(socket) {
    if (typeof sink !== "function" || socketRecords.has(socket)) return;
    const record = { socket, socketId:++socketSequence, acceptedAt:new Date().toISOString(),
      localPort:socket.localPort, remotePort:socket.remotePort,
      acceptedDuringShutdown:shuttingDown, owner:"http-server-unclassified", requestCount:0,
      lastRequest:null, activeRequests:new Map(), upgrade:null, ws:null, history:[] };
    socketRecords.set(socket, record);
    sockets.set(record.socketId, record);
    socketEvent(record, "accepted");
    emit("connection.accepted", {socketId:record.socketId});
    socket.once("end", () => socketEvent(record, "end"));
    socket.once("finish", () => socketEvent(record, "finish"));
    // errorMonitor observes errors without installing an error handler or
    // changing EventEmitter's unhandled-error behavior. Never consume TCP data.
    socket.on(errorMonitor, error => socketEvent(record, "error", {errorCode:diagnosticErrorCode(error)}));
    socket.once("close", hadError => {
      sockets.delete(record.socketId);
      socketEvent(record, "close", {hadError});
      emit("connection.closed", {socketId:record.socketId,hadError});
    });
  }
  function received(req, res) {
    if (typeof sink !== "function") return;
    connected(req.socket);
    const record = socketRecords.get(req.socket);
    const method = ["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS","CONNECT","TRACE"].includes(req.method) ? req.method : "OTHER";
    const detail = { requestId:++sequence, socketId:record.socketId, method, route:routeLabel(req.url) };
    const entry = {detail,req,res};
    const started = performance.now();
    requests.set(req, detail);
    record.owner = "http-server";
    record.requestCount += 1;
    record.activeRequests.set(detail.requestId, entry);
    record.lastRequest = requestSnapshot(entry);
    socketEvent(record, "request", detail);
    emit("request.received", detail);
    res.once("finish", () => {
      record.activeRequests.delete(detail.requestId);
      record.lastRequest = requestSnapshot(entry);
      socketEvent(record, "response.finish", detail);
      emit("request.completed", { ...detail, status:res.statusCode, elapsedMs:performance.now()-started });
    });
    res.once("close", () => {
      record.activeRequests.delete(detail.requestId);
      record.lastRequest = requestSnapshot(entry);
      socketEvent(record, "response.close", detail);
      if (!res.writableFinished) emit("request.closed", { ...detail, elapsedMs:performance.now()-started });
    });
  }
  function upgrade(req, outcome = "PENDING", status = null, ws = null) {
    if (typeof sink !== "function") return;
    connected(req.socket);
    const record = socketRecords.get(req.socket);
    record.upgrade = {route:routeLabel(req.url), outcome, status};
    record.owner = outcome === "ACCEPTED" ? "extension-websocket" : "http-upgrade";
    if (ws) {
      record.ws = ws;
      ws.once("close", code => socketEvent(record, "websocket.close", {code}));
      ws.on(errorMonitor, error => socketEvent(record, "websocket.error", {errorCode:diagnosticErrorCode(error)}));
    }
    socketEvent(record, `upgrade.${outcome.toLowerCase()}`, record.upgrade);
  }
  function socketInventory(phase) {
    const details = [...sockets.values()].map(socketSnapshot);
    return {phase, sockets:details.length, readableEnded:details.filter(socket => socket.readableEnded).length,
      writableEnded:details.filter(socket => socket.writableEnded).length, socketDetails:details};
  }
  function beginShutdown() {
    shuttingDown = true;
    emit("shutdown.http.inventory", socketInventory("shutdown-start"));
  }
  function middleware(req, _res, next) {
    const detail = requests.get(req);
    if (detail) emit("request.express", detail);
    next();
  }
  function stage(req, type, detail = {}) { emit(type, {...detail, ...requests.get(req)}); }
  return { emit, received, middleware, stage, connected, upgrade, socketInventory, beginShutdown };
}
