// SPDX-License-Identifier: Apache-2.0
// Local signing key. A keypair is generated on first run and stored in
// ~/.triangulate/ (private key 0600, never leaves the machine). The public
// key is embedded in every verdict, so anyone can verify offline. There
// is no central registry and no revocation in v1 — state that plainly
// in the README.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateKeypair, keypairFromPem } from "./jws.js";
import type { Keypair } from "./jws.js";

export function defaultKeyDir(): string {
  return process.env["TRIANGULATE_HOME"] ?? join(homedir(), ".triangulate");
}

const PRIVATE_NAME = "key.pem";
const PUBLIC_NAME = "key.pub.json";

/**
 * Load the local keypair, generating and storing one on first use.
 * Only a missing private-key file triggers generation. A corrupt
 * stored key, or a public file that does not match the private key,
 * throws — silently replacing the key would orphan every verdict the
 * old key signed.
 */
export async function getOrCreateKeypair(dir: string = defaultKeyDir()): Promise<Keypair> {
  await mkdir(dir, { recursive: true });
  const privPath = join(dir, PRIVATE_NAME);
  const pubPath = join(dir, PUBLIC_NAME);
  let pem: string;
  try {
    pem = await readFile(privPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    const keypair = generateKeypair();
    await writeFile(privPath, keypair.privateKeyPem, { mode: 0o600 });
    await writeFile(
      pubPath,
      `${JSON.stringify({ ...keypair.publicKey, kid: keypair.kid }, null, 2)}\n`,
      { mode: 0o644 },
    );
    return keypair;
  }
  const keypair = keypairFromPem(pem);
  // Cross-check the stored public key matches the private key.
  let storedPub: { x?: unknown; kid?: unknown } | null = null;
  try {
    storedPub = JSON.parse(await readFile(pubPath, "utf8")) as { x?: unknown; kid?: unknown };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && code !== "ENOENT") throw error;
    // Missing public file: rewrite it from the private key.
    await writeFile(
      pubPath,
      `${JSON.stringify({ ...keypair.publicKey, kid: keypair.kid }, null, 2)}\n`,
      { mode: 0o644 },
    );
  }
  if (storedPub !== null) {
    if (storedPub["x"] !== keypair.publicKey.x || storedPub["kid"] !== keypair.kid) {
      throw new Error("stored public key does not match the private key");
    }
  }
  return keypair;
}
