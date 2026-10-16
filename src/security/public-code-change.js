import { redactForEvidence } from "./redaction.js";

export function publicCodeChange(value) {
  function project(current) {
    if (Array.isArray(current)) return current.map(project);
    if (!current || typeof current !== "object") return current;
    return Object.fromEntries(Object.entries(current)
      .filter(([key]) => key !== "privateResponseRef")
      .map(([key, child]) => [key, project(child)]));
  }
  return redactForEvidence(project(value));
}
