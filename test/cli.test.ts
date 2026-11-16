// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.js";

// All CLI tests run with an isolated home so keys and the log never
// touch the real ~/.triangulate.
const TEST_HOME = await mkdtemp(join(tmpdir(), "tri-cli-home-"));
process.env["TRIANGULATE_HOME"] = TEST_HOME;

async function fixtureRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tri-cli-"));
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  };
  git("init", "-b", "master");
  git("config", "user.email", "test@local");
  git("config", "user.name", "Test");
  await writeFile(join(dir, "a.txt"), "l1\nl2\n", "utf8");
  git("add", ".");
  git("commit", "-m", "init");
  return dir;
}

test("cli: --help and --version exit 0", async () => {
  assert.equal(await main(["--help"]), 0);
  assert.equal(await main(["--version"]), 0);
});

test("cli: run with --fake produces a signed verdict file and exit 0", async () => {
  const repo = await fixtureRepo();
  const out = join(repo, "verdict.json");
  const code = await main([
    "run",
    "--task",
    "add a note",
    "--repo",
    repo,
    "--models",
    "claude,codex",
    "--fake",
    "--no-test",
    "--out",
    out,
  ]);
  assert.equal(code, 0);
  const verdict = JSON.parse(await readFile(out, "utf8")) as {
    id: string;
    tier: string;
    format: string;
  };
  assert.equal(verdict.format, "triangulate/1");
  assert.equal(verdict.tier, "MAJORITY");
  assert.equal(verdict.id.length, 64);
  // The verdict verifies, and the log was appended in the test home.
  assert.equal(await main(["verify", out]), 0);
  const log = await readFile(join(TEST_HOME, "log.jsonl"), "utf8");
  assert.ok(log.includes(verdict.id));
});

test("cli: verify rejects a tampered verdict with exit 2", async () => {
  const repo = await fixtureRepo();
  const out = join(repo, "verdict.json");
  await main([
    "run",
    "--task",
    "add a note",
    "--repo",
    repo,
    "--models",
    "claude",
    "--fake",
    "--no-test",
    "--out",
    out,
  ]);
  const verdict = JSON.parse(await readFile(out, "utf8")) as Record<string, unknown>;
  verdict["tier"] = "UNANIMOUS";
  await writeFile(out, JSON.stringify(verdict), "utf8");
  assert.equal(await main(["verify", out]), 2);
});

test("cli: show and diff print the verdict", async () => {
  const repo = await fixtureRepo();
  const out = join(repo, "verdict.json");
  await main([
    "run",
    "--task",
    "add a note",
    "--repo",
    repo,
    "--models",
    "claude",
    "--fake",
    "--no-test",
    "--out",
    out,
  ]);
  assert.equal(await main(["show", out]), 0);
  assert.equal(await main(["diff", out]), 0);
});

test("cli: --dry-run prints commands without running them", async () => {
  const repo = await fixtureRepo();
  const code = await main([
    "run",
    "--task",
    "add a note",
    "--repo",
    repo,
    "--models",
    "claude,codex,gemini,grok",
    "--dry-run",
  ]);
  assert.equal(code, 0);
});

test("cli: unknown model and missing task are usage errors (exit 1)", async () => {
  const repo = await fixtureRepo();
  assert.equal(await main(["run", "--task", "x", "--models", "nope", "--repo", repo]), 1);
  assert.equal(await main(["run", "--repo", repo]), 1);
  assert.equal(await main(["frobnicate"]), 1);
});
