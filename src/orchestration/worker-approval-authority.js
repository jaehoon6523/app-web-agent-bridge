import path from "node:path";

const COMMAND_APPROVAL = "item/commandExecution/requestApproval";
const FILE_APPROVAL = "item/fileChange/requestApproval";
const APPROVAL_METHODS = new Set([COMMAND_APPROVAL, FILE_APPROVAL]);

function insideWorkspace(workspaceRoot, candidate) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot
    || typeof candidate !== "string" || !candidate) return false;
  const root = path.resolve(workspaceRoot);
  const target = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function rejectDecision(offered) {
  if (offered.has("decline")) return "decline";
  if (offered.has("cancel")) return "cancel";
  return null;
}

export function createWorkerApprovalAuthority(workspaceRoot) {
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) {
    throw new TypeError("Worker approval authority requires an absolute workspace root.");
  }

  const fileChangesByItem = new Map();

  return Object.freeze({
    observe(event) {
      if (!event?.itemId || event.toolType !== "fileChange") return;
      if (event.type === "TOOL_STARTED") {
        fileChangesByItem.set(event.itemId, Array.isArray(event.changes) ? event.changes : []);
      } else if (event.type === "TOOL_COMPLETED") {
        fileChangesByItem.delete(event.itemId);
      }
    },

    decide(event) {
      const offered = new Set(Array.isArray(event?.availableDecisions) ? event.availableDecisions : []);
      const reject = () => rejectDecision(offered);

      if (!event || event.type !== "APPROVAL_REQUESTED") return null;
      if (!APPROVAL_METHODS.has(event.sourceMethod)) return reject();
      if (event.networkApprovalContext != null) return reject();

      if (event.sourceMethod === COMMAND_APPROVAL) {
        if (!insideWorkspace(workspaceRoot, event.cwd)) return reject();
      } else {
        if (event.grantRoot != null && !insideWorkspace(workspaceRoot, event.grantRoot)) return reject();

        const changes = fileChangesByItem.get(event.itemId);
        if (!Array.isArray(changes) || changes.length === 0) return reject();
        if (changes.some((change) => !insideWorkspace(workspaceRoot, change?.path))) return reject();
      }

      return offered.has("accept") ? "accept" : reject();
    },

    clear() {
      fileChangesByItem.clear();
    },
  });
}
