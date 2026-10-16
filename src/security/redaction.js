import path from "node:path";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(?:authorization|proxy-authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|passwd|cookie|credential|private[_-]?key)/iu;
const AUTHORIZATION_VALUE = /\b((?:Bearer|Basic)\s+)([A-Za-z0-9._~+\/-]+=*)/giu;
const ASSIGNMENT_VALUE = /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[=:]\s*)([^\s,;]+)/giu;
const QUOTED_PAIR = /("(?:\\[\s\S]|[^"\\])*")(\s*:\s*)("(?:\\[\s\S]|[^"\\])*")/gu;

export class RedactionError extends TypeError {
  constructor(message, code = "REDACTION_ERROR") {
    super(message);
    this.name = "RedactionError";
    this.code = code;
  }
}

function normalizeRoots(roots) {
  if (!Array.isArray(roots)) throw new RedactionError("sensitiveRoots must be an array.");
  return roots
    .filter((entry) => typeof entry === "string" && entry.trim() !== "")
    .map((entry) => path.resolve(entry))
    .sort((left, right) => right.length - left.length);
}

function redactString(value, roots) {
  const replaceCredential = (match, prefix, token, offset, source) => {
    if (/[\r\n]/u.test(prefix)) {
      const start = offset + prefix.length;
      const end = source.indexOf("\n", start);
      const line = source.slice(source.lastIndexOf("\n", start - 1) + 1, end < 0 ? undefined : end).trimEnd();
      // A missing value must not consume Markdown or controller framing.
      if (/^(?: {0,3}(?:`{3,}|~{3,})[^\r\n]*|CONTROLLER_PACKET_(?:BEGIN|END)|<\/?controller_packet>)$/u.test(line)) return match;
    }
    return `${prefix}${REDACTED}`;
  };
  let redacted = value
    .replace(QUOTED_PAIR, (match, key, separator) => {
      try { return SENSITIVE_KEY.test(JSON.parse(key)) ? `${key}${separator}${JSON.stringify(REDACTED)}` : match; }
      catch { return match; }
    })
    .replace(AUTHORIZATION_VALUE, replaceCredential)
    .replace(ASSIGNMENT_VALUE, replaceCredential);
  for (const root of roots) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    redacted = redacted.replace(new RegExp(escaped, "giu"), "<REDACTED_PATH>");
  }
  return redacted;
}

export function redactForEvidence(value, { sensitiveRoots = [], maxDepth = 30 } = {}) {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
    throw new RedactionError("maxDepth must be a positive safe integer.");
  }
  const roots = normalizeRoots(sensitiveRoots);
  const ancestors = new Set();

  function visit(current, depth, key = "") {
    if (SENSITIVE_KEY.test(key)) return REDACTED;
    if (typeof current === "string") return redactString(current, roots);
    if (current === null || typeof current === "boolean" || typeof current === "number") {
      return current;
    }
    if (current === undefined) return null;
    if (typeof current !== "object") return String(current);
    if (depth > maxDepth) {
      throw new RedactionError("Evidence value exceeds redaction depth.", "REDACTION_DEPTH_EXCEEDED");
    }
    if (ancestors.has(current)) {
      throw new RedactionError("Evidence value is cyclic.", "CYCLIC_EVIDENCE");
    }

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        return current.map((item) => visit(item, depth + 1));
      }
      const output = {};
      for (const [childKey, childValue] of Object.entries(current)) {
        output[childKey] = visit(childValue, depth + 1, childKey);
      }
      return output;
    } finally {
      ancestors.delete(current);
    }
  }

  return visit(value, 1);
}

export { REDACTED };
