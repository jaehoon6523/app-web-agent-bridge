import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sabotages = [
  {
    name: "content extraction returns an empty response",
    file: "extension/runtime/response-text.js",
    find: "function elementText(element, selectors, selectorTelemetry) {",
    replace: "function elementText(element, selectors, selectorTelemetry) {\n    return \"\";",
  },
  {
    name: "preparation bypasses the parsed controller packet",
    file: "src/orchestration/preparation-service.js",
    find: "parsed = envelope.parsed;",
    replace: "parsed = null;",
    all: true,
  },
  {
    name: "dashboard omits the agreed requirements",
    file: "public/app.js",
    find: "for (const item of agreement?.requirements ?? [])",
    replace: "for (const item of [])",
  },
];

function copyRepository(target) {
  fs.cpSync(root, target, {
    recursive: true,
    filter: (source) => ![".git", "node_modules", ".agent-controller"].includes(path.basename(source)),
  });
  const modules = path.join(root, "node_modules");
  assert.ok(fs.existsSync(modules), "node_modules is required to run the browser sabotage gate.");
  fs.symlinkSync(modules, path.join(target, "node_modules"), process.platform === "win32" ? "junction" : "dir");
}

function runCritical(cwd) {
  return spawnSync(process.execPath, ["scripts/preparation-critical-suite.mjs"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CRITICAL_GOLDEN_ONLY: "1" },
    timeout: 60_000,
  });
}

const baseline = runCritical(root);
assert.equal(
  baseline.status,
  0,
  `Sabotage baseline must be GREEN before mutations run.\n${baseline.stdout}\n${baseline.stderr}`,
);

for (const sabotage of sabotages) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-sabotage-"));
  const copy = path.join(parent, "repo");
  try {
    copyRepository(copy);
    const filename = path.join(copy, sabotage.file);
    const source = fs.readFileSync(filename, "utf8");
    const occurrences = source.split(sabotage.find).length - 1;
    assert.ok(occurrences > 0, `Sabotage anchor not found: ${sabotage.file}`);
    const changed = sabotage.all
      ? source.replaceAll(sabotage.find, sabotage.replace)
      : source.replace(sabotage.find, sabotage.replace);
    fs.writeFileSync(filename, changed);

    const result = runCritical(copy);
    assert.notEqual(result.status, 0, `Critical test stayed GREEN after sabotage: ${sabotage.name}`);
    process.stdout.write(`Sabotage detected: ${sabotage.name}\n`);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}
