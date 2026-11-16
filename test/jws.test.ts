// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { canonicalize } from "../src/core/jcs.js";
import {
  base64urlEncode,
  fingerprint,
  generateKeypair,
  keypairFromPem,
  signJws,
  verifyJws,
} from "../src/core/jws.js";

test("JWS: sign and verify round-trips", () => {
  const kp = generateKeypair();
  const jws = signJws({ keypair: kp, payload: { a: 1, b: [2, 3] } });
  const result = verifyJws(jws, kp.publicKey);
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, { a: 1, b: [2, 3] });
});

test("JWS: kid is the fingerprint of the public key", () => {
  const kp = generateKeypair();
  assert.equal(kp.kid, fingerprint(kp.publicKey));
  assert.equal(kp.publicKey.x.length, 43); // 32 bytes base64url, no padding
});

test("JWS: tampering with the payload fails verification (S-3)", () => {
  const kp = generateKeypair();
  const jws = signJws({ keypair: kp, payload: { a: 1 } });
  const parts = jws.split(".");
  const [headerB64, payloadB64, sigB64] = parts;
  assert.ok(headerB64 !== undefined && payloadB64 !== undefined && sigB64 !== undefined);
  // Flip one character in the payload segment.
  const tamperedPayload = `${payloadB64.slice(0, -1)}${payloadB64.endsWith("A") ? "B" : "A"}`;
  const tampered = `${headerB64}.${tamperedPayload}.${sigB64}`;
  const result = verifyJws(tampered, kp.publicKey);
  assert.equal(result.ok, false);
});

test("JWS: a different key fails verification (S-3)", () => {
  const kp1 = generateKeypair();
  const kp2 = generateKeypair();
  const jws = signJws({ keypair: kp1, payload: { a: 1 } });
  const result = verifyJws(jws, kp2.publicKey);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "kid-mismatch");
});

test("JWS: keypair survives a PEM round-trip", () => {
  const kp = generateKeypair();
  const restored = keypairFromPem(kp.privateKeyPem);
  assert.equal(restored.kid, kp.kid);
  assert.equal(restored.publicKey.x, kp.publicKey.x);
  const jws = signJws({ keypair: restored, payload: { v: "ok" } });
  assert.equal(verifyJws(jws, kp.publicKey).ok, true);
});

test("JWS: malformed inputs fail closed", () => {
  const kp = generateKeypair();
  assert.equal(verifyJws("not-a-jws", kp.publicKey).ok, false);
  assert.equal(verifyJws("a.b", kp.publicKey).ok, false);
  assert.equal(verifyJws("a.b.c.d", kp.publicKey).ok, false);
});

test("JWS: a header without the verdict typ fails verification (N5)", () => {
  const kp = generateKeypair();
  // Mint a JWS by hand with the right alg/kid/signature but no typ:
  // it must not verify as a verdict JWS.
  const header = { alg: "Ed25519", kid: kp.kid };
  const payload = { a: 1 };
  const headerB64 = base64urlEncode(canonicalize(header));
  const payloadB64 = base64urlEncode(canonicalize(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = sign(null, Buffer.from(signingInput, "utf8"), kp.privateKeyPem);
  const jws = `${signingInput}.${base64urlEncode(sig)}`;
  const result = verifyJws(jws, kp.publicKey);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "malformed-header");
});
