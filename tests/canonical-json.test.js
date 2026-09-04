import assert from "node:assert/strict";
import test from "node:test";
import {
  CanonicalJsonError,
  canonicalJson,
  canonicalStringify,
  sha256CanonicalJson,
  sha256Text,
} from "../src/domain/canonical-json.js";

test("canonical JSON recursively sorts object keys and preserves array order", () => {
  const first = {
    z: 1,
    nested: { d: 4, c: 3 },
    list: [{ b: 2, a: 1 }, "x"],
    a: true,
  };
  const second = {
    a: true,
    list: [{ a: 1, b: 2 }, "x"],
    nested: { c: 3, d: 4 },
    z: 1,
  };

  const expected = '{"a":true,"list":[{"a":1,"b":2},"x"],"nested":{"c":3,"d":4},"z":1}';
  assert.equal(canonicalJson(first), expected);
  assert.equal(canonicalStringify(second), expected);
  assert.equal(sha256CanonicalJson(first), sha256CanonicalJson(second));
});

test("text and canonical JSON hashes use explicit sha256-prefixed UTF-8 digests", () => {
  assert.equal(
    sha256Text("abc"),
    "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(sha256CanonicalJson({ a: 1 }), sha256Text('{"a":1}'));
  assert.notEqual(sha256Text('{ "a": 1 }'), sha256CanonicalJson({ a: 1 }));
});

test("canonical JSON rejects values that cannot have one strict JSON representation", () => {
  assert.throws(() => canonicalJson(undefined), CanonicalJsonError);
  assert.throws(() => canonicalJson(Number.NaN), /numbers must be finite/);
  assert.throws(() => canonicalJson(new Date()), /only plain objects/);

  const sparse = [];
  sparse.length = 1;
  assert.throws(() => canonicalJson(sparse), /sparse arrays/);

  const namedArray = [1];
  namedArray.label = "not JSON array data";
  assert.throws(() => canonicalJson(namedArray), /named property/);

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), /cyclic values/);
});

test("canonical JSON permits repeated non-cyclic references", () => {
  const shared = { b: 2, a: 1 };
  assert.equal(
    canonicalJson({ right: shared, left: shared }),
    '{"left":{"a":1,"b":2},"right":{"a":1,"b":2}}',
  );
});
