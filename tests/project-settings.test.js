import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createBridgeServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { project } from "./helpers/audit-fixtures.js";

test("legacy project mutations authenticate and reject approval bypass without changing files", async (t) => {
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
  assert.equal(preparedResponse.status, 410);
  assert.equal(fs.existsSync(path.join(automatic, ".git")), false);
  assert.equal((await fetch(`${base}/api/project/folder`, { method: "POST", headers: { "content-type": "application/json", origin: config.baseUrl }, body: "{}" })).status, 401);
  const candidate = project(target);
  assert.equal((await save(candidate, initial.version, { "content-type": "application/json", origin: config.baseUrl })).status, 401);
  assert.equal((await save(candidate, initial.version, { ...headers, origin: "http://untrusted.invalid" })).status, 403);
  assert.equal((await save(candidate, initial.version)).status, 410);
  assert.deepEqual(await get(), initial);
  await bridge.close(); bridge = createBridgeServer({ runtimeConfig: config }); await listen();
  assert.deepEqual(await get(), initial);
});
