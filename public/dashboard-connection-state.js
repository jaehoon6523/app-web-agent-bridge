import { redactDiagnosticLog } from "./diagnostic-export.js";

export const TransportState = Object.freeze({
  UNKNOWN:"UNKNOWN",
  REACHABLE:"SERVER_REACHABLE",
  UNREACHABLE:"SERVER_UNREACHABLE",
});

export const DashboardSessionState = Object.freeze({
  UNKNOWN:"UNKNOWN",
  PENDING:"DASHBOARD_SESSION_PENDING",
  AUTHENTICATED:"DASHBOARD_SESSION_AUTHENTICATED",
  REJECTED:"DASHBOARD_SESSION_REJECTED",
  AUTH_INVALID:"DASHBOARD_AUTH_INVALID",
});

export const StateReadState = Object.freeze({
  IDLE:"IDLE",
  IN_FLIGHT:"IN_FLIGHT",
  READY:"READY",
  FAILED:"STATE_READ_FAILED",
});

export const ExtensionState = Object.freeze({
  UNKNOWN:"UNKNOWN",
  DISCONNECTED:"EXTENSION_DISCONNECTED",
  AUTHENTICATED:"EXTENSION_AUTHENTICATED",
});

export const WebBindingState = Object.freeze({
  UNKNOWN:"UNKNOWN",
  REQUIRED:"WEB_BINDING_REQUIRED",
  BOUND:"WEB_BOUND",
});

export function initialDashboardConnectionState() {
  return Object.freeze({
    transport:TransportState.UNKNOWN,
    session:DashboardSessionState.UNKNOWN,
    stateRead:StateReadState.IDLE,
    runtimeError:null,
    lastError:null,
    failureHistory:Object.freeze([]),
  });
}

export function markDashboardSessionPending(previous) {
  return Object.freeze({ ...previous, session:DashboardSessionState.PENDING });
}

export function markDashboardSessionAuthenticated(previous) {
  return Object.freeze({
    ...previous,
    transport:TransportState.REACHABLE,
    session:DashboardSessionState.AUTHENTICATED,
  });
}

export function markStateReadStarted(previous) {
  return Object.freeze({ ...previous, stateRead:StateReadState.IN_FLIGHT });
}

export function markStateReadReady(previous) {
  return Object.freeze({
    ...previous,
    transport:TransportState.REACHABLE,
    session:DashboardSessionState.AUTHENTICATED,
    stateRead:StateReadState.READY,
    runtimeError:null,
    lastError:null,
  });
}

export function classifyDashboardFailure(previous, phase, error) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  const code = typeof error?.code === "string" ? error.code : null;
  const responseReceived = error?.responseReceived === true || status !== null;
  const lastError = Object.freeze({ status, code, phase,
    message:typeof error?.message === "string" ? redactDiagnosticLog(error.message.trim()).slice(0, 500) : "",
    at:new Date().toISOString(),
  });
  const sameFailure = entry => entry.phase === phase && entry.status === status && entry.code === code && entry.message === lastError.message;
  const failed = { ...previous, failureHistory:Object.freeze([
    ...(previous.failureHistory ?? []).filter(entry => !sameFailure(entry)), lastError,
  ].slice(-10)) };

  if (phase === "PROJECTION") {
    return Object.freeze({
      ...failed,
      transport:responseReceived ? TransportState.REACHABLE : previous.transport,
      stateRead:StateReadState.FAILED,
      runtimeError:code ?? "DASHBOARD_PROJECTION_FAILED",
      lastError,
    });
  }

  if (phase === "SESSION") {
    if (!responseReceived) {
      return Object.freeze({
        ...failed,
        transport:TransportState.UNREACHABLE,
        session:DashboardSessionState.UNKNOWN,
        lastError,
      });
    }
    const authInvalid = status === 401 || code === "DASHBOARD_AUTH_INVALID" || code === "DASHBOARD_AUTH_REQUIRED";
    return Object.freeze({
      ...failed,
      transport:TransportState.REACHABLE,
      session:authInvalid ? DashboardSessionState.AUTH_INVALID : DashboardSessionState.REJECTED,
      stateRead:StateReadState.IDLE,
      lastError,
    });
  }

  if (phase === "STATE") {
    if (!responseReceived) {
      return Object.freeze({
        ...failed,
        transport:TransportState.UNREACHABLE,
        stateRead:StateReadState.FAILED,
        lastError,
      });
    }
    return Object.freeze({
      ...failed,
      transport:TransportState.REACHABLE,
      session:[401, 403].includes(status) ? DashboardSessionState.AUTH_INVALID : previous.session,
      stateRead:StateReadState.FAILED,
      lastError,
    });
  }

  return Object.freeze({ ...failed, lastError });
}

export function requestFailureCode({ uncertainOnFailure, responseReceived = false, url = "", method = "GET" } = {}) {
  const normalizedMethod = String(method ?? "GET").toUpperCase();
  const pathname = String(url ?? "").split("?")[0];
  const inferredMutation = !["GET", "HEAD"].includes(normalizedMethod)
    && !["/api/dashboard/session", "/api/project/folder"].includes(pathname);
  if (uncertainOnFailure ?? inferredMutation) return "UNKNOWN_RESULT";
  return responseReceived ? "RESPONSE_READ_FAILED" : "REQUEST_UNREACHABLE";
}

export function dashboardStateReady(state) {
  return state?.transport === TransportState.REACHABLE
    && state?.session === DashboardSessionState.AUTHENTICATED
    && state?.stateRead === StateReadState.READY;
}

export function projectDashboardKnowledge(state) {
  return Object.freeze({
    transport:Object.freeze({
      state:state?.transport ?? TransportState.UNKNOWN,
      currentlyReachable:state?.transport === TransportState.REACHABLE,
    }),
    session:Object.freeze({
      lastKnownState:state?.session ?? DashboardSessionState.UNKNOWN,
      currentlyVerified:state?.transport === TransportState.REACHABLE
        && state?.session === DashboardSessionState.AUTHENTICATED,
    }),
    stateRead:Object.freeze({
      state:state?.stateRead ?? StateReadState.IDLE,
      currentlyAvailable:state?.stateRead === StateReadState.READY,
    }),
  });
}

export function projectBrowserState(preflight) {
  if (!preflight || typeof preflight !== "object") {
    return Object.freeze({ extension:ExtensionState.UNKNOWN, binding:WebBindingState.UNKNOWN });
  }
  const extension = preflight.checks?.extensionAuthenticated === true
    ? ExtensionState.AUTHENTICATED
    : preflight.checks?.extensionAuthenticated === false
      ? ExtensionState.DISCONNECTED
      : ExtensionState.UNKNOWN;
  const bindingStatus = preflight.lastWebBinding?.bindingStatus ?? null;
  const binding = extension !== ExtensionState.AUTHENTICATED
    ? WebBindingState.UNKNOWN
    : ["BOUND", "ROOT_READY"].includes(bindingStatus)
      ? WebBindingState.BOUND
      : WebBindingState.REQUIRED;
  return Object.freeze({ extension, binding });
}

export function connectionNoticeFor(state, lastConfirmedLabel = "없음") {
  const error = state?.lastError;
  const suffix = `${error?.message ? " · " + error.message : ""} · 마지막 정상 상태 확인: ${lastConfirmedLabel}`;
  if (state?.transport === TransportState.UNREACHABLE) {
    return `서버 응답 없음 · 로컬 서버와 포트를 확인하세요.${suffix}`;
  }
  const authInvalid = error?.status === 401 || ["DASHBOARD_AUTH_INVALID", "DASHBOARD_AUTH_REQUIRED"].includes(error?.code);
  if (state?.session === DashboardSessionState.REJECTED || error?.phase === "SESSION" && !authInvalid) {
    const originProblem = ["LOCAL_BROWSER_REQUIRED", "DASHBOARD_ORIGIN_REQUIRED", "DASHBOARD_ORIGIN_INVALID", "DASHBOARD_ORIGIN_REJECTED"]
      .includes(state?.lastError?.code);
    return `${originProblem
      ? "대시보드 주소가 일치하지 않습니다. 설정된 로컬 서버 주소로 다시 여세요."
      : "대시보드 세션을 만들지 못했습니다. 기술 진단을 확인하세요."}${suffix}`;
  }
  if (state?.session === DashboardSessionState.AUTH_INVALID || authInvalid || error?.phase === "STATE" && error.status === 403) {
    return `대시보드 인증 실패 · 인증 상태를 확인하세요.${suffix}`;
  }
  if (state?.runtimeError) {
    return `상태 응답 해석 실패 · 기술 진단을 확인하세요.${suffix}`;
  }
  if (state?.stateRead === StateReadState.FAILED || error?.phase === "STATE") {
    return `상태 조회 실패 · 다시 확인하세요.${suffix}`;
  }
  return "";
}
