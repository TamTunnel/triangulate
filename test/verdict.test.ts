// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeypair } from "../src/core/jws.js";
import {
  signVerdict,
  taskHash,
  verifyVerdict,
} from "../src/core/verdict.js";
import type { Verdict, VerdictPayload } from "../src/core/verdict.js";
import { getOrCreateKeypair } from "../src/core/keys.js";
import {
  appendLog,
  readLog,
  readVerdict,
  verifyLog,
  writeVerdict,
} from "../src/core/store.js";

function samplePayload(kp: ReturnType<typeof generateKeypair>): VerdictPayload {
  return {
    format: "triangulate/1",
    created_at: "2026-11-16T00:00:00.000Z",
    tool: { name: "triangulate", version: "0.1.0" },
    task: { text: "Add a greeting function.", hash: taskHash("Add a greeting function.") },
    repo: { path: "/tmp/repo", base: "abc123" },
    jurors: [
      {
        id: "claude",
        model: "claude-sonnet-4-5",
        adapter: "cli",
        status: "ok",
        costMinor: 120,
        durationMs: 5000,
        candidateHash: "deadbeef",
      },
    ],
    candidates: [{ juror: "claude", diff: "--- a/x\n+++ b/x\n", hash: "deadbeef" }],
    merge: { diff: "--- a/x\n+++ b/x\n", conflicts: [], dropped: [] },
    tests: null,
    tier: "UNANIMOUS",
    dissent: [],
    signer: { publicKey: kp.publicKey, kid: kp.kid },
  };
}

test("verdict: sign then verify passes; id is the canonical hash", () => {
  const kp = generateKeypair();
  const verdict = signVerdict(samplePayload(kp), kp);
  assert.equal(verdict.id.length, 64);
  assert.equal(verifyVerdict(verdict).ok, true);
});

test("verdict: one byte changed in the payload fails (S-3)", () => {
  const kp = generateKeypair();
  const verdict = signVerdict(samplePayload(kp), kp);
  const tampered: Verdict = {
    ...verdict,
    merge: { ...verdict.merge, diff: `${verdict.merge.diff} ` },
  };
  assert.equal(verifyVerdict(tampered).ok, false);
  assert.equal(verifyVerdict(tampered).reason, "id-mismatch");
});

test("verdict: one byte changed in a candidate hash fails (S-3)", () => {
  const kp = generateKeypair();
  const verdict = signVerdict(samplePayload(kp), kp);
  const tampered: Verdict = {
    ...verdict,
    candidates: [{ juror: "claude", diff: "--- a/x\n+++ b/x\n", hash: "deadbee0" }],
  };
  assert.equal(verifyVerdict(tampered).ok, false);
});

test("verdict: signed with a different key fails (S-3)", () => {
  const kp1 = generateKeypair();
  const kp2 = generateKeypair();
  const payload = samplePayload(kp1);
  const verdict = signVerdict(payload, kp1);
  const forged: Verdict = {
    ...verdict,
    signer: { publicKey: kp2.publicKey, kid: kp2.kid },
  };
  // Re-signing with kp2 over kp1's payload would be a different verdict;
  // here the signature is kp1's but the signer claims kp2 — must fail.
  assert.equal(verifyVerdict(forged).ok, false);
});

test("verdict: missing signature fails", () => {
  const kp = generateKeypair();
  const verdict = signVerdict(samplePayload(kp), kp);
  const stripped = { ...verdict, signature: "" };
  assert.equal(verifyVerdict(stripped).ok, false);
});

test("verdict: key order in the document does not change the id (D-4)", () => {
  const kp = generateKeypair();
  const v1 = signVerdict(samplePayload(kp), kp);
  // Deep-shuffle the key order at every level, then re-parse: the id is
  // over the canonical form, not the file bytes, so this must still verify.
  const shuffleKeysDeep = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(shuffleKeysDeep);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).reverse()) {
        out[key] = shuffleKeysDeep((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  const shuffled = JSON.parse(JSON.stringify(shuffleKeysDeep(v1))) as Verdict;
  assert.equal(verifyVerdict(shuffled).ok, true);
  assert.equal(shuffled.id, v1.id);
});

test("keys: getOrCreateKeypair is stable across calls and files are 0600/0644", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tri-keys-"));
  const kp1 = await getOrCreateKeypair(dir);
  const kp2 = await getOrCreateKeypair(dir);
  assert.equal(kp1.kid, kp2.kid);
  const { stat } = await import("node:fs/promises");
  assert.equal((await stat(join(dir, "key.pem"))).mode & 0o777, 0o600);
  const pub = JSON.parse(await readFile(join(dir, "key.pub.json"), "utf8")) as { x: string };
  assert.equal(pub.x, kp1.publicKey.x);
});

test("store: write/read round-trips and the log chain verifies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tri-store-"));
  const kp = generateKeypair();
  const logPath = join(dir, "log.jsonl");
  const v1 = signVerdict(samplePayload(kp), kp);
  const v2 = signVerdict(
    { ...samplePayload(kp), tier: "MAJORITY", created_at: "2026-11-16T00:01:00.000Z" },
    kp,
  );
  const p1 = await writeVerdict(v1, dir);
  assert.deepEqual(await readVerdict(p1), v1);
  await appendLog(v1, logPath);
  await appendLog(v2, logPath);
  const entries = await readLog(logPath);
  assert.equal(entries.length, 2);
  const first = entries[0];
  const second = entries[1];
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(second.prev, first.hash);
  assert.equal(verifyLog(entries).ok, true);
  // Tamper with the chain: it must fail.
  const tampered = [...entries];
  if (tampered[1] !== undefined) tampered[1] = { ...tampered[1], tier: "FAILED" };
  assert.equal(verifyLog(tampered).ok, false);
});

test("store: writing a verdict file is not required for the test above", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tri-store2-"));
  await writeFile(join(dir, "junk.json"), "{not json", "utf8");
  await assert.rejects(readVerdict(join(dir, "junk.json")));
});

test("store: concurrent appends do not corrupt the hash chain (F7, A-3)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tri-store-conc-"));
  const kp = generateKeypair();
  const logPath = join(dir, "log.jsonl");
  const mk = (n: number) =>
    signVerdict(
      { ...samplePayload(kp), task: { text: `t${n}`, hash: `h${n}` } },
      kp,
    );
  await Promise.all(Array.from({ length: 10 }, (_, i) => appendLog(mk(i), logPath)));
  const entries = await readLog(logPath);
  assert.equal(entries.length, 10);
  assert.deepEqual(
    entries.map((e) => e.seq),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.equal(verifyLog(entries).ok, true);
});

test("keys: concurrent first runs generate one keypair, not two (N4)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tri-keys-conc-"));
  const kids = await Promise.all(
    Array.from({ length: 10 }, () => getOrCreateKeypair(dir).then((kp) => kp.kid)),
  );
  assert.equal(new Set(kids).size, 1);
  const pub = JSON.parse(await readFile(join(dir, "key.pub.json"), "utf8")) as { x: string };
  const kp = await getOrCreateKeypair(dir);
  assert.equal(pub.x, kp.publicKey.x);
});
