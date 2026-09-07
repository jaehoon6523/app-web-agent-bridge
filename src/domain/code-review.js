import { parseFinalControllerPacketJsonEnvelope } from "./controller-packet-envelope.js";

export function parseCodeReviewResponse(rawText, policy) {
  const parsed = parseFinalControllerPacketJsonEnvelope(rawText);
  const evaluated = evaluateCodeReview(parsed.parsed, policy);
  return Object.freeze({ body: parsed.body, packetText: parsed.packetText, packet: evaluated.report });
}

// Evaluation data never supplies Controller actions. Threshold and evidence
// references must come from the Controller's captured review request.
export function evaluateCodeReview(report, { threshold, evidenceRefs }) {
  const keys = ["score", "findings", "evidenceRefs", "summary"];
  if (!report || Object.getPrototypeOf(report) !== Object.prototype
    || Object.keys(report).length !== keys.length
    || keys.some((key) => !Object.hasOwn(report, key))) {
    throw new TypeError("Review report must contain only score, findings, evidenceRefs and summary.");
  }
  if (!Number.isFinite(threshold) || !Number.isFinite(report.score)) {
    throw new TypeError("Review score and Controller threshold must be finite numbers.");
  }
  for (const field of ["findings", "evidenceRefs"]) {
    if (!Array.isArray(report[field]) || report[field].some((value) => typeof value !== "string" || !value.trim())) {
      throw new TypeError(`Review ${field} must contain non-empty strings.`);
    }
  }
  if (typeof report.summary !== "string" || !report.summary.trim()) {
    throw new TypeError("Review summary is required.");
  }
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0
    || evidenceRefs.some((value) => typeof value !== "string" || !value.trim())) {
    throw new TypeError("Controller must supply captured evidence references.");
  }
  if (report.evidenceRefs.length === 0 || report.evidenceRefs.some((ref) => !evidenceRefs.includes(ref))) {
    throw new TypeError("Review references evidence outside the Controller's review request.");
  }
  return Object.freeze({
    decision: report.score >= threshold ? "PASS" : "REWORK",
    report: Object.freeze({ ...report,
      findings: Object.freeze([...report.findings]), evidenceRefs: Object.freeze([...report.evidenceRefs]),
    }),
  });
}
