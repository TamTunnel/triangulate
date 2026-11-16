// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("arbitrator: test runs cannot read API keys from the environment (B2a)", async () => {
  const markerDir = await mkdtemp(join(tmpdir(), "tri-b2a-"));
  const marker = join(markerDir, "marker.txt");
  const repo = await fixtureRepo({
    "a.js": "export const a = 1;\n",
    "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
  });
  const evil = new FakeAdapter("fake-evil", {
    files: {
      "evil.test.mjs":
        "import fs from 'node:fs';\n" +
        `fs.writeFileSync(${JSON.stringify(marker)}, process.env.FAKE_SECRET_KEY ?? 'missing');\n` +
        "import test from 'node:test';\ntest('evil', () => {});\n",
    },
  });
  process.env["FAKE_SECRET_KEY"] = "SECRET-VALUE-12345";
  try {
    const { outcomes: outs, baseFiles } = await outcomes(repo, [evil]);
    await arbitrate({
      repo,
      task: "probe",
      redactTask: false,
      baseFiles,
      outcomes: outs,
      testCommand: "node --test",
      testTimeoutMs: 10_000,
      keypair,
      version: "0.1.0",
    });
  } finally {
    delete process.env["FAKE_SECRET_KEY"];
  }
  // The test file ran (marker exists) but the secret never reached it.
  assert.equal(await readFile(marker, "utf8"), "missing");
  await rm(markerDir, { recursive: true, force: true });
});

test("arbitrator: test runs get a scratch HOME — no signing key or ssh key reachable (B5)", async () => {
  // A fake operator home holding a "signing key" and an ssh key the
  // candidate must never reach. The test env is built from
  // process.env at arbitrate time, so point HOME at the fake home.
  const fakeHome = await mkdtemp(join(tmpdir(), "tri-b5-home-"));
  await mkdir(join(fakeHome, ".triangulate"), { recursive: true });
  await writeFile(join(fakeHome, ".triangulate", "key.pem"), "STOLEN-KEY-MARKER", "utf8");
  await mkdir(join(fakeHome, ".ssh"), { recursive: true });
  await writeFile(join(fakeHome, ".ssh", "id_ed25519"), "STOLEN-SSH-MARKER", "utf8");
  const markerDir = await mkdtemp(join(tmpdir(), "tri-b5-"));
  const marker = join(markerDir, "marker.txt");
  const repo = await fixtureRepo({
    "a.js": "export const a = 1;\n",
    "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
  });
  const evil = new FakeAdapter("fake-evil", {
    files: {
      "evil.test.mjs":
        "import fs from 'node:fs';\n" +
        "import path from 'node:path';\n" +
        "import os from 'node:os';\n" +
        "const keyPath = path.join(process.env.HOME, '.triangulate', 'key.pem');\n" +
        "const sshPath = path.join(os.homedir(), '.ssh', 'id_ed25519');\n" +
        "const key = fs.existsSync(keyPath) ? fs.readFileSync(keyPath, 'utf8') : 'missing-key';\n" +
        "const ssh = fs.existsSync(sshPath) ? fs.readFileSync(sshPath, 'utf8') : 'missing-ssh';\n" +
        `fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ home: process.env.HOME, homedir: os.homedir(), key, ssh }));\n` +
        "import test from 'node:test';\ntest('evil', () => {});\n",
    },
  });
  const savedHome = process.env["HOME"];
  process.env["HOME"] = fakeHome;
  try {
    const { outcomes: outs, baseFiles } = await outcomes(repo, [evil]);
    await arbitrate({
      repo,
      task: "probe",
      redactTask: false,
      baseFiles,
      outcomes: outs,
      testCommand: "node --test",
      testTimeoutMs: 10_000,
      keypair,
      version: "0.1.0",
    });
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
  }
  // The test file ran (marker exists) but found neither key, and the
  // HOME it saw — via env and via os.homedir() — is the scratch home,
  // not the operator's.
  const seen = JSON.parse(await readFile(marker, "utf8")) as {
    home: string;
    homedir: string;
    key: string;
    ssh: string;
  };
  assert.equal(seen.key, "missing-key");
  assert.equal(seen.ssh, "missing-ssh");
  assert.notEqual(seen.home, fakeHome);
  assert.notEqual(seen.homedir, fakeHome);
  assert.equal(seen.home, seen.homedir);
  await rm(markerDir, { recursive: true, force: true });
  await rm(fakeHome, { recursive: true, force: true });
});

test("arbitrator: 'npm test' runs the base repo's test script, never a candidate's rewrite (B2b)", async () => {
  const markerDir = await mkdtemp(join(tmpdir(), "tri-b2b-"));
  const marker = join(markerDir, "marker.txt");
  const repo = await fixtureRepo({
    "a.js": "export const a = 1;\n",
    "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
  });
  const evil = new FakeAdapter("fake-evil", {
    files: {
      "package.json": JSON.stringify({
        scripts: {
          test: `node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)},'pwned')"`,
        },
      }),
    },
  });
  const { outcomes: outs, baseFiles } = await outcomes(repo, [evil]);
  const { verdict } = await arbitrate({
    repo,
    task: "probe",
    redactTask: false,
    baseFiles,
    outcomes: outs,
    testCommand: "npm test",
    testTimeoutMs: 10_000,
    keypair,
    version: "0.1.0",
  });
  // The verdict trail records what actually ran: the base script.
  assert.equal(verdict.tests?.command, "node --test");
  await assert.rejects(readFile(marker, "utf8"), /ENOENT/);
  await rm(markerDir, { recursive: true, force: true });
});

test("arbitrator: 'npm test' with no base test script skips tests and records it (B2)", async () => {
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
    testCommand: "npm test",
    testTimeoutMs: 5000,
    keypair,
    version: "0.1.0",
  });
  assert.equal(verdict.tests, null);
  assert.equal(verdict.tier, "DIVERGED");
  assert.ok(verdict.dissent.some((d) => d.kind === "test-command"));
});

test("arbitrator: a timed-out test run leaves no orphaned grandchildren (B4)", async () => {
  const markerDir = await mkdtemp(join(tmpdir(), "tri-b4-"));
  const marker = join(markerDir, "marker.txt");
  const repo = await fixtureRepo({ "a.js": "export const a = 1;\n" });
  const { outcomes: outs, baseFiles } = await outcomes(repo, [
    new FakeAdapter("fake-a", { files: { "b.js": "export const b = 2;\n" } }),
  ]);
  const cmd = `(sleep 3; echo done > ${marker}) & wait`;
  const t0 = Date.now();
  const { verdict } = await arbitrate({
    repo,
    task: "probe",
    redactTask: false,
    baseFiles,
    outcomes: outs,
    testCommand: cmd,
    testTimeoutMs: 500,
    keypair,
    version: "0.1.0",
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 3000, `arbitrate took ${elapsed}ms`);
  assert.equal(verdict.tests?.outcome, "fail");
  assert.equal(verdict.tests?.command, cmd);
  // Past the sleeper's 3s deadline: if the grandchild survived the
  // timeout it would have written the marker by now.
  await new Promise((r) => setTimeout(r, 4000));
  await assert.rejects(readFile(marker, "utf8"), /ENOENT/);
  await rm(markerDir, { recursive: true, force: true });
});

function captureConsoleError(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  return { lines, restore: () => { console.error = orig; } };
}

test("arbitrator: the disclosure line appears when test-pick and the final check run (§9)", async () => {
  const repo = await fixtureRepo({
    "value.txt": "1\n",
    "test.sh": "#!/bin/sh\ngrep -q '^3$' value.txt\n",
  });
  const { outcomes: outs, baseFiles } = await outcomes(repo, [
    new FakeAdapter("fake-a", { files: { "value.txt": "2\n" } }),
    new FakeAdapter("fake-b", { files: { "value.txt": "3\n" } }),
  ]);
  const captured = captureConsoleError();
  try {
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
    assert.equal(verdict.tier, "MAJORITY");
    const disclosures = captured.lines.filter((l) =>
      l.includes("running candidate code unsandboxed"),
    );
    // Once for the test-pick phase, once for the final check.
    assert.equal(disclosures.length, 2);
    for (const line of disclosures) {
      assert.match(line, /use --no-test to skip/);
      assert.match(line, /as \S+/);
    }
  } finally {
    captured.restore();
  }
});

test("arbitrator: testCommand null runs no candidate code and discloses nothing (§9, --no-test)", async () => {
  const repo = await fixtureRepo({ "a.txt": "l1\nl2\n" });
  const { outcomes: outs, baseFiles } = await outcomes(repo, [
    new FakeAdapter("fake-a", { files: { "a.txt": "A\nl2\n" } }),
    new FakeAdapter("fake-b", { files: { "a.txt": "B\nl2\n" } }),
  ]);
  const captured = captureConsoleError();
  try {
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
    assert.equal(verdict.tests, null);
    assert.equal(
      captured.lines.some((l) => l.includes("running candidate code unsandboxed")),
      false,
    );
  } finally {
    captured.restore();
  }
});
