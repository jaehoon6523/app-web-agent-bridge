import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const domainRoot = path.join(root, "src", "domain");
const productionRoots = ["src", "public", "extension"].map((name) => path.join(root, name));
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

const fixtureReference = /tests[\\/]fixtures|fixtures[\\/]incidents|expected-ui\.txt|expected\.json/u;
for (const productionRoot of productionRoots) {
  for (const filename of walk(productionRoot)) {
    const relative = path.relative(root, filename);
    const source = fs.readFileSync(filename, "utf8");
    if (fixtureReference.test(source)) {
      failures.push(`${relative}: production code references a test oracle or incident fixture`);
    }
  }
}

// Tests and documentation cannot make a production module reachable. Include
// packaged browser scripts and standalone CLI commands as actual entry points.
const sources = [...productionRoots, path.join(root, "scripts")].flatMap(walk);
const sourceSet = new Set(sources);
const imports = new Map(sources.map((filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const targets = new Set();
  const references = /\b(?:from\s*|import\s*\(\s*|import\s*|new URL\s*\(\s*)["']([^"']+)["']/gu;
  for (const [, specifier] of source.matchAll(references)) {
    if (!specifier.startsWith(".")) continue;
    const resolved = path.resolve(path.dirname(filename), specifier);
    for (const candidate of [resolved, `${resolved}.js`, `${resolved}.mjs`, path.join(resolved, "index.js")]) {
      if (sourceSet.has(candidate)) { targets.add(candidate); break; }
    }
  }
  return [filename, targets];
}));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension", "manifest.json"), "utf8"));
const htmlScripts = (directory, filename) => [...fs.readFileSync(path.join(directory, filename), "utf8")
  .matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gu)]
  .map(([, source]) => path.join(directory, source));
const packageScripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts;
const operationalCommands = Object.entries(packageScripts)
  .filter(([name]) => ["start", "dev", "demo", "demo:win", "doctor", "certify", "projection:rebuild"].includes(name))
  .flatMap(([, command]) => [...command.matchAll(/\b(?:src|scripts)\/[\w./-]+\.(?:mjs|js)\b/gu)]
    .map(([filename]) => path.join(root, filename)));
const entryPoints = new Set([
  ...htmlScripts(path.join(root, "public"), "index.html"),
  path.join(root, "extension", manifest.background.service_worker),
  ...htmlScripts(path.join(root, "extension"), manifest.action.default_popup),
  ...operationalCommands,
  path.join(root, "scripts", "architecture-audit.mjs"),
  ...manifest.content_scripts.flatMap(({ js }) => js.map((filename) => path.join(root, "extension", filename))),
]);
const reachable = new Set(entryPoints);
const pending = [...entryPoints];
while (pending.length > 0) {
  for (const imported of imports.get(pending.pop()) ?? []) {
    if (!reachable.has(imported)) { reachable.add(imported); pending.push(imported); }
  }
}
for (const productionRoot of productionRoots) {
  for (const filename of walk(productionRoot)) {
    if (!reachable.has(filename)) {
      failures.push(`${path.relative(root, filename)}: no runtime, browser, or CLI entry point imports this module`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Architecture boundary PASS: layer imports, fixture isolation, and runtime reachability are valid.\n");
}
