import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const validId = /^plain_[0-9a-f-]{36}$/u;

export function plainRunDirectory(root, runId) {
  if (!validId.test(runId)) throw new TypeError("Invalid plain Run ID.");
  return path.join(root, `plain-worker-${runId}`);
}

export async function savePlainRun(root, run) {
  const directory = plainRunDirectory(root, run.runId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "run.json.tmp"), JSON.stringify(run));
  await rename(path.join(directory, "run.json.tmp"), path.join(directory, "run.json"));
}

async function readOptional(file) {
  try { return await readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function readDirectory(directory, expectedId) {
  const metadata = expectedId ? await readOptional(path.join(directory, "run.json")) : null;
  const run = metadata === null ? null : JSON.parse(metadata);
  if (run && run.runId !== expectedId) throw new Error("Plain Run record ID mismatch.");
  const file = path.join(directory, "transcript.jsonl");
  const journal = await lstat(file).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const transcript = journal?.isFile() ? await readOptional(file) : null;
  let turns;
  try { turns = transcript?.trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)) ?? []; }
  catch (error) { if (run) throw error; return null; }
  if (run) return { ...run, turns };
  const runId = turns[0]?.runId;
  if (typeof runId !== "string" || !validId.test(runId) || (expectedId && runId !== expectedId)
    || !turns.every(turn => turn?.runId === runId && ["WORKER", "JUDGE", "CRITIC"].includes(turn.role))) return null;
  return { runId, startedAt: null, status: "LEGACY", turns };
}

export async function readPlainRun(root, runId) {
  plainRunDirectory(root, runId);
  return (await listPlainRuns(root)).find(run => run.runId === runId) ?? null;
}

async function directories(root) {
  try { return (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

export async function listPlainRuns(root) {
  const runs = new Map();
  for (const name of (await directories(root)).filter(name => /^plain-(worker|role-loop)-/u.test(name)).sort()) {
    const directory = path.join(root, name);
    const expectedId = name.slice("plain-worker-".length);
    if (name.startsWith("plain-worker-") && validId.test(expectedId)) {
      const run = await readDirectory(directory, expectedId);
      if (run) runs.set(run.runId, run);
      continue;
    }
    const candidates = [directory, ...(await directories(directory)).filter(child => child.startsWith("plain-worker-"))
      .map(child => path.join(directory, child))];
    for (const candidate of candidates) {
      const run = await readDirectory(candidate, null);
      if (run && !runs.has(run.runId)) runs.set(run.runId, run);
    }
  }
  return [...runs.values()].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "")
    || a.runId.localeCompare(b.runId));
}
