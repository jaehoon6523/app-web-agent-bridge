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
  });
}

export function markDashboardSessionPending(previous) {
  return Object.freeze({ ...previous, session:DashboardSessionState.PENDING, lastError:null });
}

export function markDashboardSessionAuthenticated(previous) {
  return Object.freeze({
    ...previous,
    transport:TransportState.REACHABLE,
    session:DashboardSessionState.AUTHENTICATED,
    lastError:null,
  });
}

export function markStateReadStarted(previous) {
  return Object.freeze({ ...previous, stateRead:StateReadState.IN_FLIGHT, runtimeError:null, lastError:null });
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
  const lastError = Object.freeze({ status, code });

  if (phase === "PROJECTION") {
    return Object.freeze({
      ...previous,
      transport:responseReceived ? TransportState.REACHABLE : previous.transport,
      stateRead:StateReadState.FAILED,
      runtimeError:code ?? "DASHBOARD_PROJECTION_FAILED",
      lastError,
    });
  }

  if (phase === "SESSION") {
    if (!responseReceived) {
      return Object.freeze({
        ...previous,
        transport:TransportState.UNREACHABLE,
        session:DashboardSessionState.UNKNOWN,
        lastError,
      });
    }
    const authInvalid = status === 401 || code === "DASHBOARD_AUTH_INVALID" || code === "DASHBOARD_AUTH_REQUIRED";
    return Object.freeze({
      ...previous,
      transport:TransportState.REACHABLE,
      session:authInvalid ? DashboardSessionState.AUTH_INVALID : DashboardSessionState.REJECTED,
      stateRead:StateReadState.IDLE,
      lastError,
    });
  }

  if (phase === "STATE") {
    if (!responseReceived) {
      return Object.freeze({
        ...previous,
        transport:TransportState.UNREACHABLE,
        stateRead:StateReadState.FAILED,
        lastError,
      });
    }
    return Object.freeze({
      ...previous,
      transport:TransportState.REACHABLE,
      session:[401, 403].includes(status) ? DashboardSessionState.AUTH_INVALID : previous.session,
      stateRead:StateReadState.FAILED,
      lastError,
    });
  }

  return Object.freeze({ ...previous, lastError });
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
  const suffix = ` · 마지막 정상 상태 확인: ${lastConfirmedLabel}`;
  if (state?.transport === TransportState.UNREACHABLE) {
    return `서버 응답을 받지 못했습니다. 로컬 서버와 포트를 확인하세요.${suffix}`;
  }
  if (state?.session === DashboardSessionState.REJECTED) {
    const originProblem = ["LOCAL_BROWSER_REQUIRED", "DASHBOARD_ORIGIN_REQUIRED", "DASHBOARD_ORIGIN_INVALID", "DASHBOARD_ORIGIN_REJECTED"]
      .includes(state?.lastError?.code);
    return `${originProblem
      ? "서버는 실행 중이지만 현재 브라우저 주소가 허용된 대시보드 주소와 일치하지 않습니다. 설정된 로컬 서버 주소로 다시 여세요."
      : "서버는 실행 중이지만 이 브라우저의 대시보드 세션을 만들지 못했습니다. 기술 진단에서 세션 거부 원인을 확인하세요."}${suffix}`;
  }
  if (state?.session === DashboardSessionState.AUTH_INVALID) {
    return `서버는 실행 중입니다. 대시보드 인증에 실패했습니다. 인증 상태를 다시 확인하세요.${suffix}`;
  }
  if (state?.runtimeError) {
    return `서버 응답은 받았지만 Dashboard 상태를 해석하지 못했습니다. 기술 진단을 확인하세요.${suffix}`;
  }
  if (state?.stateRead === StateReadState.FAILED) {
    return `서버 연결은 확인되었습니다. 현재 작업 상태를 불러오지 못했습니다. 상태 조회를 다시 시도하세요.${suffix}`;
  }
  return "";
}
