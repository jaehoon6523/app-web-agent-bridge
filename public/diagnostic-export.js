// Export an explicit diagnostic snapshot, never dashboard credentials or configuration.
const sensitiveKey = key => /^(authorization|proxyauthorization|authentication|cookie|setcookie|sharedsecret|password|passwd|token|accesstoken|refreshtoken|apikey|xapikey|clientsecret)$/.test(key.toLowerCase().replace(/[^a-z0-9]/g, ""));
function redactString(text, depth = 0) {
  if (depth >= 4 && /%[0-9a-f]{2}/i.test(text)) return "[REDACTED:ENCODED_VALUE]";
  if (depth < 4 && /%[0-9a-f]{2}/i.test(text) && !/^https?:\/\//i.test(text)) {
    try { const decoded = decodeURIComponent(text);
      if (decoded !== text) { const safe = redactString(decoded, depth + 1); if (safe !== decoded) return encodeURIComponent(safe); }
    } catch { /* Malformed encoding is handled by literal rules below. */ }
  }
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, raw => {
    try {
      const url = new URL(raw); let changed = false;
      if (url.username || url.password) { url.username = "REDACTED"; url.password = ""; changed = true; }
      for (const key of [...url.searchParams.keys()]) {
        if (sensitiveKey(key)) { url.searchParams.set(key, "REDACTED"); changed = true; }
        else { const values = url.searchParams.getAll(key), safe = values.map(value => redactString(value, depth + 1));
          if (safe.some((value,index)=>value!==values[index])) { url.searchParams.delete(key);for(const value of safe)url.searchParams.append(key,value);changed=true; } }
      }
      return changed ? url.toString() : raw;
    } catch { return raw; }
  }).replace(/\b(authorization|proxy[-_]?authorization|cookie|set[-_]?cookie)["']?\s*[:=]\s*[^\r\n]*/gi, "$1: [REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/\b((?:x[-_])?api[-_]?key|(?:access[-_]?|refresh[-_]?)?token|shared[-_]?secret|client[-_]?secret|password)(["']?\s*[=:]\s*["']?)[^\s"'&,;#]+/gi, "$1$2[REDACTED]");
}
export function redactDiagnosticLog(value) {
  if (Array.isArray(value)) return value.map(redactDiagnosticLog);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    sensitiveKey(key) ? "[REDACTED]" : redactDiagnosticLog(item)]));
  return typeof value === "string" ? redactString(value) : value;
}
const rawFields = new Set(["rawtext","text","content","prompt","discussion","objective","agreement","requirements","connectiondetail","tabdetail"]);
export function prepareDiagnosticLog(value, { includeRaw = false } = {}) {
  const omit = item => Array.isArray(item) ? item.map(omit) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).map(([key, child]) => [key,
      !includeRaw && rawFields.has(key.toLowerCase().replace(/[^a-z]/g,"")) ? "[OMITTED:RAW_CONTENT]" : omit(child)])) : item;
  return redactDiagnosticLog(omit(value));
}
export async function collectDiagnosticLog({ request, preparation, connectionState, lastConfirmed, runDiagnostic = null, includeRaw = false }) {
  // Capture the displayed observation before waiting for fresh remote observations.
  const displayed = structuredClone({ preparation, connectionState, lastConfirmed, runDiagnostic });
  const results = await Promise.allSettled([request("/api/agent-diagnostics"), request("/api/selector-diagnostics")]);
  const observation = result => result.status === "fulfilled" ? { status:"COLLECTED", data:result.value }
    : { status:"UNAVAILABLE", code:result.reason?.code ?? "COLLECTION_FAILED" };
  return prepareDiagnosticLog({ exportMode:includeRaw ? "WITH_RAW" : "DIAGNOSTIC_ONLY", schemaVersion:1, source:"CONTROLLER_EXPORT", exportedAt:new Date().toISOString(),
    note:"원시 응답에는 마스킹으로 탐지하지 못한 민감정보가 남을 수 있으므로 공유 전 검토하세요. displayed는 화면의 마지막 관측값입니다. 최신 서버·탭 관측과 시각이 다를 수 있습니다.",
    displayed, agent:observation(results[0]), selectors:observation(results[1]),
    partial:results.some(result => result.status === "rejected") }, { includeRaw });
}
export async function exportDiagnosticLog(input) {
  if (!globalThis.confirm("원시 응답에는 자동 마스킹으로 탐지하지 못한 민감정보가 남을 수 있습니다. 저장한 JSON을 텍스트 편집기에서 검토하고 필요한 값을 지운 뒤 공유하세요. 로컬 파일로 저장할까요?")) return { cancelled:true };
  const report = await collectDiagnosticLog(input);
  const url = URL.createObjectURL(new Blob([JSON.stringify(report,null,2)], {type:"application/json"}));
  const link = document.createElement("a"); link.href = url; link.download = "controller-diagnostics-latest.json";
  link.click(); setTimeout(() => URL.revokeObjectURL(url),10000); return report;
}
