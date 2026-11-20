import test from "node:test";
import assert from "node:assert/strict";
import { fixture, settled } from "./helpers/preparation-service-fixture.js";

const proposal = { type: "REQUIREMENTS_PROPOSAL", summary: "첫 줄 변경",
  questions: [], items: [{ statement: "첫 줄을 BRIDGE_OK로 변경한다.", acceptanceCriteria: "나머지 바이트는 그대로다." }] };
const raw = "\n" + JSON.stringify(proposal, null, 2) + "\n";

function respond(t, f, rawText, { legacy = false, ...overrides } = {}) {
  const submit = f.web.submitTurn.bind(f.web);
  t.mock.method(f.web, "submitTurn", async input => {
    if (legacy) delete f.service.current.deliveries.at(-1).responseFormat;
    const result = await submit(input);
    return { completion: result.completion.then(response => ({ ...response, rawText, ...overrides })) };
  });
}

test("Preparation accepts a whole JSON proposal, records its format before dispatch and preserves its original bytes", async t => {
  const f = fixture(t);
  respond(t, f, raw);
  const reserved = await f.start();
  await settled(f.service);
  assert.equal(f.service.current.state, "AGREEMENT_READY");
  assert.equal(reserved.deliveries[0].responseFormat, "JSON_OBJECT_V1");
  assert.equal(f.service.current.deliveries[0].state, "ACKNOWLEDGED");
  f.restart();
  const snapshot = f.service.snapshot();
  assert.equal(snapshot.deliveries[0].responseFormat, "JSON_OBJECT_V1");
  assert.equal(snapshot.deliveries[0].response.rawText, raw);
  assert.deepEqual(snapshot.agreement.requirements, proposal.items);
});

test("a historical marker response reopens with its prior format and agreement", async t => {
  const f = fixture(t);
  const framed = "CONTROLLER_PACKET_BEGIN\n" + raw.trim() + "\nCONTROLLER_PACKET_END";
  respond(t, f, framed, { legacy: true });
  await f.start();
  await settled(f.service);
  f.restart();
  assert.equal(f.service.current.state, "AGREEMENT_READY");
  assert.equal(f.service.snapshot().deliveries[0].responseFormat, undefined);
  assert.equal(f.service.snapshot().deliveries[0].response.rawText, framed);
});

test("invalid JSON stays invalid after snapshot and restart even with plain text enabled", async t => {
  for (const [value, code] of [
    [raw.trim().slice(0, -1), "INVALID_PACKET_JSON"],
    [raw + raw, "INVALID_PACKET_JSON"],
    ["설명\n" + raw, "INVALID_PACKET_JSON"],
    ["\x60\x60\x60json\n" + raw + "\x60\x60\x60", "INVALID_PACKET_JSON"],
    ["type: REQUIREMENTS_PROPOSAL", "INVALID_PACKET_JSON"],
    ["undefined", "INVALID_PACKET_JSON"],
    ["null", "INVALID_REQUIREMENTS_PROPOSAL"],
    ["[" + raw + "]", "INVALID_REQUIREMENTS_PROPOSAL"],
    [JSON.stringify({ ...proposal, questions: [{ question: "어디?" }] }), "INVALID_REQUIREMENTS_PROPOSAL"],
  ]) {
    await t.test(code + " " + value.trim().slice(0, 12), async sub => {
      const f = fixture(sub);
      respond(sub, f, value, { evidence: { responseAssociation: "DIRECT_DOM_ORDER" } });
      const ack = sub.mock.method(f.web, "acknowledgeDelivery");
      await f.start({ acceptPlainTextDiscussion: true });
      await settled(f.service);
      f.restart();
      const state = f.service.snapshot();
      assert.equal(state.state, "RECOVERY_REQUIRED");
      assert.equal(state.deliveries[0].validation.formatError.code, code);
      assert.equal(state.deliveries[0].response.rawText, value);
      assert.equal(state.webSession.activeDeliveryId, state.deliveries[0].deliveryId);
      assert.equal(ack.mock.callCount(), 0);
    });
  }
});

test("a valid bare JSON proposal still requires message association for ACK", async t => {
  const f = fixture(t);
  respond(t, f, raw);
  f.observe({ lastObservedUserMessageId: "other-user" });
  const ack = t.mock.method(f.web, "acknowledgeDelivery");
  await f.start();
  await settled(f.service);
  assert.equal(f.service.current.deliveries[0].validation.status, "FAILED");
  assert.equal(f.service.current.state, "RECOVERY_REQUIRED");
  assert.equal(ack.mock.callCount(), 0);
});
