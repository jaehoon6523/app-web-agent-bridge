export const RunListKnowledgeStatus = Object.freeze({
  AVAILABLE_EMPTY:"AVAILABLE_EMPTY",
  AVAILABLE_NONEMPTY:"AVAILABLE_NONEMPTY",
  UNAVAILABLE:"UNAVAILABLE",
});

function invalidRunListKnowledge(message) {
  return Object.assign(new TypeError(message), {
    code:"DASHBOARD_STATE_INVALID",
    status:200,
    responseReceived:true,
  });
}

export function projectRunListKnowledge(snapshot) {
  if (!Array.isArray(snapshot?.runs)) {
    throw invalidRunListKnowledge("runs must be an array before run-list knowledge can be projected.");
  }
  const declared = snapshot?.dataKnowledge?.runs?.status;
  const runs = snapshot.runs;

  if (typeof declared !== "string" || !declared) {
    throw invalidRunListKnowledge("dataKnowledge.runs.status is required.");
  }
  if (declared === RunListKnowledgeStatus.UNAVAILABLE) {
    if (runs.length !== 0) {
      throw invalidRunListKnowledge("UNAVAILABLE run knowledge cannot contain current runs.");
    }
    return Object.freeze({
      status:RunListKnowledgeStatus.UNAVAILABLE,
      count:null,
      runs:null,
    });
  }
  if (declared === RunListKnowledgeStatus.AVAILABLE_EMPTY) {
    if (runs.length !== 0) {
      throw invalidRunListKnowledge("AVAILABLE_EMPTY run knowledge cannot contain runs.");
    }
    return Object.freeze({
      status:RunListKnowledgeStatus.AVAILABLE_EMPTY,
      count:0,
      runs:Object.freeze([]),
    });
  }
  if (declared === RunListKnowledgeStatus.AVAILABLE_NONEMPTY) {
    if (runs.length === 0) {
      throw invalidRunListKnowledge("AVAILABLE_NONEMPTY run knowledge requires at least one run.");
    }
    return Object.freeze({
      status:RunListKnowledgeStatus.AVAILABLE_NONEMPTY,
      count:runs.length,
      runs:Object.freeze([...runs]),
    });
  }
  throw invalidRunListKnowledge(`Unknown run-list knowledge status: ${declared}`);
}
