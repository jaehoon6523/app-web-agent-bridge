import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const domainRoot = path.join(root, "src", "domain");
const sourceExtensions = new Set([".js", ".mjs"]);

const prohibitedImports = Object.freeze([
  { expression: /from\s+["'](?:\.\.\/)+(?:runtime|persistence|orchestration|repository|security)\//u, label: "domain imports an application layer" },
  { expression: /from\s+["']node:(?:fs|child_process|net|http|https|sqlite)/u, label: "domain imports an infrastructure module" },
  { expression: /from\s+["'](?:express|ws|dotenv|better-sqlite3)["']/u, label: "domain imports an external package" },
]);

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(filename);
    return entry.isFile() && sourceExtensions.has(path.extname(entry.name)) ? [filename] : [];
  });
}

const failures = [];
for (const filename of walk(domainRoot)) {
  const relative = path.relative(root, filename);
  const source = fs.readFileSync(filename, "utf8");
  for (const rule of prohibitedImports) {
    if (rule.expression.test(source)) failures.push(`${relative}: ${rule.label}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Architecture boundary PASS: domain files have no prohibited infrastructure imports.\n`);
}
