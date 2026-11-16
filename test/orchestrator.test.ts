// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orchestrate } from "../src/orchestrator.js";
import { FakeAdapter } from "../src/adapters/fake.js";
import type { JurorAdapter, JurorRunResult } from "../src/adapters/types.js";

async function fixtureRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tri-repo-"));
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  };
  git("init", "-b", "master");
  git("config", "user.email", "test@local");
  git("config", "user.name", "Test");
  await writeFile(join(dir, "a.txt"), "l1\nl2\nl3\n", "utf8");
  await writeFile(join(dir, "b.txt"), "x\ny\n", "utf8");
  git("add", ".");
  git("commit", "-m", "init");
  return dir;
}

test("orchestrator: two fake jurors run in parallel, diffs captured, worktrees cleaned", async () => {
  const repo = await fixtureRepo();
  const result = await orchestrate({
    repo,
    task: "change a line",
    jurors: [
      new FakeAdapter("fake-a", { files: { "a.txt": "L1\nl2\nl3\n" } }),
      new FakeAdapter("fake-b", { files: { "b.txt": "x\nY\n" } }),
    ],
    timeoutMs: 10_000,
    budgetMinor: 0,
    env: {},
  });
  assert.equal(result.baseFiles.get("a.txt"), "l1\nl2\nl3\n");
  assert.equal(result.outcomes.length, 2);
  const a = result.outcomes.find((o) => o.adapter.id === "fake-a") as NonNullable<
    (typeof result.outcomes)[number]
  >;
  assert.equal(a.result.status, "ok");
  assert.equal(a.files.get("a.txt"), "L1\nl2\nl3\n");
  assert.match(a.diff, /-l1\n\+L1/);
  assert.equal(a.diffHash.length, 64);
  const b = result.outcomes.find((o) => o.adapter.id === "fake-b") as NonNullable<
    (typeof result.outcomes)[number]
  >;
  assert.equal(b.files.get("b.txt"), "x\nY\n");
  // Worktrees are gone and the base repo is untouched.
  const worktrees = execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" });
  assert.equal(worktrees.trim().split("\n").length, 1);
  const status = execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" });
  assert.equal(status, "");
});

test("orchestrator: S-4 — an escape write outside the worktree is never captured", async () => {
  const repo = await fixtureRepo();
  // A rigged adapter that writes into the base repo by absolute path and
  // outside its worktree, plus one legitimate edit inside it.
  class EscapeAdapter implements JurorAdapter {
    readonly id = "escape";
    readonly kind = "cli" as const;
    async run(input: { worktree: string }): Promise<JurorRunResult> {
      await writeFile(join(repo, "pwned.txt"), "escaped", "utf8");
      await writeFile(join(input.worktree, "..", "outside.txt"), "escaped", "utf8");
      await writeFile(join(input.worktree, "a.txt"), "PWNED\nl2\nl3\n", "utf8");
      return {
        status: "ok",
        costMinor: 0,
        durationMs: 1,
        modelVersion: "fake",
        stdout: "",
        stderr: "",
      };
    }
  }
  const result = await orchestrate({
    repo,
    task: "escape",
    jurors: [new EscapeAdapter()],
    timeoutMs: 10_000,
    budgetMinor: 0,
    env: {},
  });
  const outcome = result.outcomes[0];
  assert.ok(outcome !== undefined);
  assert.equal(outcome.result.status, "ok");
  // The legitimate in-worktree edit IS captured...
  assert.equal(outcome.files.get("a.txt"), "PWNED\nl2\nl3\n");
  // ...but neither escape file is.
  assert.equal(outcome.files.has("pwned.txt"), false);
  assert.equal(outcome.files.has("outside.txt"), false);
  assert.equal(outcome.diff.includes("pwned"), false);
  // The base repo's tracked files are unchanged.
  assert.equal(await readFile(join(repo, "a.txt"), "utf8"), "l1\nl2\nl3\n");
});

test("orchestrator: budget, timeout, and failure are recorded, never retried silently", async () => {
  const repo = await fixtureRepo();
  const result = await orchestrate({
    repo,
    task: "t",
    jurors: [
      new FakeAdapter("over", { files: { "a.txt": "X\n" }, costMinor: 600 }),
      new FakeAdapter("slow", { files: {}, behavior: "timeout" }),
      new FakeAdapter("bad", { files: {}, behavior: "fail" }),
    ],
    timeoutMs: 200,
    budgetMinor: 500,
    env: {},
  });
  const byId = new Map(result.outcomes.map((o) => [o.adapter.id, o]));
  assert.equal(byId.get("over")?.result.status, "budget");
  assert.equal(byId.get("over")?.files.size, 0);
  assert.equal(byId.get("slow")?.result.status, "timeout");
  assert.equal(byId.get("bad")?.result.status, "failed");
});

test("orchestrator: not a git repo throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tri-nogit-"));
  await assert.rejects(
    orchestrate({
      repo: dir,
      task: "t",
      jurors: [new FakeAdapter("f", { files: {} })],
      timeoutMs: 1000,
      budgetMinor: 0,
      env: {},
    }),
    /not a git repository/,
  );
});
