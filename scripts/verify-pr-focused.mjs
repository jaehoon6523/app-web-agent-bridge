import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";

const [base, head] = process.argv.slice(2);
if (![base, head].every(value => /^[a-f0-9]{40}$/u.test(value ?? ""))) {
  throw new Error("Usage: node scripts/verify-pr-focused.mjs <base-sha> <head-sha>");
}

const changedPaths = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`, "--"],
  { encoding:"utf8" }).split("\0").filter(Boolean);
const checkout = execFileSync("git", ["rev-parse", "HEAD"], { encoding:"utf8" }).trim();
const groups = [
  [/^extension\/(?:background\.js|content\.js|manifest\.json|runtime\/(?:browser-runtime|conversation-bootstrap|current-target|document-binding|provider-target)\.js)$/u, [
    "tests/content-lifecycle.test.js",
    "tests/conversation-bootstrap-tab.test.js",
    "tests/exact-conversation-reopen.test.js",
    "tests/readiness-diagnostics.test.js",
  ]],
  [/^extension\/runtime\/(?:delivery-|storage\.)/u, [
    "tests/extension-delivery-review.test.js",
    "tests/web-extension-storage.new.test.js",
  ]],
  [/^src\/orchestration\/preparation|^src\/runtime\/web\//u, [
    "tests/preparation-service.test.js",
    "tests/preparation-stale-tab-integration.test.js",
    "tests/web-runtime-core.new.test.js",
  ]],
  [/^public\/|^src\/orchestration\/dashboard-/u, [
    "tests/dashboard-controller.test.js",
    "tests/contract/dashboard-degraded-state.contract.test.js",
    "tests/contract/dashboard-action-capabilities.contract.test.js",
  ]],
  [/^\.github\/workflows\/|^scripts\/verif/u, [
    "tests/verification-plan.test.js",
    "tests/contract/web-dependency-state.contract.test.js",
  ]],
];
const common = [
  "tests/web-runtime-core.new.test.js",
  "tests/contract/preparation-capabilities.contract.test.js",
  "tests/contract/web-dependency-state.contract.test.js",
];
const selected = new Set();
for (const filename of changedPaths) {
  if (/^(?:docs\/.*\.(?:md|txt)|[^/]+\.md)$/iu.test(filename)) continue;
  const matching = groups.filter(([pattern]) => pattern.test(filename));
  if (matching.length) {
    for (const [, tests] of matching) tests.forEach(test => selected.add(test));
  } else if (/^tests\/.*\.test\.[cm]?js$/u.test(filename) && existsSync(filename)) {
    selected.add(filename);
  } else {
    common.forEach(test => selected.add(test));
  }
}

function report(message) {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n\n`);
}

const tests = [...selected].sort();
report(`Checkout ${checkout}; PR base ${base}; PR head ${head}`);
report(`Changed paths: ${JSON.stringify(changedPaths)}`);
if (!tests.length) {
  report(changedPaths.length ? "Documentation-only change. No focused tests apply." : "No changed paths.");
} else {
  report(`Selected tests: ${JSON.stringify(tests)}`);
  const result = spawnSync(process.execPath, ["scripts/run-tests.mjs", ...tests], { stdio:"inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  report(`Focused test runner exit: ${process.exitCode}. See the per-file results in this job log.`);
}
