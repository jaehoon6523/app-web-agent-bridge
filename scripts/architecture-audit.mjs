import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = path.join(ROOT, ".agent-controller", "architecture-audit");
const SOURCE_ROOTS = ["src", "extension", "public", "tests"];
const PROD_ROOTS = new Set(["src", "extension", "public"]);
const EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts"]);

const invariantRules = [
  {
    id: "run-version",
    patterns: [/expectedRunVersion/u, /RUN_VERSION_CONFLICT/u, /expectedVersion/u],
  },
  {
    id: "session-binding",
    patterns: [/AGENT_SESSION_BINDING_CHANGED/u, /externalSessionId/u, /sessionBinding/u],
  },
  {
    id: "delivery-state",
    patterns: [/DeliveryState/u, /expectedDeliveryVersion/u, /DELIVERY_[A-Z_]+/u],
  },
  {
    id: "turn-attribution",
    patterns: [/activeTurnId/u, /AGENT_SESSION_TURN_MISMATCH/u, /externalTurnId/u],
  },
  {
    id: "terminal-response",
    patterns: [
      /AGENT_RESPONSE_ALREADY_STORED/u,
      /getAgentMessageByInput/u,
      /getAgentPacketRejectionByDelivery/u,
    ],
  },
  {
    id: "single-pending-delivery",
    patterns: [/MULTIPLE_PENDING_DISCUSSION_DELIVERIES/u, /listDispatchableDeliveries/u],
  },
];

function slash(value) {
  return value.split(path.sep).join("/");
}

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".git", ".agent-controller"].includes(entry.name)) return [];
      return walk(filename);
    }
    if (!entry.isFile() || !EXTENSIONS.has(path.extname(entry.name))) return [];
    return [filename];
  });
}

function relative(filename) {
  return slash(path.relative(ROOT, filename));
}

function rootOf(file) {
  return file.split("/")[0];
}

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

function lineCount(text) {
  if (text.length === 0) return 0;
  return text.split(/\r?\n/u).length;
}

function parseImports(source) {
  const values = new Set();
  const expressions = [
    /\bfrom\s+["']([^"']+)["']/gu,
    /\bimport\s+["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const expression of expressions) {
    let match;
    while ((match = expression.exec(source)) !== null) values.add(match[1]);
  }
  return [...values];
}

function resolveRelativeImport(fromFile, specifier, knownFiles) {
  if (!specifier.startsWith(".")) return null;
  const base = slash(path.normalize(path.join(path.dirname(fromFile), specifier)));
  const candidates = [
    base,
    ...[...EXTENSIONS].map((ext) => `${base}${ext}`),
    ...[...EXTENSIONS].map((ext) => `${base}/index${ext}`),
  ];
  return candidates.find((candidate) => knownFiles.has(candidate)) ?? null;
}

function exportedSymbolCount(source) {
  const matches = source.match(
    /\bexport\s+(?:default\s+)?(?:async\s+)?(?:class|function|const|let|var)\s+[A-Za-z_$][\w$]*/gu,
  );
  return matches?.length ?? 0;
}

function functionCount(source) {
  const named = source.match(/\b(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/gu)?.length ?? 0;
  const methods = source.match(/^\s{2,}(?:async\s+)?[#A-Za-z_$][\w$#]*\s*\([^)]*\)\s*\{/gmu)?.length ?? 0;
  const arrows = source.match(/\b(?:const|let)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/gu)?.length ?? 0;
  return named + methods + arrows;
}

function branchCount(source) {
  return (
    (source.match(/\bif\s*\(/gu)?.length ?? 0)
    + (source.match(/\belse\b/gu)?.length ?? 0)
    + (source.match(/\bswitch\s*\(/gu)?.length ?? 0)
    + (source.match(/\bcase\b/gu)?.length ?? 0)
    + (source.match(/\bcatch\s*\(/gu)?.length ?? 0)
    + (source.match(/\?\s*[^:;\n]+\s*:/gu)?.length ?? 0)
  );
}

function invariantHits(source) {
  return invariantRules
    .filter((rule) => rule.patterns.some((pattern) => pattern.test(source)))
    .map((rule) => rule.id);
}

function normalizeAssertion(text) {
  return text
    .replace(/["'`][^"'`\n]*["'`]/gu, "<str>")
    .replace(/\b\d+(?:\.\d+)?\b/gu, "<num>")
    .replace(/\s+/gu, " ")
    .trim();
}

function assertionFingerprints(source) {
  const lines = source.split(/\r?\n/u);
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!/\bassert(?:\.|\()/u.test(line)) continue;
    const normalized = normalizeAssertion(line);
    if (normalized.length < 12) continue;
    found.push({ line: i + 1, normalized });
  }
  return found;
}

function tarjan(nodes, edges) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const low = new Map();
  const components = [];

  function visit(node) {
    indices.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of edges.get(node) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        low.set(node, Math.min(low.get(node), low.get(target)));
      } else if (onStack.has(target)) {
        low.set(node, Math.min(low.get(node), indices.get(target)));
      }
    }

    if (low.get(node) === indices.get(node)) {
      const component = [];
      let current;
      do {
        current = stack.pop();
        onStack.delete(current);
        component.push(current);
      } while (current !== node);
      components.push(component);
    }
  }

  for (const node of nodes) {
    if (!indices.has(node)) visit(node);
  }
  return components;
}

const files = SOURCE_ROOTS
  .flatMap((root) => walk(path.join(ROOT, root)))
  .map(relative)
  .sort();

const knownFiles = new Set(files);
const metadata = new Map();
const edges = new Map();

for (const file of files) {
  const source = read(file);
  const imports = parseImports(source);
  const resolved = imports
    .map((specifier) => resolveRelativeImport(file, specifier, knownFiles))
    .filter(Boolean);

  edges.set(file, new Set(resolved));
  metadata.set(file, {
    file,
    root: rootOf(file),
    production: PROD_ROOTS.has(rootOf(file)),
    loc: lineCount(source),
    imports: imports.length,
    internalImports: resolved.length,
    exports: exportedSymbolCount(source),
    functions: functionCount(source),
    branches: branchCount(source),
    invariants: invariantHits(source),
  });
}

const importedBy = new Map(files.map((file) => [file, 0]));
for (const targets of edges.values()) {
  for (const target of targets) importedBy.set(target, (importedBy.get(target) ?? 0) + 1);
}

for (const item of metadata.values()) {
  item.importedBy = importedBy.get(item.file) ?? 0;
  item.hotspotScore = (
    item.loc / 100
    + item.branches * 0.8
    + item.functions * 0.6
    + item.internalImports * 0.5
    + item.importedBy * 0.7
  );
}

const productionFiles = files.filter((file) => metadata.get(file).production);
const productionEdges = new Map(
  productionFiles.map((file) => [
    file,
    new Set([...(edges.get(file) ?? [])].filter((target) => metadata.get(target)?.production)),
  ]),
);

const cycles = tarjan(productionFiles, productionEdges)
  .filter((component) => component.length > 1)
  .sort((a, b) => b.length - a.length);

const invariantLocations = Object.fromEntries(
  invariantRules.map((rule) => [
    rule.id,
    productionFiles.filter((file) => metadata.get(file).invariants.includes(rule.id)),
  ]),
);

const invariantDuplicates = Object.entries(invariantLocations)
  .filter(([, locations]) => locations.length > 2)
  .map(([id, locations]) => ({ id, count: locations.length, locations }));

const assertionMap = new Map();
for (const file of files.filter((entry) => entry.startsWith("tests/"))) {
  for (const fingerprint of assertionFingerprints(read(file))) {
    const list = assertionMap.get(fingerprint.normalized) ?? [];
    list.push({ file, line: fingerprint.line });
    assertionMap.set(fingerprint.normalized, list);
  }
}

const duplicateAssertions = [...assertionMap.entries()]
  .filter(([, occurrences]) => new Set(occurrences.map(({ file }) => file)).size > 1)
  .map(([fingerprint, occurrences]) => ({ fingerprint, occurrences }))
  .sort((a, b) => b.occurrences.length - a.occurrences.length);

const hotspots = productionFiles
  .map((file) => metadata.get(file))
  .sort((a, b) => b.hotspotScore - a.hotspotScore)
  .slice(0, 20);

const report = {
  generatedAt: new Date().toISOString(),
  fileCount: files.length,
  productionFileCount: productionFiles.length,
  cycles,
  hotspots,
  invariantLocations,
  invariantDuplicates,
  duplicateAssertions: duplicateAssertions.slice(0, 100),
  importGraph: Object.fromEntries(
    productionFiles.map((file) => [file, [...productionEdges.get(file)].sort()]),
  ),
};

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.writeFileSync(
  path.join(OUTPUT_DIR, "architecture-audit.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);

const dot = [
  "digraph architecture {",
  '  rankdir="LR";',
  ...productionFiles.flatMap((file) => {
    const targets = [...productionEdges.get(file)];
    if (targets.length === 0) return [`  "${file}";`];
    return targets.map((target) => `  "${file}" -> "${target}";`);
  }),
  "}",
  "",
].join("\n");
fs.writeFileSync(path.join(OUTPUT_DIR, "import-graph.dot"), dot);

const md = [];
md.push("# Architecture Audit");
md.push("");
md.push(`Generated: ${report.generatedAt}`);
md.push("");
md.push(`- scanned files: ${report.fileCount}`);
md.push(`- production files: ${report.productionFileCount}`);
md.push(`- import cycles: ${report.cycles.length}`);
md.push(`- invariant categories present in >2 production files: ${report.invariantDuplicates.length}`);
md.push(`- duplicate normalized assertions across test files: ${report.duplicateAssertions.length}`);
md.push("");
md.push("## Hotspots");
md.push("");
md.push("| file | LOC | branches | functions | internal imports | imported by | score |");
md.push("|---|---:|---:|---:|---:|---:|---:|");
for (const item of hotspots) {
  md.push(
    `| \`${item.file}\` | ${item.loc} | ${item.branches} | ${item.functions} | ${item.internalImports} | ${item.importedBy} | ${item.hotspotScore.toFixed(1)} |`,
  );
}
md.push("");
md.push("## Import cycles");
md.push("");
if (cycles.length === 0) {
  md.push("No multi-file import cycles found.");
} else {
  cycles.forEach((component, index) => {
    md.push(`${index + 1}. ${component.map((file) => `\`${file}\``).join(" → ")}`);
  });
}
md.push("");
md.push("## Invariant spread");
md.push("");
for (const [id, locations] of Object.entries(invariantLocations)) {
  md.push(`### ${id}`);
  md.push("");
  md.push(`Found in ${locations.length} production files.`);
  locations.forEach((file) => md.push(`- \`${file}\``));
  md.push("");
}
md.push("## Duplicate test assertions");
md.push("");
if (duplicateAssertions.length === 0) {
  md.push("No duplicate normalized single-line assertions found.");
} else {
  for (const entry of duplicateAssertions.slice(0, 40)) {
    md.push(`- \`${entry.fingerprint}\``);
    entry.occurrences.forEach(({ file, line }) => md.push(`  - \`${file}:${line}\``));
  }
}
md.push("");
md.push("## Interpretation");
md.push("");
md.push("- A hotspot is a review target, not an automatic split target.");
md.push("- An invariant appearing in many files is a consolidation candidate, not proof of a bug.");
md.push("- Assertion duplication is only a signal. Compare scenario intent before deleting tests.");
md.push("- Import cycles should be reviewed against the intended dependency direction.");
md.push("");

fs.writeFileSync(path.join(OUTPUT_DIR, "architecture-audit.md"), `${md.join("\n")}\n`);

process.stdout.write(
  `Architecture audit written to ${slash(path.relative(ROOT, OUTPUT_DIR))}\n`
  + `Hotspots: ${hotspots.length}, cycles: ${cycles.length}, invariant spreads: ${invariantDuplicates.length}, duplicate assertions: ${duplicateAssertions.length}\n`,
);
