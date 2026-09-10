import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createBridgeServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { project } from "./helpers/audit-fixtures.js";

test("project settings authenticate, validate, persist, update readiness and reject stale or busy edits", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-project-settings-"));
  const target = path.join(root, "target"); fs.mkdirSync(target);
  const git = (...args) => execFileSync("git", ["-C", target, ...args], { stdio: "ignore", windowsHide: true });
  git("init"); git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial");
  const token = "project-settings-token-0123456789abcdef";
  const config = { ...loadConfig({ cwd: root, env: {
    DASHBOARD_TOKEN: token, WEB_EXTENSION_SHARED_SECRET: "project-settings-secret-0123456789abcdef",
    WEB_EXTENSION_EXPECTED_IDENTITY: "test-extension", CODEX_EXECUTABLE: process.execPath,
  } }), port: 0 };
  let bridge = createBridgeServer({ runtimeConfig: config });
  let base;
  async function listen() { const address = await bridge.listen(); base = `http://127.0.0.1:${address.port}`; }
  t.after(async () => { await bridge.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await listen();
  const headers = { authorization: `Bearer ${token}`, origin: config.baseUrl, "content-type": "application/json" };
  const get = async () => (await fetch(`${base}/api/project`, { headers })).json();
  const save = (value, version, override = headers) => fetch(`${base}/api/project`, {
    method: "PUT", headers: override, body: JSON.stringify({ project: value, expectedVersion: version }),
  });
  assert.equal((await fetch(`${base}/api/project`)).status, 401);
  const initial = await get(); assert.equal(initial.project, null);
  const automatic = path.join(root, "automatic"); fs.mkdirSync(automatic);
  fs.writeFileSync(path.join(automatic, "app.js"), "export const ready = true;\n");
  assert.equal((await fetch(`${base}/api/project/prepare`, { method: "POST", headers: { "content-type": "application/json", origin: config.baseUrl }, body: JSON.stringify({ targetRoot: automatic }) })).status, 401);
  assert.equal(fs.existsSync(path.join(automatic, ".git")), false);
  const preparedResponse = await fetch(`${base}/api/project/prepare`, { method: "POST", headers, body: JSON.stringify({ targetRoot: automatic }) });
  assert.equal(preparedResponse.status, 200, await preparedResponse.clone().text());
  assert.equal((await preparedResponse.json()).createdInitialCommit, true);
  assert.equal((await fetch(`${base}/api/project/folder`, { method: "POST", headers: { "content-type": "application/json", origin: config.baseUrl }, body: "{}" })).status, 401);
  const candidate = project(target);
  assert.equal((await save(candidate, initial.version, { "content-type": "application/json", origin: config.baseUrl })).status, 401);
  assert.equal((await save(candidate, initial.version, { ...headers, origin: "http://untrusted.invalid" })).status, 403);
  const invalid = { ...candidate, targetRoot: root };
  assert.equal((await save(invalid, initial.version)).status, 400);
  assert.equal((await get()).version, initial.version);
  const response = await save(candidate, initial.version); assert.equal(response.status, 200, await response.clone().text());
  const saved = await response.json();
  const live = await bridge.getLiveRuntime();
  assert.deepEqual(live.codeChanges.project, saved.project);
  const preflight = await (await fetch(`${base}/api/preflight`)).json();
  assert.equal(preflight.checks.auditProjectConfigured, true);
  assert.equal((await save(candidate, initial.version)).status, 409);
  const changed = structuredClone(candidate); changed.requirements.items[0].statement = "Changed requirement";
  assert.equal((await save(changed, saved.version)).status, 400);
  changed.requirements.revision = "2";
  live.codeChanges.jobs.set("test-busy", Promise.resolve());
  assert.equal((await save(changed, saved.version)).status, 409);
  live.codeChanges.jobs.delete("test-busy");
  assert.equal((await save(changed, saved.version)).status, 200);
  await bridge.close(); bridge = createBridgeServer({ runtimeConfig: config }); await listen();
  assert.equal((await get()).project.requirements.revision, "2");
  assert.equal((await (await fetch(`${base}/api/preflight`)).json()).checks.auditProjectConfigured, true);
});
