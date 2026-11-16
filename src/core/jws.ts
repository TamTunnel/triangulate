// SPDX-License-Identifier: Apache-2.0
// Ed25519 JWS (compact serialization) over JCS-canonical payloads.
// Zero-dependency: Node's built-in crypto only. The `kid` is the
// fingerprint of the raw public key, so a verifier can check that the
// key in the verdict is the key that signed it (gate probe S-3).

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { canonicalize } from "./jcs.js";

export class JwsError extends Error {}

export interface Ed25519Jwk {
  kty: "OKP";
  crv: "Ed25519";
  /** Raw 32-byte public key, base64url. */
  x: string;
}

export interface Keypair {
  /** Fingerprint of the raw public key (base64url SHA-256). */
  kid: string;
  publicKey: Ed25519Jwk;
  /** PKCS#8 PEM. Never serialized into a verdict or a log. */
  privateKeyPem: string;
}

export function base64urlEncode(v: string | Buffer): string {
  return Buffer.from(v).toString("base64url");
}

export function base64urlDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

/** kid = base64url(SHA-256(raw public key bytes)). */
export function fingerprint(publicKey: Ed25519Jwk): string {
  const raw = base64urlDecode(publicKey.x);
  if (raw.length !== 32) {
    throw new JwsError("Ed25519 public key must be 32 bytes");
  }
  return createHash("sha256").update(raw).digest().toString("base64url");
}

function jwkFromKeyObject(keyObject: ReturnType<typeof createPublicKey>): Ed25519Jwk {
  const jwk = keyObject.export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new JwsError("key is not Ed25519");
  }
  return { kty: "OKP", crv: "Ed25519", x: jwk.x };
}

export function generateKeypair(): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = jwkFromKeyObject(publicKey);
  return {
    kid: fingerprint(pub),
    publicKey: pub,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** Build a Keypair from a PKCS#8 PEM private key. */
export function keypairFromPem(privateKeyPem: string): Keypair {
  const priv = createPrivateKey(privateKeyPem);
  const pub = jwkFromKeyObject(createPublicKey(priv));
  return { kid: fingerprint(pub), publicKey: pub, privateKeyPem };
}

/**
 * Sign a canonical payload. The JWS header is {"alg":"Ed25519",
 * "kid":<fingerprint>, "typ":"triangulate-verdict"}.
 */
export function signJws(args: { keypair: Keypair; payload: unknown }): string {
  const header = { alg: "Ed25519", kid: args.keypair.kid, typ: "triangulate-verdict" };
  const headerB64 = base64urlEncode(canonicalize(header));
  const payloadB64 = base64urlEncode(canonicalize(args.payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = sign(null, Buffer.from(signingInput, "utf8"), args.keypair.privateKeyPem);
  return `${signingInput}.${base64urlEncode(sig)}`;
}

export interface VerifyJwsResult {
  ok: boolean;
  /** Decoded payload when ok; undefined otherwise. */
  payload?: unknown;
  /** Machine-readable failure reason when !ok. */
  reason?: string;
}

/**
 * Verify a compact JWS against an embedded public key. Checks: well-formed
 * header, alg is Ed25519, kid equals the fingerprint of the given public
 * key, and the signature verifies over header.payload.
 */
export function verifyJws(jws: string, publicKey: Ed25519Jwk): VerifyJwsResult {
  const parts = jws.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed-jws" };
  const [headerB64, payloadB64, sigB64] = parts;
  if (headerB64 === undefined || payloadB64 === undefined || sigB64 === undefined) {
    return { ok: false, reason: "malformed-jws" };
  }
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(base64urlDecode(headerB64).toString("utf8")) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "malformed-header" };
  }
  if (header["alg"] !== "Ed25519" || typeof header["kid"] !== "string") {
    return { ok: false, reason: "malformed-header" };
  }
  let expectedKid: string;
  try {
    expectedKid = fingerprint(publicKey);
  } catch {
    return { ok: false, reason: "malformed-public-key" };
  }
  if (header["kid"] !== expectedKid) return { ok: false, reason: "kid-mismatch" };
  let payload: unknown;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString("utf8")) as unknown;
  } catch {
    return { ok: false, reason: "malformed-payload" };
  }
  let keyObject: ReturnType<typeof createPublicKey>;
  try {
    keyObject = createPublicKey({ key: publicKey as JsonWebKey, format: "jwk" });
  } catch {
    return { ok: false, reason: "malformed-public-key" };
  }
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = base64urlDecode(sigB64);
  const valid = verify(null, Buffer.from(signingInput, "utf8"), keyObject, sig);
  if (!valid) return { ok: false, reason: "bad-signature" };
  return { ok: true, payload };
}
