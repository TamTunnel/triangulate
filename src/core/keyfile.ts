// SPDX-License-Identifier: Apache-2.0
// Passphrase-encrypted storage for the local signing key (assessment
// §9, decision (c)). The private key is stored as ciphertext —
// scrypt + AES-256-GCM, Node stdlib crypto only, portable to macOS
// and Linux. A stolen key.pem is ciphertext: it cannot sign anything
// without the passphrase, so the B6 key-theft channel (candidate code
// resolving the real home via the passwd DB and reading the key file)
// is dead by construction. It does NOT protect the operator's other
// credentials (~/.ssh, ~/.aws, API keys in the parent environ) —
// say that plainly wherever the encryption is described.
//
// Format (versioned so future KDF changes are detectable):
//   {"format":"triangulate-key/1","kdf":"scrypt","salt":b64,"iv":b64,
//    "tag":b64,"ciphertext":b64}
// The passphrase itself is a Buffer the caller zeroes after use;
// the derived key is zeroed inside these functions. The decrypted
// PEM is a JS string and cannot be zeroed — that is inherent, and
// the string never leaves the signing process.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

export const KEYFILE_FORMAT = "triangulate-key/1" as const;

export class KeyfileError extends Error {}

interface KeyEnvelope {
  format: typeof KEYFILE_FORMAT;
  kdf: "scrypt";
  /** base64, 16 bytes. */
  salt: string;
  /** base64, 12 bytes (GCM nonce). */
  iv: string;
  /** base64, 16 bytes (GCM auth tag). */
  tag: string;
  /** base64. */
  ciphertext: string;
}

// scrypt cost: N=16384, r=8, p=1 (Node defaults). maxmem is raised
// above the 32 MiB default so the derivation cannot fail spuriously
// on a constrained machine.
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

/** True when the stored content is an encrypted-key envelope. */
export function isEncryptedKeyFile(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as Partial<KeyEnvelope>;
    return parsed.format === KEYFILE_FORMAT;
  } catch {
    return false;
  }
}

/** Encrypt a PKCS#8 PEM under the passphrase. Returns the envelope JSON. */
export function encryptPrivateKey(pem: string, passphrase: Buffer): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, SCRYPT_OPTIONS);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(pem, "utf8"), cipher.final()]);
    const envelope: KeyEnvelope = {
      format: KEYFILE_FORMAT,
      kdf: "scrypt",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    return `${JSON.stringify(envelope, null, 2)}\n`;
  } finally {
    key.fill(0);
  }
}

/**
 * Decrypt an envelope back to a PKCS#8 PEM. Throws KeyfileError with
 * message "wrong passphrase" when the GCM auth tag does not verify
 * (wrong passphrase, or a tampered file) — never a raw crypto stack.
 */
export function decryptPrivateKey(content: string, passphrase: Buffer): string {
  let envelope: KeyEnvelope;
  try {
    envelope = JSON.parse(content) as KeyEnvelope;
  } catch {
    throw new KeyfileError("key file is not a valid encrypted key");
  }
  if (envelope.format !== KEYFILE_FORMAT || envelope.kdf !== "scrypt") {
    throw new KeyfileError("key file format is not supported");
  }
  const salt = Buffer.from(envelope.salt ?? "", "base64");
  const iv = Buffer.from(envelope.iv ?? "", "base64");
  const tag = Buffer.from(envelope.tag ?? "", "base64");
  const ciphertext = Buffer.from(envelope.ciphertext ?? "", "base64");
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new KeyfileError("key file is malformed");
  }
  const key = scryptSync(passphrase, salt, 32, SCRYPT_OPTIONS);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const pem = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    if (!pem.startsWith("-----BEGIN PRIVATE KEY-----")) {
      throw new KeyfileError("key file is malformed");
    }
    return pem;
  } catch (error) {
    if (error instanceof KeyfileError) throw error;
    throw new KeyfileError("wrong passphrase");
  } finally {
    key.fill(0);
  }
}
