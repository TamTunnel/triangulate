// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arbitrate } from "../src/arbitrator.js";
import { orchestrate } from "../src/orchestrator.js";
import { FakeAdapter } from "../src/adapters/fake.js";
import { generateKeypair } from "../src/core/jws.js";
import { taskHash, verifyVerdict } from "../src/core/verdict.js";
import type { JurorOutcome } from "../src/orchestrator.js";

async function fixtureRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tri-arb-"));
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  };
  git("init", "-b", "master");
  git("config", "user.email", "test@local");
  git("config", "user.name", "Test");
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf8");
  }
  git("add", ".");
  git("commit", "-m", "init");
  return dir;
}

async function outcomes(
  repo: string,
  jurors: FakeAdapter[],
  task = "do it",
): Promise<{ outcomes: JurorOutcome[]; baseFiles: Map<string, string> }> {
  const result = await orchestrate({
    repo,
    task,
    jurors,
    timeoutMs: 10_000,
    budgetMinor: 0,
    env: {},
  });
  return { outcomes: result.outcomes, baseFiles: result.baseFiles };
}

const keypair = generateKeypair();

test("arbitrator: identical diffs are UNANIMOUS and the verdict verifies offline", async () => {
  const repo = await fixtureRepo({ "a.txt": "l1\nl2\n" });
  const { outcomes: outs, baseFiles } = await outcomes(repo, [
    new FakeAdapter("fake-a", { files: { "a.txt": "L1\nl2\n" } }),
    new FakeAdapter("fake-b", { files: { "a.txt": "L1\nl2\n" } }),
  ]);
  const { verdict } = await arbitrate({
    repo,
    task: "do it",
    redactTask: false,
    baseFiles,
    outcomes: outs,
    testCommand: null,
    testTimeoutMs: 5000,
    keypair,
    version: "0.1.0",
  });
  assert.equal(verdict.tier, "UNANIMOUS");
  assert.equal(verdict.task.hash, taskHash("do it"));
  assert.equal(verdict.task.text, "do it");
  assert.equal(verifyVerdict(verdict).ok, true);
  assert.equal(verdict.merge.conflicts.length, 0);
});

test("arbitrator: non-overlapping diffs are MAJORITY with the merged content", async () => {
  const repo = await fixtureRepo({ "a.txt": "l1\nl2\nl3\nl4\n" });
  const { outcomes: outs, baseFiles } = await outcomes(repo, [
    new FakeAdapter("fake-a", { files: { "a.txt": "L1\nl2\nl3\nl4\n" } }),
    new FakeAdapter("fake-b", { files: { "a.txt": "l1\nl2\nl3\nL4\n" } }),
  ]);
  const { verdict, mergedFiles } = await arbitrate({
    repo,
    task: "do it",
    redactTask: false,
    baseFiles,
    outcomes: outs,
    testCommand: null,
    testTimeoutMs: 5000,
    keypair,
    version: "0.1.0",
  });
  assert.equal(verdict.tier, "MAJORITY");
  assert.equal(mergedFiles.get("a.txt"), "L1\nl2\nl3\nL4\n");
  assert.equal(verifyVerdict(verdict).ok, true);
});

test("arbitrator: conflicting diffs with no test command are DIVERGED with both sides recorded", async () => {
  const repo = await fixtureRepo({ "a.txt": "l1\nl2\n" });
  const { outcomes: outs, baseFiles } = await outcomes(repo, [
    new FakeAdapter("fake-a", { files: { "a.txt": "A\nl2\n" } }),
    new FakeAdapter("fake-b", { files: { "a.txt": "B\nl2\n" } }),
  ]);
  const { verdict } = await arbitrate({
    repo,
    task: "do it",
    redactTask: false,
    baseFiles,
    outcomes: outs,
    testCommand: null,
    testTimeoutMs: 5000,
    keypair,
    version: "0.1.0",
  });
  assert.equal(verdict.tier, "DIVERGED");
  assert.equal(verdict.merge.conflicts.length, 1);
  const conflict = verdict.merge.conflicts[0];
  assert.ok(conflict !== undefined);
  assert.equal(conflict.rule, "unresolved");
  assert.deepEqual(Object.keys(conflict.sides).sort(), ["fake-a", "fake-b"]);
  assert.equal(verdict.dissent.some((d) => d.kind === "conflict"), true);
  assert.equal(verifyVerdict(verdict).ok, true);
});

test("arbitrator: test-pick resolves a conflict with the passing side (rule tests)", async () => {
  const repo = await fixtureRepo({
    "value.txt": "1\n",
    "test.sh": "#!/bin/sh\ngrep -q '^3$' value.txt\n",
  });
  const { outcomes: outs, baseFiles } = await outcomes(repo, [
    new FakeAdapter("fake-a", { files: { "value.txt": "2\n" } }),
    new FakeAdapter("fake-b", { files: { "value.txt": "3\n" } }),
  ]);
  const { verdict, mergedFiles } = await arbitrate({
    repo,
    task: "do it",
    redactTask: false,
    baseFiles,
    outcomes: outs,
    testCommand: "sh test.sh",
    testTimeoutMs: 5000,
    keypair,
    version: "0.1.0",
  });
  assert.equal(verdict.tier, "MAJORITY");
  assert.equal(mergedFiles.get("value.txt"), "3\n");
  assert.equal(verdict.merge.conflicts.length, 1);
  const conflict = verdict.merge.conflicts[0];
  assert.ok(conflict !== undefined);
  assert.equal(conflict.rule, "tests");
  assert.equal(conflict.winner, "fake-b");
  assert.equal(verdict.tests?.outcome, "pass");
  assert.equal(verifyVerdict(verdict).ok, true);
});

test("arbitrator: a first-run failure that passes on rerun is recorded flaky (D-5)", async () => {
  const flagDir = await mkdtemp(join(tmpdir(), "tri-flaky-"));
  const flag = join(flagDir, "flag");
  const repo = await fixtureRepo({
    "a.txt": "l1\n",
    "test.sh": `#!/bin/sh\nif [ -f "${flag}" ]; then exit 0; else touch "${flag}"; exit 1; fi\n`,
  });
  const { outcomes: outs, baseFiles } = await outcomes(repo, [
    new FakeAdapter("fake-a", { files: { "a.txt": "L1\n" } }),
  ]);
  const { verdict } = await arbitrate({
    repo,
    task: "do it",
    redactTask: false,
    baseFiles,
    outcomes: outs,
    testCommand: "sh test.sh",
    testTimeoutMs: 5000,
    keypair,
    version: "0.1.0",
  });
  // The tier is MAJORITY regardless of the test outcome (D-5).
  assert.equal(verdict.tier, "MAJORITY");
  assert.equal(verdict.tests?.outcome, "flaky");
  assert.equal(verdict.tests?.flaky, true);
});

test("arbitrator: all jurors failed is FAILED with an empty merge", async () => {
  const repo = await fixtureRepo({ "a.txt": "l1\n" });
  const { outcomes: outs, baseFiles } = await outcomes(repo, [
    new FakeAdapter("fake-a", { files: {}, behavior: "fail" }),
    new FakeAdapter("fake-b", { files: {}, behavior: "fail" }),
  ]);
  const { verdict, mergedFiles } = await arbitrate({
    repo,
    task: "do it",
    redactTask: false,
    baseFiles,
    outcomes: outs,
    testCommand: null,
    testTimeoutMs: 5000,
    keypair,
    version: "0.1.0",
  });
  assert.equal(verdict.tier, "FAILED");
  assert.equal(mergedFiles.size, 0);
  assert.equal(verdict.merge.diff, "");
  assert.equal(verdict.dissent.length, 2);
  assert.equal(verifyVerdict(verdict).ok, true);
});

test("arbitrator: --redact-task omits the task text but keeps the hash", async () => {
  const repo = await fixtureRepo({ "a.txt": "l1\n" });
  const { outcomes: outs, baseFiles } = await outcomes(repo, [
    new FakeAdapter("fake-a", { files: { "a.txt": "L1\n" } }),
  ]);
  const { verdict } = await arbitrate({
    repo,
    task: "secret task",
    redactTask: true,
    baseFiles,
    outcomes: outs,
    testCommand: null,
    testTimeoutMs: 5000,
    keypair,
    version: "0.1.0",
  });
  assert.equal(verdict.task.text, undefined);
  assert.equal(verdict.task.hash, taskHash("secret task"));
  assert.equal(JSON.stringify(verdict).includes("secret task"), false);
});

test("arbitrator: juror order does not change the merge (D-1)", async () => {
  const repo = await fixtureRepo({ "a.txt": "l1\nl2\nl3\nl4\nl5\nl6\n" });
  const first = await outcomes(repo, [
    new FakeAdapter("fake-a", { files: { "a.txt": "L1\nl2\nl3\nl4\nl5\nl6\n" } }),
    new FakeAdapter("fake-b", { files: { "a.txt": "l1\nl2\nL3\nl4\nl5\nl6\n" } }),
    new FakeAdapter("fake-c", { files: { "a.txt": "l1\nl2\nl3\nl4\nL5\nl6\n" } }),
  ]);
  const second = await outcomes(repo, [
    new FakeAdapter("fake-c", { files: { "a.txt": "l1\nl2\nl3\nl4\nL5\nl6\n" } }),
    new FakeAdapter("fake-a", { files: { "a.txt": "L1\nl2\nl3\nl4\nl5\nl6\n" } }),
    new FakeAdapter("fake-b", { files: { "a.txt": "l1\nl2\nL3\nl4\nl5\nl6\n" } }),
  ]);
  const r1 = await arbitrate({
    repo,
    task: "do it",
    redactTask: false,
    baseFiles: first.baseFiles,
    outcomes: first.outcomes,
    testCommand: null,
    testTimeoutMs: 5000,
    keypair,
    version: "0.1.0",
  });
  const r2 = await arbitrate({
    repo,
    task: "do it",
    redactTask: false,
    baseFiles: second.baseFiles,
    outcomes: second.outcomes,
    testCommand: null,
    testTimeoutMs: 5000,
    keypair,
    version: "0.1.0",
  });
  assert.equal(r1.verdict.merge.diff, r2.verdict.merge.diff);
  assert.equal(r1.verdict.tier, r2.verdict.tier);
});

test("arbitrator: test-pick resolves a whole-file conflict (F6, P5)", async () => {
  const repo = await fixtureRepo({ "package.json": JSON.stringify({ scripts: { test: "true" } }) });
  const { outcomes: outs, baseFiles } = await outcomes(repo, [
    new FakeAdapter("fake-a", { files: { "new.txt": "side A\n" } }),
    new FakeAdapter("fake-b", { files: { "new.txt": "side B\n" } }),
  ]);
  const { verdict, mergedFiles } = await arbitrate({
    repo,
    task: "do it",
    redactTask: false,
    baseFiles,
    outcomes: outs,
    testCommand: "true",
    testTimeoutMs: 5000,
    keypair,
    version: "0.1.0",
  });
  // Both sides pass `true`, so the first side (fake-a) wins by test-pick.
  assert.equal(verdict.tier, "MAJORITY");
  assert.equal(verdict.merge.conflicts.length, 1);
  const conflict = verdict.merge.conflicts[0];
  assert.ok(conflict !== undefined);
  assert.equal(conflict.rule, "tests");
  assert.equal(conflict.winner, "fake-a");
  assert.equal(mergedFiles.get("new.txt"), "side A\n");
  assert.equal(verifyVerdict(verdict).ok, true);
});

test("arbitrator: delete vs keep is recorded as a conflict and the file stays (F4)", async () => {
  const repo = await fixtureRepo({ "victim.txt": "keep me\n" });
  const { outcomes: outs, baseFiles } = await outcomes(repo, [
    new FakeAdapter("fake-del", { files: { "victim.txt": null } }),
    new FakeAdapter("fake-keep", { files: {} }),
  ]);
  const { verdict, mergedFiles } = await arbitrate({
    repo,
    task: "do it",
    redactTask: false,
    baseFiles,
    outcomes: outs,
    testCommand: null,
    testTimeoutMs: 5000,
    keypair,
    version: "0.1.0",
  });
  assert.equal(verdict.tier, "DIVERGED");
  assert.equal(mergedFiles.get("victim.txt"), "keep me\n");
  const conflict = verdict.merge.conflicts.find((c) => c.file === "victim.txt");
  assert.ok(conflict !== undefined);
  assert.equal(conflict.rule, "unresolved");
  assert.equal(verifyVerdict(verdict).ok, true);
});
