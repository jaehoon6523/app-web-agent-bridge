import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = ["src", "extension", "public", "scripts", "tests"];
const sourceExtensions = new Set([".js", ".mjs"]);
const activeRoots = new Set(["src", "extension", "public"]);

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
  const source = fs.readFileSync(filename, "utf8");
  const lineCount = source === "" ? 0 : source.split(/\r?\n/u).length;
  if (lineCount > 1_000) failures.push(`${relative}: ${lineCount} lines exceeds 1000`);

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
