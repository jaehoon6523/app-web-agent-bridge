import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const domainRoot = path.join(root, "src", "domain");
const productionRoots = ["src", "public", "extension"].map((name) => path.join(root, name));

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

test("production code cannot read test or incident oracle files", () => {
  const violations = [];
  const fixtureReference = /tests[\\/]fixtures|fixtures[\\/]incidents|expected-ui\.txt|expected\.json/u;

  for (const productionRoot of productionRoots) {
    for (const filename of walk(productionRoot)) {
      if (fixtureReference.test(fs.readFileSync(filename, "utf8"))) {
        violations.push(path.relative(root, filename));
      }
    }
  }

  assert.deepEqual(violations, []);
});
