import test from "node:test";
import assert from "node:assert/strict";
import { createReconnectController } from "../extension/runtime/reconnect.js";

test("extension reconnect retries with a cap and stops after authentication", async () => {
  const timers = new Map();
  const delays = [];
  let nextId = 0;
  let attempts = 0;
  const reconnect = createReconnectController({
    connect: async () => { attempts++; throw new Error("server unavailable"); },
    connected: () => false,
    onError: () => {},
    setTimer: (callback, delay) => { delays.push(delay); timers.set(++nextId, callback); return nextId; },
    clearTimer: (id) => timers.delete(id),
  });
  reconnect.schedule(4403);
  assert.equal(timers.size, 0);
  reconnect.schedule(4001);
  reconnect.schedule(4001);
  assert.deepEqual(delays, [2_000]);
  for (let n = 0; n < 6; n++) {
    const [id, callback] = timers.entries().next().value;
    timers.delete(id);
    await callback();
  }
  assert.equal(attempts, 6);
  assert.deepEqual(delays, [2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  reconnect.accepted();
  assert.equal(timers.size, 0);
  reconnect.schedule(4001);
  assert.equal(delays.at(-1), 2_000);
  reconnect.cancel();
});
