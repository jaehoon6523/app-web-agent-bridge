import { RunListKnowledgeStatus } from "./dashboard-run-list-knowledge.js";

export function projectDashboardStartActions({
  stateAvailable,
  runListKnowledge,
  runtimeAvailable,
  extensionAuthenticated,
  preparationStartCapability,
  hasUnfinishedRun,
  workflowStage,
  preparationActive,
} = {}) {
  const runListKnown = [
    RunListKnowledgeStatus.AVAILABLE_EMPTY,
    RunListKnowledgeStatus.AVAILABLE_NONEMPTY,
  ].includes(runListKnowledge?.status);

  const canOpenNewRun = stateAvailable === true
    && runListKnown
    && hasUnfinishedRun !== true
    && preparationActive !== true
    && !["PREPARE", "WORK"].includes(workflowStage);

  const canStartPreparation = canOpenNewRun
    && workflowStage === "START"
    && runtimeAvailable === true
    && extensionAuthenticated === true
    && preparationStartCapability === true;

  return Object.freeze({ canOpenNewRun, canStartPreparation });
}
