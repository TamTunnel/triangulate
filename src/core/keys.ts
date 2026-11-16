// SPDX-License-Identifier: Apache-2.0
// Local signing key. A keypair is generated on first run and stored in
// ~/.triangulate/ (private key 0600, never leaves the machine). The
// public key is embedded in every verdict, so anyone can verify
// offline. There is no central registry and no revocation in v1 —
// state that plainly in the README.
//
// The private key is passphrase-encrypted at rest (assessment §9,
// decision (c)): scrypt + AES-256-GCM, see ./keyfile.ts. A stolen
// key.pem is ciphertext — the B6 key-theft channel (candidate code
// resolving the real home via the passwd DB and reading the key file)
// is dead by construction. This does NOT protect the operator's other
// credentials (~/.ssh, ~/.aws, API keys in the parent environ); that
// residual is explicit in the assessment and the README.
//
// The passphrase is prompted once per signing run on the controlling
// terminal (echo off), held only in memory (Buffer, zeroed after
// use), never in the environment, never on disk, never logged.
// `tri verify` / `show` / `diff` need no passphrase (public key
// only). Non-interactive runs use TRIANGULATE_KEY_PASSPHRASE, with a
// loud stderr warning on every use: on Linux a same-user process can
// read a parent's environment via /proc, so in that mode the
// encryption protection is downgraded to nothing during test-pick.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateKeypair, keypairFromPem } from "./jws.js";
import type { Keypair } from "./jws.js";
import { decryptPrivateKey, encryptPrivateKey, isEncryptedKeyFile } from "./keyfile.js";
import { PassphraseError, promptPassphrase as promptPassphraseOnTty } from "./passphrase.js";
import { withFileLock } from "./lock.js";

export function defaultKeyDir(): string {
  return process.env["TRIANGULATE_HOME"] ?? join(homedir(), ".triangulate");
}

const PRIVATE_NAME = "key.pem";
const PUBLIC_NAME = "key.pub.json";
const PASSPHRASE_ENV = "TRIANGULATE_KEY_PASSPHRASE";

/**
 * Minimum passphrase length (B7): a key "encrypted" under an empty or
 * trivially short passphrase is effectively plaintext — the salt is in
 * the envelope, so offline brute force at scrypt N=16384 falls in
 * milliseconds. Enforced once here, in resolvePassphrase, so the TTY
 * prompt, the env-var hatch, and the migration path are all covered.
 * Consequence, by design: a key created before this check with a
 * short passphrase can no longer be loaded — fail closed, not fail
 * open. Its owner deletes key.pem and creates a new key (a new
 * identity, as with any lost key — see the README).
 */
const MIN_PASSPHRASE_LENGTH = 8;

export interface GetKeypairOptions {
  /** Override the passphrase prompt (tests). When unset, the TTY prompt is used. */
  promptPassphrase?: (promptText: string) => Promise<Buffer>;
}

/**
 * The CI escape hatch. Returns null when the variable is unset or
 * empty. Warns loudly on every use: a passphrase supplied this way
 * is readable by candidate code on Linux via /proc parent environ,
 * so the encryption protection is downgraded to nothing during
 * test-pick. (A --key-passphrase-file flag would be no better: the
 * path is visible in /proc/<pid>/cmdline.)
 */
function envPassphrase(): Buffer | null {
  const value = process.env[PASSPHRASE_ENV];
  if (value === undefined || value.length === 0) return null;
  console.error(
    "triangulate: WARNING: signing-key passphrase supplied via TRIANGULATE_KEY_PASSPHRASE — " +
      "on Linux a same-user process can read a parent's environment via /proc, " +
      "so this downgrades the key encryption to nothing during test-pick",
  );
  return Buffer.from(value, "utf8");
}

async function resolvePassphrase(
  promptText: string,
  prompt?: (text: string) => Promise<Buffer>,
): Promise<Buffer> {
  const fromEnv = envPassphrase();
  const passphrase =
    fromEnv !== null
      ? fromEnv
      : prompt !== undefined
        ? await prompt(promptText)
        : await promptPassphraseOnTty(promptText);
  if (passphrase.toString("utf8").length < MIN_PASSPHRASE_LENGTH) {
    passphrase.fill(0);
    throw new PassphraseError(
      `signing-key passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`,
    );
  }
  return passphrase;
}

/**
 * Cross-check the stored public key against the private key, rewriting
 * the public file when it is missing or corrupt. A mismatch throws —
 * silently replacing the key would orphan every verdict the old key
 * signed.
 */
async function checkOrWritePublic(pubPath: string, keypair: Keypair): Promise<void> {
  let storedPub: { x?: unknown; kid?: unknown } | null = null;
  try {
    storedPub = JSON.parse(await readFile(pubPath, "utf8")) as { x?: unknown; kid?: unknown };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && code !== "ENOENT") throw error;
    // Missing or corrupt public file: rewrite it from the private key.
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
}

/**
 * Load the local keypair, generating and storing one on first use.
 * Only a missing private-key file triggers generation. A corrupt
 * stored key, or a public file that does not match the private key,
 * throws — silently replacing the key would orphan every verdict the
 * old key signed. The whole load-or-generate is serialized through a
 * cross-process lock: two simultaneous first runs must not generate
 * two different keypairs and race the writes (N4).
 *
 * The private key is never stored or signed as plaintext: a new key
 * is encrypted before it is written, an encrypted key is decrypted
 * in memory only, and a plaintext key found on disk (pre-v1.1, or
 * hand-made) is migrated — prompted once for a new passphrase and
 * re-stored encrypted — before anything signs with it.
 */
export async function getOrCreateKeypair(
  dir: string = defaultKeyDir(),
  opts: GetKeypairOptions = {},
): Promise<Keypair> {
  await mkdir(dir, { recursive: true });
  return withFileLock(join(dir, ".key.lock"), async () => {
    const privPath = join(dir, PRIVATE_NAME);
    const pubPath = join(dir, PUBLIC_NAME);
    let stored: string;
    try {
      stored = await readFile(privPath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      // First run: generate, encrypt, store. Never store plaintext.
      const passphrase = await resolvePassphrase(
        "triangulate: new signing-key passphrase: ",
        opts.promptPassphrase,
      );
      try {
        const keypair = generateKeypair();
        await writeFile(privPath, encryptPrivateKey(keypair.privateKeyPem, passphrase), {
          mode: 0o600,
        });
        await checkOrWritePublic(pubPath, keypair);
        return keypair;
      } finally {
        passphrase.fill(0);
      }
    }
    if (isEncryptedKeyFile(stored)) {
      let passphrase: Buffer;
      try {
        passphrase = await resolvePassphrase(
          "triangulate: signing-key passphrase: ",
          opts.promptPassphrase,
        );
      } catch (error) {
        // N18: a pre-existing key protected by a now-too-short passphrase
        // fails closed on load — say what the operator must do about it.
        if (error instanceof PassphraseError) {
          throw new PassphraseError(
            `${error.message} — a key protected by a shorter passphrase can no longer be loaded; delete ${PRIVATE_NAME} to start a new identity`,
          );
        }
        throw error;
      }
      try {
        const keypair = keypairFromPem(decryptPrivateKey(stored, passphrase));
        await checkOrWritePublic(pubPath, keypair);
        return keypair;
      } finally {
        passphrase.fill(0);
      }
    }
    // Plaintext key on disk: migrate to encrypted storage. Never sign
    // with a plaintext key — the re-encryption happens before the
    // keypair is returned.
    const passphrase = await resolvePassphrase(
      "triangulate: new signing-key passphrase (migrating plaintext key to encrypted storage): ",
      opts.promptPassphrase,
    );
    try {
      const keypair = keypairFromPem(stored);
      await checkOrWritePublic(pubPath, keypair);
      await writeFile(privPath, encryptPrivateKey(keypair.privateKeyPem, passphrase), {
        mode: 0o600,
      });
      return keypair;
    } finally {
      passphrase.fill(0);
    }
  });
}
