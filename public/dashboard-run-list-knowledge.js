export const RunListKnowledgeStatus = Object.freeze({
  AVAILABLE_EMPTY:"AVAILABLE_EMPTY",
  AVAILABLE_NONEMPTY:"AVAILABLE_NONEMPTY",
  UNAVAILABLE:"UNAVAILABLE",
});

export function projectRunListKnowledge(snapshot) {
  const declared = snapshot?.dataKnowledge?.runs?.status ?? RunListKnowledgeStatus.UNAVAILABLE;
  const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : [];

  if (declared === RunListKnowledgeStatus.UNAVAILABLE) {
    return Object.freeze({
      status:RunListKnowledgeStatus.UNAVAILABLE,
      count:null,
      runs:null,
    });
  }
  if (declared === RunListKnowledgeStatus.AVAILABLE_EMPTY) {
    if (runs.length !== 0) throw new TypeError("AVAILABLE_EMPTY run knowledge cannot contain runs.");
    return Object.freeze({
      status:RunListKnowledgeStatus.AVAILABLE_EMPTY,
      count:0,
      runs:Object.freeze([]),
    });
  }
  if (declared === RunListKnowledgeStatus.AVAILABLE_NONEMPTY) {
    if (runs.length === 0) throw new TypeError("AVAILABLE_NONEMPTY run knowledge requires at least one run.");
    return Object.freeze({
      status:RunListKnowledgeStatus.AVAILABLE_NONEMPTY,
      count:runs.length,
      runs:Object.freeze([...runs]),
    });
  }
  throw new TypeError(`Unknown run-list knowledge status: ${declared}`);
}
