import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createBridgeServer } from "../src/server.js";
import { computeWebChallengeHmac } from "../src/runtime/web/auth.js";
import { removeOwnedFixture } from "../scripts/e2e/helpers/owned-fixture.mjs";

test("only an authenticated extension can persist private decision bytes through the server listener", {timeout:15_000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"decision-evidence-server-"));
  const secret = "decision-evidence-test-only-secret-012345";
  const bridge = createBridgeServer({runtimeConfig:{
    host:"127.0.0.1",port:0,baseUrl:"http://127.0.0.1:0",workspace:root,demoMode:false,
    persistence:{databasePath:path.join(root,"controller.sqlite")},
    codex:{executablePath:process.execPath},dashboard:{token:"decision-evidence-test-dashboard-token"},
    webExtension:{enabled:true,sharedSecret:secret,expectedExtensionIdentity:"fixture-extension"},
    relay:{webResponseTimeoutMs:1000},
  }});
  const {port} = await bridge.listen();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/extension`);
  t.after(async () => { socket.terminate(); await bridge.close(); await removeOwnedFixture(root); });
  const receive = async () => JSON.parse(String((await once(socket,"message",{signal:AbortSignal.timeout(5000)}))[0]));
  const send = message => socket.send(JSON.stringify({...message,protocolVersion:2}));
  const challenge = await receive();
  const captureId = randomUUID();
  const pageHtml = '<html><body data-private="fixture-only">한글</body></html>';
  const extracted = "한글\n";
  const record = {captureId,deliveryId:"fixture-delivery",phase:"COMPLETED",documentId:"fixture-document",
    pageHtml,assistantHtml:"<p>한글</p>",bodyHtml:[],extracted};
  const frame = {type:"extension.decision-evidence",requestId:captureId,
    payload:{index:0,final:true,chunk:JSON.stringify(record)}};
  send(frame);
  const acceptance = receive();
  send({type:"extension.auth.response",challengeId:challenge.challengeId,extensionIdentity:"fixture-extension",
    hmacSha256:computeWebChallengeHmac(challenge.nonce,secret)});
  assert.equal((await acceptance).type,"controller.auth.accepted");
  const evidenceRoot = path.join(root,".agent-controller");
  assert.equal(fs.existsSync(evidenceRoot),false);
  const persisted = receive();
  send(frame);
  const receipt = (await persisted).payload;
  assert.equal(receipt.status,"PERSISTED");
  assert.equal(receipt.captureId,captureId);
  assert.doesNotMatch(JSON.stringify(receipt),/fixture-only|한글/u);
  assert.equal(receipt.page.sha256,createHash("sha256").update(pageHtml).digest("hex"));
  assert.equal(receipt.response.utf8Bytes,Buffer.byteLength(extracted));
  const directory = path.join(evidenceRoot,receipt.relativePath);
  assert.equal(fs.readFileSync(path.join(directory,"page-raw.html"),"utf8"),pageHtml);
  assert.equal(fs.readFileSync(path.join(directory,"response-extracted.txt"),"utf8"),extracted);
  assert.ok(fs.existsSync(path.join(directory,"manifest.sha256")));
});
