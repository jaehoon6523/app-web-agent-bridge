import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseFinalControllerPacketJsonEnvelope } from "../src/domain/controller-packet-envelope.js";
import { PreparationService } from "../src/orchestration/preparation-service.js";
import { extensionBrowser } from "../tests/helpers/extension-browser.mjs";

const INCIDENT_ROOT = new URL("../tests/fixtures/incidents/preparation-packet-20260915/", import.meta.url);
const CRITICAL_PIPELINE = Object.freeze([
  "DOM",
  "CONTENT",
  "BACKGROUND",
  "ADAPTER",
  "PREPARATION",
  "PERSISTENCE",
  "UI",
]);

function readIncident(name) {
  return fs.readFileSync(new URL(name, INCIDENT_ROOT), "utf8");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

async function settle(service, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (service.jobs.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(service.jobs.size, 0, "PreparationService did not settle before the critical-path deadline.");
}

async function runFullPath(t, { rawText, objective, providerHtml = null, expectedUi = [] }) {
  const observed = new Set();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-critical-preparation-"));
  const database = path.join(root, "preparation.sqlite");
  const browser = await extensionBrowser(t, { providerHtml, reply: () => rawText });
  const options = {
    filename: database,
    web: browser.adapter,
    available: () => true,
    assertStart: async () => {},
    approve: async () => { throw new Error("The critical path must not approve automatically."); },
    findRun: async () => null,
  };
  let service = new PreparationService(options);
  let serviceClosed = false;
  t.after(() => {
    if (!serviceClosed) service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await service.execute("preparation.start", {
    requestId: `critical-${crypto.randomUUID()}`,
    objective,
    targetRoot: root,
    conversationUrl: "https://chatgpt.com/",
  });
  await settle(service);

  const dispatchedPrompt = browser.commands.find((message) => message.type === "agent.prompt")?.payload?.text;
  assert.match(dispatchedPrompt, /JSON\.parse/u);
  assert.match(dispatchedPrompt, /Windows 경로는 C:\/path/u);
  assert.match(dispatchedPrompt, /역슬래시.*\\\\/u);
  assert.match(dispatchedPrompt, /Markdown escape나 코드 fence/u);
  assert.ok(dispatchedPrompt.includes(objective));
  assert.ok(dispatchedPrompt.includes(`프로젝트 루트=${root}`));
  assert.match(dispatchedPrompt, /기존 준비 문맥:\n\{"preparationId"/u);

  const domText = await browser.page.locator("[data-message-author-role='assistant'] [data-message-content]").innerText();
  assert.equal(domText, rawText);
  observed.add("DOM");

  const contentResult = browser.contentResults.find((entry) => entry.request.type === "agent.prompt")?.result;
  assert.equal(contentResult?.ok, true);
  assert.equal(contentResult?.text, rawText);
  observed.add("CONTENT");

  const backgroundFrame = browser.frames.find((frame) => frame.type === "web.prompt.result");
  assert.equal(backgroundFrame?.payload?.text, rawText);
  observed.add("BACKGROUND");

  const context = service.snapshot();
  const delivery = context.deliveries.at(-1);
  const promptCommands = browser.commands.filter((entry) => entry.type === "agent.prompt");
  const promptFrames = browser.frames.filter((entry) => entry.type === "web.prompt.result");
  const promptResults = browser.contentResults.filter((entry) => entry.request.type === "agent.prompt");
  assert.equal(promptCommands.length, 1, "one preparation may click send only once");
  assert.equal(promptFrames.length, 1, "one completed delivery must produce one response frame");
  assert.equal(promptResults.length, 1);
  assert.equal(promptCommands[0].requestId, delivery.deliveryId);
  assert.equal(promptResults[0].request.requestId, delivery.deliveryId);
  assert.equal(promptFrames[0].requestId, delivery.deliveryId);
  assert.equal(promptFrames[0].payload.session.sessionId, context.webSession.sessionId);
  assert.equal(promptFrames[0].payload.session.runId, context.preparationId);
  assert.equal(promptFrames[0].payload.trace.requestId, delivery.deliveryId);
  assert.equal(await browser.page.locator("[data-message-author-role='user']").count(), 1,
    "the provider fixture must contain exactly one submitted prompt");
  assert.equal(delivery.response.rawText, rawText);
  assert.equal(delivery.response.packet.type, "REQUIREMENTS_PROPOSAL");
  observed.add("ADAPTER");

  assert.equal(context.agreement.status, "READY");
  assert.equal(context.state, "AGREEMENT_READY");
  assert.equal(context.agreement.summary, delivery.response.packet.summary);
  assert.equal(context.agreement.requirements.length, delivery.response.packet.items.length);
  observed.add("PREPARATION");

  service.close();
  serviceClosed = true;
  service = new PreparationService(options);
  serviceClosed = false;
  const restored = service.snapshot();
  assert.equal(restored.deliveries.at(-1).response.rawText, rawText);
  assert.deepEqual(restored.agreement, context.agreement);
  assert.equal(restored.deliveries.at(-1).deliveryId, delivery.deliveryId);
  assert.equal(browser.commands.filter((entry) => entry.type === "agent.prompt").length, 1,
    "restoring the saved response must not resend the prompt");
  observed.add("PERSISTENCE");

  const projection = await service.project({
    run: null,
    runs: [],
    sessions: [],
    messages: [],
    deliveries: [],
    approvals: [],
    events: [],
    outcome: null,
    commandCapabilities: [],
    preflight: { checks: { extensionAuthenticated: true } },
  });
  const dashboard = await browser.openDashboard(projection);
  await dashboard.locator("#requirementsFold").evaluate((element) => { element.open = true; });
  await dashboard.locator("#preparationDiagnostics").evaluate((element) => { element.open = true; });
  await dashboard.locator(".session-recovery").evaluate((element) => { element.open = true; });
  const rendered = await dashboard.locator("body").innerText();
  assert.match(rendered, new RegExp(context.agreement.summary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const line of expectedUi) assert.ok(rendered.includes(line), `Dashboard did not render: ${line}`);
  const rawBlocks = await dashboard.locator(".session-recovery pre").allTextContents();
  assert.ok(rawBlocks.includes(rawText), "Dashboard did not preserve the exact raw response.");
  observed.add("UI");

  assert.deepEqual([...observed], CRITICAL_PIPELINE);
  assert.deepEqual(browser.errors, []);
  return { context, delivery, rendered };
}

test("incident 20260915 crosses every production preparation boundary without changing raw bytes", { timeout: 45_000 }, async (t) => {
  const rawText = readIncident("raw-response.txt").trimEnd();
  const providerHtml = readIncident("chatgpt-response.html");
  const expected = JSON.parse(readIncident("expected.json"));
  const expectedUi = readIncident("expected-ui.txt").trim().split(/\r?\n/u);

  assert.equal(sha256(rawText), expected.rawSha256);
  const result = await runFullPath(t, { rawText, objective: "시계 앱", providerHtml, expectedUi });
  assert.equal(result.delivery.response.packet.type, expected.packetType);
  assert.equal(result.context.agreement.status, expected.agreementStatus);
  assert.equal(result.context.state, expected.contextState);
  assert.equal(result.context.agreement.requirements.length, expected.requirementsCount);
  assert.ok(result.context.agreement.summary.includes(expected.summaryIncludes));
});

const baseRaw = readIncident("raw-response.txt").trimEnd();
const basePacket = parseFinalControllerPacketJsonEnvelope(baseRaw).parsed;
const metamorphicCases = [
  { name: "calculator-seven", app: "계산기 앱", sourcePath: "C:/Users/User/Desktop/pj", targetPath: "D:/workspace/foo", count: 7 },
  { name: "memo-thirteen", app: "메모 앱", sourcePath: "C:/Users/User/Desktop/pj", targetPath: "E:/projects/memo", count: 13 },
];

for (const variant of process.env.CRITICAL_GOLDEN_ONLY === "1" ? [] : metamorphicCases) {
  test(`metamorphic preparation path preserves ${variant.name}`, { timeout: 45_000 }, async (t) => {
    const items = Array.from({ length: variant.count }, (_, index) => {
      const source = basePacket.items[index % basePacket.items.length];
      return {
        statement: `${variant.app} 요구사항 ${index + 1}: ${source.statement}`,
        acceptanceCriteria: `${variant.targetPath} 변형 ${index + 1}: ${source.acceptanceCriteria}`,
      };
    });
    const packet = {
      ...basePacket,
      summary: basePacket.summary
        .replaceAll("시계 앱", variant.app)
        .replaceAll(variant.sourcePath, variant.targetPath),
      items,
    };
    const rawText = `<controller_packet>\n${JSON.stringify(packet)}\n</controller_packet>`;
    const result = await runFullPath(t, {
      rawText,
      objective: variant.app,
      expectedUi: [variant.app, items[0].statement, "요구사항 합의 완료"],
    });
    assert.equal(result.context.agreement.summary, packet.summary);
    assert.equal(result.context.agreement.requirements.length, variant.count);
    assert.deepEqual(result.context.agreement.requirements, items);
  });
}

if (process.env.CRITICAL_GOLDEN_ONLY !== "1") test("Windows backslashes are repaired without changing raw response bytes", { timeout: 45_000 }, async (t) => {
  const invalidRaw = baseRaw.replaceAll("C:/Users/User/Desktop/pj", "C:\\Users\\User\\Desktop\\pj");
  const result = await runFullPath(t, {
    rawText: invalidRaw,
    objective: "시계 앱",
    expectedUi: ["시계 앱", "요구사항 합의 완료"],
  });
  assert.equal(result.delivery.response.rawText, invalidRaw);
  assert.equal(result.delivery.response.packet?.type, "REQUIREMENTS_PROPOSAL");
  assert.equal(result.delivery.validation.format, "CONFIRMED");
  assert.equal(result.context.state, "AGREEMENT_READY");
  assert.equal(result.context.agreement.status, "READY");
  assert.match(result.context.agreement.summary, /C:\\Users\\User\\Desktop\\pj/u);
});
