// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { canonicalHash, canonicalize, CanonicalizationError } from "../src/core/jcs.js";

test("JCS: RFC 8785 example — key order is irrelevant", () => {
  const a = canonicalize({ b: 1, a: [2, 3], c: { d: "x" } });
  const b = canonicalize({ c: { d: "x" }, a: [2, 3], b: 1 });
  assert.equal(a, '{"a":[2,3],"b":1,"c":{"d":"x"}}');
  assert.equal(a, b);
});

test("JCS: numbers — -0 becomes 0, floats use ES serialization", () => {
  assert.equal(canonicalize({ a: -0 }), '{"a":0}');
  assert.equal(canonicalize({ a: 1e21 }), '{"a":1e+21}');
  assert.equal(canonicalize({ a: 0.1 }), '{"a":0.1}');
  assert.throws(() => canonicalize({ a: Number.NaN }), CanonicalizationError);
  assert.throws(() => canonicalize({ a: Number.POSITIVE_INFINITY }), CanonicalizationError);
});

test("JCS: string escapes", () => {
  assert.equal(canonicalize({ a: 'q"\\ \n\t' }), '{"a":"q\\"\\\\ \\n\\t"}');
  assert.equal(canonicalize({ a: "" }), '{"a":"\\u0001"}');
  assert.equal(canonicalize({ a: "é" }), '{"a":"é"}');
  assert.throws(() => canonicalize({ a: "\ud800" }), CanonicalizationError);
});

test("JCS: undefined values are dropped from objects, rejected in arrays", () => {
  assert.equal(canonicalize({ a: undefined, b: 1 }), '{"b":1}');
  assert.throws(() => canonicalize([undefined]), CanonicalizationError);
});

test("JCS: cyclic structures are rejected", () => {
  const obj: Record<string, unknown> = {};
  obj["self"] = obj;
  assert.throws(() => canonicalize(obj), CanonicalizationError);
});

test("JCS: hash is stable under key shuffling (D-4)", () => {
  const h1 = canonicalHash({ z: [3, { b: 1, a: 2 }], y: "s" });
  const h2 = canonicalHash({ y: "s", z: [3, { a: 2, b: 1 }] });
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);
});
