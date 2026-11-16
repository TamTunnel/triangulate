// SPDX-License-Identifier: Apache-2.0
// Regression tests for assessment §9 (decision (c)/(d), judge B6):
// the signing key is passphrase-encrypted at rest, and the residual
// — candidate code can resolve the real home via the passwd DB and
// read a parent's environment via /proc on Linux — is pinned here as
// a deliberate, visible decision, not a forgotten hole.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { statSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getOrCreateKeypair } from "../src/core/keys.js";
import {
  decryptPrivateKey,
  encryptPrivateKey,
  isEncryptedKeyFile,
  KEYFILE_FORMAT,
} from "../src/core/keyfile.js";
import { generateKeypair, keypairFromPem } from "../src/core/jws.js";
import { signVerdict, verifyVerdict } from "../src/core/verdict.js";
import type { VerdictPayload } from "../src/core/verdict.js";

const execFileAsync = promisify(execFile);

const prompt =
  (password: string) =>
  (): Promise<Buffer> =>
    Promise.resolve(Buffer.from(password, "utf8"));

function samplePayload(kp: ReturnType<typeof generateKeypair>): VerdictPayload {
  return {
    format: "triangulate/1",
    created_at: "2026-11-16T00:00:00.000Z",
    tool: { name: "triangulate", version: "0.1.0" },
    task: { text: "Add a greeting function.", hash: "h" },
    repo: { path: "/tmp/repo", base: "abc123" },
    jurors: [],
    candidates: [],
    merge: { diff: "", conflicts: [], dropped: [] },
    tests: null,
    tier: "FAILED",
    dissent: [],
    signer: { publicKey: kp.publicKey, kid: kp.kid },
  };
}

test("keyfile: a new key is stored encrypted, never as a plaintext PEM (§9, B6)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tri-keyenc-"));
  const kp = await getOrCreateKeypair(dir, { promptPassphrase: prompt("correct horse") });
  const stored = await readFile(join(dir, "key.pem"), "utf8");
  // (a) The file on disk is ciphertext, not a PEM.
  assert.equal(stored.includes("-----BEGIN PRIVATE KEY-----"), false);
  assert.equal(isEncryptedKeyFile(stored), true);
  const envelope = JSON.parse(stored) as { format: string; kdf: string };
  assert.equal(envelope.format, KEYFILE_FORMAT);
  assert.equal(envelope.kdf, "scrypt");
  // It does not parse as a key at all.
  assert.throws(() => createPrivateKey(stored));
  // The file is still 0600.
  const { stat } = await import("node:fs/promises");
  assert.equal((await stat(join(dir, "key.pem"))).mode & 0o777, 0o600);
  // Loading again with the same passphrase returns the same keypair.
  const kp2 = await getOrCreateKeypair(dir, { promptPassphrase: prompt("correct horse") });
  assert.equal(kp2.kid, kp.kid);
});

test("keyfile: encrypt/decrypt round-trips, and a wrong passphrase fails cleanly (§9, B6)", () => {
  const kp = generateKeypair();
  const pass = Buffer.from("correct horse", "utf8");
  const wrong = Buffer.from("wrong horse", "utf8");
  try {
    const envelope = encryptPrivateKey(kp.privateKeyPem, pass);
    assert.equal(decryptPrivateKey(envelope, pass), kp.privateKeyPem);
    assert.throws(() => decryptPrivateKey(envelope, wrong), /wrong passphrase/);
    assert.throws(() => decryptPrivateKey("not json", pass), /not a valid encrypted key/);
    assert.throws(() => decryptPrivateKey("{}", pass), /not supported/);
  } finally {
    pass.fill(0);
    wrong.fill(0);
  }
});

test("keyfile: wrong passphrase fails to load the key with a clean error (§9, B6)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tri-keywrong-"));
  await getOrCreateKeypair(dir, { promptPassphrase: prompt("correct horse") });
  await assert.rejects(
    getOrCreateKeypair(dir, { promptPassphrase: prompt("wrong horse") }),
    /wrong passphrase/,
  );
  // The stored file is untouched by the failed load.
  assert.equal(isEncryptedKeyFile(await readFile(join(dir, "key.pem"), "utf8")), true);
});

test("keyfile: a plaintext key found on disk is migrated to encrypted storage (§9)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tri-keymig-"));
  const original = generateKeypair();
  await writeFile(join(dir, "key.pem"), original.privateKeyPem, { mode: 0o600 });
  const kp = await getOrCreateKeypair(dir, { promptPassphrase: prompt("new passphrase") });
  // Same identity, now stored encrypted — never signed as plaintext.
  assert.equal(kp.kid, original.kid);
  const stored = await readFile(join(dir, "key.pem"), "utf8");
  assert.equal(stored.includes("-----BEGIN PRIVATE KEY-----"), false);
  assert.equal(isEncryptedKeyFile(stored), true);
  // Loads again with the new passphrase.
  const kp2 = await getOrCreateKeypair(dir, { promptPassphrase: prompt("new passphrase") });
  assert.equal(kp2.kid, original.kid);
});

test("keyfile: verdicts signed with an encrypted-stored key verify offline (§9, B6)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tri-keyverify-"));
  const kp = await getOrCreateKeypair(dir, { promptPassphrase: prompt("correct horse") });
  const verdict = signVerdict(samplePayload(kp), kp);
  assert.equal(verifyVerdict(verdict).ok, true);
  // The keypair built from the decrypted PEM signs identically.
  const kp2 = keypairFromPem(decryptPrivateKey(await readFile(join(dir, "key.pem"), "utf8"), Buffer.from("correct horse", "utf8")));
  assert.equal(kp2.kid, kp.kid);
});

test("keyfile: TRIANGULATE_KEY_PASSPHRASE supplies the passphrase with a loud warning (§9)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tri-keyenv-"));
  const previous = process.env["TRIANGULATE_KEY_PASSPHRASE"];
  process.env["TRIANGULATE_KEY_PASSPHRASE"] = "env passphrase";
  const warnings: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const kp = await getOrCreateKeypair(dir);
    assert.equal(typeof kp.kid, "string");
    assert.equal(
      warnings.some(
        (w) => w.includes("TRIANGULATE_KEY_PASSPHRASE") && w.includes("downgrades"),
      ),
      true,
    );
    // Loading again re-warns (every use, not once per process).
    warnings.length = 0;
    const kp2 = await getOrCreateKeypair(dir);
    assert.equal(kp2.kid, kp.kid);
    assert.equal(warnings.length, 1);
  } finally {
    console.error = origError;
    if (previous === undefined) delete process.env["TRIANGULATE_KEY_PASSPHRASE"];
    else process.env["TRIANGULATE_KEY_PASSPHRASE"] = previous;
  }
});

test("residual (B6/§9): the real home is resolvable via the passwd DB, but the key found there is ciphertext", async () => {
  // The residual is real: os.userInfo() reads the passwd entry and
  // ignores $HOME entirely, so a candidate test process can resolve
  // the operator's real home on any OS. This test pins that fact —
  // and proves the §9 mitigation: whatever key file the candidate
  // finds at that home, it is ciphertext, not a usable key.
  const home = userInfo().homedir;
  assert.equal(statSync(home).isDirectory(), true);
  const getuid = process.getuid;
  if (typeof getuid === "function") {
    const uid = getuid();
    const passwd = await readFile("/etc/passwd", "utf8");
    const line = passwd.split("\n").find((l) => l.split(":")[2] === String(uid));
    if (line !== undefined) {
      const homeField = line.split(":")[5];
      assert.equal(typeof homeField, "string");
      assert.equal(homeField, home);
    }
  }
  // The key file itself, read exactly as candidate code would read it
  // after resolving the home, is ciphertext: no PEM header, does not
  // parse as a key, and only the passphrase unlocks it.
  const dir = await mkdtemp(join(tmpdir(), "tri-keyresid-"));
  const kp = await getOrCreateKeypair(dir, { promptPassphrase: prompt("correct horse") });
  const stolen = await readFile(join(dir, "key.pem"), "utf8");
  assert.equal(stolen.includes("-----BEGIN"), false);
  assert.throws(() => createPrivateKey(stolen));
  assert.throws(
    () => decryptPrivateKey(stolen, Buffer.from("wrong horse", "utf8")),
    /wrong passphrase/,
  );
  assert.equal(
    keypairFromPem(decryptPrivateKey(stolen, Buffer.from("correct horse", "utf8"))).kid,
    kp.kid,
  );
});

test(
  "residual (B6/§9): on Linux a same-uid process can read a parent's environment via /proc",
  { skip: process.platform !== "linux" },
  async (t) => {
    // A child process (B) with a scrubbed environment scans /proc for
    // a canary that only its parent (A) has in its environment. If B
    // finds it, the /proc channel the judge proved is real — and the
    // B2 env scrub cannot close it. This pins the residual; it does
    // not fix it (see §9 (d)).
    const canary = `residual-canary-${Date.now()}`;
    const scanScript = `
      const fs = require("node:fs");
      let readable = 0;
      let found = false;
      for (const d of fs.readdirSync("/proc")) {
        if (!/^\\d+$/.test(d)) continue;
        try {
          const env = fs.readFileSync("/proc/" + d + "/environ", "utf8").split("\\0");
          readable += 1;
          if (env.some((kv) => kv.startsWith("TRI_RESIDUAL_CANARY="))) found = true;
        } catch {}
      }
      console.log(found ? "FOUND" : "NOT-FOUND" + " readable=" + readable);
    `;
    const parentScript = `
      const { execFileSync } = require("node:child_process");
      const out = execFileSync(process.execPath, ["-e", ${JSON.stringify(scanScript)}], {
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      });
      console.log(out.trim());
    `;
    const parentFile = join(await mkdtemp(join(tmpdir(), "tri-proc-")), "parent.cjs");
    await writeFile(parentFile, parentScript, "utf8");
    const { stdout } = await execFileAsync(process.execPath, [parentFile], {
      encoding: "utf8",
      env: { ...process.env, TRI_RESIDUAL_CANARY: canary },
    });
    const line = stdout.trim();
    if (line.includes("readable=0")) {
      t.skip("no /proc environ readable in this environment (hidepid?)");
      return;
    }
    assert.equal(line, "FOUND");
  },
);

test("keyfile: empty and short passphrases are rejected at key creation (B7)", async () => {
  // A key "encrypted" under "" or "x" is effectively plaintext — the
  // salt is in the envelope, so offline brute force falls in
  // milliseconds. Creation must fail cleanly and leave no key file.
  for (const bad of ["", "x", "1234567"]) {
    const dir = await mkdtemp(join(tmpdir(), "tri-keyshort-"));
    await assert.rejects(
      getOrCreateKeypair(dir, { promptPassphrase: prompt(bad) }),
      /at least 8 characters/,
    );
    await assert.rejects(readFile(join(dir, "key.pem"), "utf8"));
  }
});

test("keyfile: an 8-character passphrase is accepted and the key loads again (B7)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tri-key8-"));
  const kp = await getOrCreateKeypair(dir, { promptPassphrase: prompt("12345678") });
  assert.equal(isEncryptedKeyFile(await readFile(join(dir, "key.pem"), "utf8")), true);
  const kp2 = await getOrCreateKeypair(dir, { promptPassphrase: prompt("12345678") });
  assert.equal(kp2.kid, kp.kid);
});

test("keyfile: a short TRIANGULATE_KEY_PASSPHRASE is rejected cleanly (B7)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tri-keyenvshort-"));
  const previous = process.env["TRIANGULATE_KEY_PASSPHRASE"];
  process.env["TRIANGULATE_KEY_PASSPHRASE"] = "short";
  const origError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(getOrCreateKeypair(dir), /at least 8 characters/);
    await assert.rejects(readFile(join(dir, "key.pem"), "utf8"));
  } finally {
    console.error = origError;
    if (previous === undefined) delete process.env["TRIANGULATE_KEY_PASSPHRASE"];
    else process.env["TRIANGULATE_KEY_PASSPHRASE"] = previous;
  }
});

test("keyfile: migration with a short passphrase is rejected and the plaintext key is untouched (B7)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tri-keymigshort-"));
  const original = generateKeypair();
  await writeFile(join(dir, "key.pem"), original.privateKeyPem, { mode: 0o600 });
  await assert.rejects(
    getOrCreateKeypair(dir, { promptPassphrase: prompt("x") }),
    /at least 8 characters/,
  );
  // Nothing was re-encrypted: the plaintext key is exactly as found.
  const stored = await readFile(join(dir, "key.pem"), "utf8");
  assert.equal(stored, original.privateKeyPem);
  assert.equal(isEncryptedKeyFile(stored), false);
});

test("keyfile: a pre-existing short-passphrase key fails closed on load and states the remedy (N18)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tri-keyshortold-"));
  // A key encrypted directly with a 1-char passphrase (round-4
  // semantics, before the B7 floor existed) — written straight to
  // disk, bypassing resolvePassphrase.
  const original = generateKeypair();
  const short = Buffer.from("x", "utf8");
  await writeFile(join(dir, "key.pem"), encryptPrivateKey(original.privateKeyPem, short), {
    mode: 0o600,
  });
  const before = await readFile(join(dir, "key.pem"), "utf8");
  await assert.rejects(
    getOrCreateKeypair(dir, { promptPassphrase: prompt("x") }),
    /at least 8 characters.*delete key\.pem to start a new identity/s,
  );
  // Fail closed: no signing happened, and the file is byte-identical.
  const after = await readFile(join(dir, "key.pem"), "utf8");
  assert.equal(after, before);
});
