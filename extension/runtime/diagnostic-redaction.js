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
