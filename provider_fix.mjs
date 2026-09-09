import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const originals = new Map();
const staged = new Map();

function load(rel) {
  if (!originals.has(rel)) originals.set(rel, fs.readFileSync(path.join(root, rel), "utf8"));
  return staged.get(rel) ?? originals.get(rel);
}
function stage(rel, text) {
  staged.set(rel, text);
}
function replaceOne(text, regex, replacement, label) {
  const matches = [...text.matchAll(regex)];
  if (matches.length !== 1) {
    throw new Error(`${label}: expected exactly 1 match, found ${matches.length}`);
  }
  return text.replace(regex, replacement);
}

try {
  // server.js
  {
    const rel = "src/server.js";
    let text = load(rel);

    const preflight = `  function livePreflight() {
    const audit = auditSettings;
    const provider = runtimeConfig.codeWorker?.provider ?? "codex";
    const codeWorkerExecutableConfigured = provider === "codex"
      ? runtimeConfig.codex?.executablePath != null
      : runtimeConfig.codeWorker?.executablePath != null;
    const checks = {
      demoModeDisabled: runtimeConfig.demoMode === false,
      codeWorkerExecutableConfigured,
      discussionCodexExecutableConfigured: runtimeConfig.codex?.executablePath != null,
      extensionAuthenticated: Boolean(extensionTransport?.authenticated),
      webAdapterAvailable: webSession !== null,
      commandAuthenticationConfigured: dashboardAuth !== null,
      auditProjectConfigured: audit.project !== null,
    };
    const commonKeys = ["demoModeDisabled", "extensionAuthenticated", "webAdapterAvailable", "commandAuthenticationConfigured"];
    const codeChangeKeys = [...commonKeys, "codeWorkerExecutableConfigured", "auditProjectConfigured"];
    const discussionKeys = [...commonKeys, "discussionCodexExecutableConfigured"];
    const missingFor = (keys) => keys.filter((key) => !checks[key]);
    const missing = missingFor(codeChangeKeys);
    const discussionMissing = missingFor(discussionKeys);
    return Object.freeze({
      checks,
      missing,
      discussionMissing,
      readyForProvisioning: missing.length === 0,
      readyForDiscussion: discussionMissing.length === 0,
      workerProvider: provider,
      project: audit.project ? {
        projectId: audit.project.projectId,
        targetRoot: audit.project.targetRoot,
        requirementsId: audit.project.requirements.requirementsId,
        revision: audit.project.requirements.revision,
        requirements: audit.project.requirements,
        policy: audit.project.policy,
        verifications: audit.project.verifications.map(({ verificationId, purpose }) => ({ verificationId, purpose })),
      } : null,
      projectError: audit.error,
    });
  }

`;

    text = replaceOne(
      text,
      /  function livePreflight\(\) \{[\s\S]*?\n  \}\r?\n\r?\n(?=  function requireDashboardMutation)/g,
      preflight,
      "server livePreflight",
    );

    const health = `  app.get("/api/health", async (_req, res) => {
    const preflight = livePreflight();
    const web = await webSession?.inspect();
    const codexReady = liveRuntime?.manager?.status === "READY";
    const webReady = preflight.checks.extensionAuthenticated && web?.sessionReady === true;
    const bound = webReady && web?.binding?.bindingStatus === "BOUND";
    const discussionRuntimeReady = Boolean(codexReady && bound);
    res.json({
      ok: true,
      at: nowIso(),
      demoMode: runtimeConfig.demoMode,
      coreOrchestrationReady: liveRuntime !== null,
      fakeVerticalSliceVerified: null,
      codexRuntimeReady: codexReady,
      codeWorkerProvider: preflight.workerProvider,
      codeWorkerConfigured: preflight.checks.codeWorkerExecutableConfigured,
      codeChangeProvisioningReady: preflight.readyForProvisioning,
      webRuntimeReady: webReady,
      liveSessionBindingReady: Boolean(bound),
      discussionRuntimeReady,
      liveOrchestrationReady: discussionRuntimeReady,
      webConnected: preflight.checks.extensionAuthenticated,
      liveCompositionConfigured: preflight.checks.discussionCodexExecutableConfigured,
    });
  });
`;

    text = replaceOne(
      text,
      /  app\.get\("\/api\/health", async \(_req, res\) => \{[\s\S]*?\n  \}\);\r?\n(?=  app\.get\("\/api\/preflight")/g,
      health,
      "server /api/health",
    );

    stage(rel, text);
  }

  // registry.js
  {
    const rel = "src/runtime/workers/registry.js";
    let text = load(rel);
    if (!text.includes('get externalSessionId() { return worker.externalSessionId; }')) {
      text = replaceOne(
        text,
        /  return Object\.freeze\(\{\r?\n    \.\.\.worker,\r?\n(?=    async submitTurn)/g,
        `  return Object.freeze({\n    ...worker,\n    get externalSessionId() { return worker.externalSessionId; },\n`,
        "registry externalSessionId",
      );
    }
    stage(rel, text);
  }

  // live-discussion-runtime.js
  {
    const rel = "src/runtime/live-discussion-runtime.js";
    let text = load(rel);
    if (text.includes('"Codex executable validation failed before app-server startup."')) {
      const codeCount = (text.match(/"CODEX_RUNTIME_CONFIGURATION_INVALID"/g) || []).length;
      if (codeCount !== 1) {
        throw new Error(`runtime Codex error code: expected 1 match, found ${codeCount}`);
      }
      text = text
        .replace(
          '"Codex executable validation failed before app-server startup."',
          '"Artifact store initialization failed before runtime startup."',
        )
        .replace(
          '"CODEX_RUNTIME_CONFIGURATION_INVALID"',
          '"ARTIFACT_STORE_INITIALIZATION_FAILED"',
        );
    }
    stage(rel, text);
  }

  // code-change-service.js
  {
    const rel = "src/orchestration/code-change-service.js";
    let text = load(rel);

    // Only touch the worker result message. The nearby messageId makes this
    // independent of line wrapping/indentation while still narrowly scoped.
    const alreadyDynamic = /messageId:\s*`worker_\$\{run\.iteration\}`[\s\S]{0,300}?workerProvider\s*:/.test(text);

    if (!alreadyDynamic) {
      const workerMessage = /(messageId:\s*`worker_\$\{run\.iteration\}`[\s\S]{0,220}?fromActor:\s*)"CODEX_AGENT"(\s*,\s*content:\s*completed\.text)/g;
      const matches = [...text.matchAll(workerMessage)];

      if (matches.length !== 1) {
        throw new Error(`code-change-service worker actor: expected exactly 1 match, found ${matches.length}`);
      }

      text = text.replace(
        workerMessage,
        `$1(completed.provider || this.workerConfig.provider) === "codex" ? "CODEX_AGENT" : "CODE_WORKER", workerProvider: completed.provider || this.workerConfig.provider$2`,
      );
    }

    stage(rel, text);
  }

  // generic-jsonl-worker.js
  {
    const rel = "src/runtime/workers/generic-jsonl-worker.js";
    let text = load(rel);

    const duplicateRegex =
      /\r?\n  processHandle\.on\("error", \(error\) => \{\r?\n    closed = true;\r?\n    const wrapped = new Error\(\r?\n      `\$\{provider\} worker failed to start or communicate: \$\{error\?\.message \|\| "unknown child-process error"\}`,\r?\n      \{ cause: error \},\r?\n    \);\r?\n    for \(const waiter of pending\.values\(\)\) waiter\.reject\(wrapped\);\r?\n    pending\.clear\(\);\r?\n    try \{ lines\.close\(\); \} catch \{\}\r?\n  \}\);\r?\n/g;

    const matches = [...text.matchAll(duplicateRegex)];
    if (matches.length > 1) {
      throw new Error(`generic worker duplicate error handler: expected at most 1 match, found ${matches.length}`);
    }
    if (matches.length === 1) text = text.replace(duplicateRegex, "\n");

    stage(rel, text);
  }

  // Commit only after every validation succeeds.
  const changed = [];
  for (const [rel, next] of staged) {
    const prev = originals.get(rel);
    if (next !== prev) {
      fs.writeFileSync(path.join(root, rel), next, "utf8");
      changed.push(rel);
    }
  }

  console.log("Updated:");
  for (const rel of changed) console.log(`- ${rel}`);
  if (changed.length === 0) console.log("- no changes needed");
  console.log("Done.");
} catch (error) {
  console.error(`ABORTED: ${error.message}`);
  console.error("No files were written.");
  process.exitCode = 1;
}
