import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = ["src", "extension", "public", "scripts", "tests"];
const sourceExtensions = new Set([".js", ".mjs"]);
const activeRoots = new Set(["src", "extension", "public"]);
const legacyLineLimits = Object.freeze({
  "extension/background.js": 1_058,
  "public/app.js": 1_379,
  "src/orchestration/code-change-service.js": 1_136,
  "src/runtime/web/session-adapter.js": 1_031,
});

const prohibitedActivePatterns = Object.freeze([
  { expression: /\bAPP_AGENT\b/u, label: "legacy APP_AGENT actor" },
  { expression: /(?<!CHATGPT_)\bWEB_AGENT\b/u, label: "legacy WEB_AGENT actor" },
  { expression: /\[\[DONE\]\]/u, label: "free-text completion sentinel" },
  { expression: /shell\s*:\s*true/u, label: "shell:true process launch" },
  { expression: /env\s*:\s*process\.env/u, label: "unfiltered child environment" },
]);

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) files.push(absolute);
  }
  return files;
}

const files = roots.flatMap((directory) => walk(path.join(root, directory))).sort();
const failures = [];

for (const filename of files) {
  const relative = path.relative(root, filename);
  const normalizedRelative = relative.split(path.sep).join("/");
  const source = fs.readFileSync(filename, "utf8");
  const lineCount = source === "" ? 0 : source.split(/\r?\n/u).length;
  const legacyLimit = legacyLineLimits[normalizedRelative];
  const lineLimit = legacyLimit ?? 1_000;
  if (lineCount > lineLimit) {
    const label = legacyLimit === undefined ? "1000" : `${legacyLimit} legacy ceiling`;
    failures.push(`${relative}: ${lineCount} lines exceeds ${label}`);
  }

  const topLevel = relative.split(path.sep)[0];
  if (activeRoots.has(topLevel)) {
    for (const rule of prohibitedActivePatterns) {
      if (rule.expression.test(source)) failures.push(`${relative}: contains ${rule.label}`);
    }
  }
}

if (files.length === 0) failures.push("No JavaScript source files were discovered.");

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Validated ${files.length} JavaScript files.\n`);
}
