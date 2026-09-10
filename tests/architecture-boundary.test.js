import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const domainRoot = path.join(root, "src", "domain");

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(filename);
    return entry.isFile() && filename.endsWith(".js") ? [filename] : [];
  });
}

test("domain layer does not import application or infrastructure modules", () => {
  const violations = [];
  const rules = [
    /from\s+["'](?:\.\.\/)+(?:runtime|persistence|orchestration|repository|security)\//u,
    /from\s+["']node:(?:fs|child_process|net|http|https|sqlite)/u,
    /from\s+["'](?:express|ws|dotenv|better-sqlite3)["']/u,
  ];

  for (const filename of walk(domainRoot)) {
    const source = fs.readFileSync(filename, "utf8");
    for (const rule of rules) {
      if (rule.test(source)) violations.push(path.relative(root, filename));
    }
  }

  assert.deepEqual([...new Set(violations)], []);
});
