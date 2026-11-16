#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The `tri` command line: run a multi-model jury, verify a verdict,
// show one, or print its merged diff.
//
//   tri run --task <text|@file> [--repo <path>] [--models claude,codex,gemini,grok]
//           [--timeout <ms>] [--budget <minor>] [--global-budget <minor>]
//           [--test-cmd <cmd>] [--no-test]
//           [--redact-task] [--fake] [--dry-run] [--out <path>]
//   tri verify <verdict.json>
//   tri show <verdict.json>
//   tri diff <verdict.json>
//
// Exit codes: 0 success (a verdict was produced, or verification passed),
// 1 usage error / run failure (including tier FAILED — no candidate at
// all), 2 verification failure (`tri verify` on a bad verdict).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { arbitrate } from "./arbitrator.js";
import { getOrCreateKeypair } from "./core/keys.js";
import { appendLog, readVerdict, writeVerdictFile } from "./core/store.js";
import { verifyVerdict } from "./core/verdict.js";
import type { Verdict, VerifyVerdictResult } from "./core/verdict.js";
import { orchestrate } from "./orchestrator.js";
import { ClaudeAdapter } from "./adapters/claude.js";
import { CodexAdapter } from "./adapters/codex.js";
import { GeminiAdapter } from "./adapters/gemini.js";
import { GrokAdapter } from "./adapters/grok.js";
import { FakeAdapter } from "./adapters/fake.js";
import type { JurorAdapter } from "./adapters/types.js";
import { VERSION } from "./version.js";

const ALL_MODELS = ["claude", "codex", "gemini", "grok"] as const;
const DEFAULT_TIMEOUT_MS = 600_000;

const HELP = `triangulate ${VERSION} — a multi-model coding jury.

Usage:
  tri run --task <text|@file> [--repo <path>] [--models claude,codex,gemini,grok]
          [--timeout <ms>] [--budget <minor>] [--global-budget <minor>]
          [--test-cmd <cmd>] [--no-test]
          [--redact-task] [--fake] [--dry-run] [--out <path>]
  tri verify <verdict.json>
  tri show <verdict.json>
  tri diff <verdict.json>
  tri --help | tri --version

Options for run:
  --task <text|@file>   the coding task; @file reads the task from a file (required)
  --repo <path>         target repository (default: current directory)
  --models <list>       comma-separated jurors (default: all four)
  --timeout <ms>        per-juror wall-clock cap (default: 600000)
  --budget <minor>      per-juror cost budget in minor units (0 = no cap)
  --global-budget <minor>  cap on total spend across jurors (0 = no cap);
                        when set, jurors launch one at a time and launching
                        stops once the cumulative reported cost exceeds it;
                        costs the tools do not report cannot be counted
  --test-cmd <cmd>      test command for arbitration (default: auto-detect 'npm test')
  --no-test             skip the test check entirely
  --redact-task         omit the task text from the verdict (hash only)
  --fake                use scripted fake jurors — $0, no model credentials needed
  --dry-run             print the commands that would run, without running them
  --out <path>          verdict output path (default: ./triangulate-verdict.json)

Notes:
  - Each juror works in its own git worktree of the repo; the base is HEAD.
  - Claude, Codex and Gemini run their native CLIs; Grok is an API adapter
    (labelled as such in every verdict). No LLM judges anything: the merge
    is deterministic rules plus the repo's own test command.
  - A verdict is a signed, content-addressed record — agreement is
    evidence, not proof of correctness. See the README's honest limits.
`;

interface RunOptions {
  task: string;
  repo: string;
  models: string[];
  timeoutMs: number;
  budgetMinor: number;
  globalBudgetMinor: number;
  testCommand: string | null;
  noTest: boolean;
  redactTask: boolean;
  fake: boolean;
  dryRun: boolean;
  out: string;
}

function fail(message: string): never {
  console.error(`tri: ${message}`);
  console.error("Run `tri --help` for usage.");
  throw new UsageError(message);
}

class UsageError extends Error {}

function parseRunArgs(args: string[]): RunOptions {
  const opts: RunOptions = {
    task: "",
    repo: process.cwd(),
    models: [...ALL_MODELS],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    budgetMinor: 0,
    globalBudgetMinor: 0,
    testCommand: null,
    noTest: false,
    redactTask: false,
    fake: false,
    dryRun: false,
    out: resolve(process.cwd(), "triangulate-verdict.json"),
  };
  let testCmdGiven = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) break;
    const next = (): string => {
      const value = args[i + 1];
      if (value === undefined) fail(`missing value for ${arg}`);
      i += 1;
      return value;
    };
    if (arg === "--task") opts.task = next();
    else if (arg.startsWith("--task=")) opts.task = arg.slice("--task=".length);
    else if (arg === "--repo") opts.repo = resolve(next());
    else if (arg.startsWith("--repo=")) opts.repo = resolve(arg.slice("--repo=".length));
    else if (arg === "--models") opts.models = next().split(",").map((m) => m.trim()).filter((m) => m.length > 0);
    else if (arg.startsWith("--models=")) opts.models = arg.slice("--models=".length).split(",").map((m) => m.trim()).filter((m) => m.length > 0);
    else if (arg === "--timeout") opts.timeoutMs = Number(next());
    else if (arg.startsWith("--timeout=")) opts.timeoutMs = Number(arg.slice("--timeout=".length));
    else if (arg === "--budget") opts.budgetMinor = Number(next());
    else if (arg.startsWith("--budget=")) opts.budgetMinor = Number(arg.slice("--budget=".length));
    else if (arg === "--global-budget") opts.globalBudgetMinor = Number(next());
    else if (arg.startsWith("--global-budget=")) opts.globalBudgetMinor = Number(arg.slice("--global-budget=".length));
    else if (arg === "--test-cmd") { opts.testCommand = next(); testCmdGiven = true; }
    else if (arg.startsWith("--test-cmd=")) { opts.testCommand = arg.slice("--test-cmd=".length); testCmdGiven = true; }
    else if (arg === "--no-test") opts.noTest = true;
    else if (arg === "--redact-task") opts.redactTask = true;
    else if (arg === "--fake") opts.fake = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--out") opts.out = resolve(next());
    else if (arg.startsWith("--out=")) opts.out = resolve(arg.slice("--out=".length));
    else fail(`unknown option: ${arg}`);
  }
  if (opts.task.length === 0) fail("--task is required");
  if (opts.models.length === 0) fail("--models must name at least one juror");
  for (const model of opts.models) {
    if (!ALL_MODELS.includes(model as (typeof ALL_MODELS)[number])) {
      fail(`unknown model: ${model} (known: ${ALL_MODELS.join(", ")})`);
    }
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) fail("--timeout must be a positive number of ms");
  if (!Number.isFinite(opts.budgetMinor) || opts.budgetMinor < 0) fail("--budget must be >= 0");
  if (!Number.isFinite(opts.globalBudgetMinor) || opts.globalBudgetMinor < 0) fail("--global-budget must be >= 0");
  if (opts.noTest && testCmdGiven) fail("--no-test and --test-cmd conflict");
  return opts;
}

async function resolveTask(taskArg: string): Promise<string> {
  if (!taskArg.startsWith("@")) return taskArg;
  const path = taskArg.slice(1);
  return readFile(path, "utf8");
}

async function detectTestCommand(repo: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(join(repo, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    if (typeof pkg.scripts?.["test"] === "string") return "npm test";
  } catch {
    // No package.json or no test script: no test check.
  }
  return null;
}

function buildAdapters(opts: RunOptions, task: string): JurorAdapter[] {
  if (opts.fake) {
    // Scripted fake jurors: each writes a distinct note file, so the
    // pipeline (worktrees, merge, verdict, log) runs end to end for $0.
    return opts.models.map(
      (id) =>
        new FakeAdapter(`fake-${id}`, {
          files: {
            [`notes/${id}.md`]: `# ${id}\n\nTask: ${task.slice(0, 200)}\n`,
          },
          costMinor: 100,
          modelVersion: `fake-${id}-1.0`,
        }),
    );
  }
  return opts.models.map((id) => {
    switch (id) {
      case "claude":
        return new ClaudeAdapter();
      case "codex":
        return new CodexAdapter();
      case "gemini":
        return new GeminiAdapter();
      case "grok":
        return new GrokAdapter();
      default:
        throw new Error(`unknown model: ${id}`);
    }
  });
}

async function cmdRun(args: string[]): Promise<number> {
  const opts = parseRunArgs(args);
  const task = await resolveTask(opts.task);
  const repo = resolve(opts.repo);
  const testCommand = opts.noTest
    ? null
    : (opts.testCommand ?? (await detectTestCommand(repo)));
  const home = process.env["TRIANGULATE_HOME"] ?? join(homedir(), ".triangulate");

  const adapters = buildAdapters(opts, task);
  if (opts.dryRun) {
    for (const adapter of adapters) {
      const result = await adapter.run({
        task,
        worktree: repo,
        timeoutMs: opts.timeoutMs,
        budgetMinor: opts.budgetMinor,
        env: process.env,
        dryRun: true,
      });
      console.log(`${adapter.id} (${adapter.kind}): ${(result.command ?? []).join(" ")}`);
    }
    return 0;
  }

  // The keypair is created here, not before the dry-run return above:
  // a read-only inspection command must not have a write side effect
  // in ~/.triangulate (N3).
  const keypair = await getOrCreateKeypair(home);

  console.log(`triangulate: running ${adapters.length} juror(s) on ${repo}`);
  const { outcomes, baseFiles } = await orchestrate({
    repo,
    task,
    jurors: adapters,
    timeoutMs: opts.timeoutMs,
    budgetMinor: opts.budgetMinor,
    globalBudgetMinor: opts.globalBudgetMinor,
    env: process.env,
  });
  for (const outcome of outcomes) {
    const cost =
      outcome.result.costMinor === null ? "unknown" : `${outcome.result.costMinor} minor`;
    console.log(
      `  ${outcome.adapter.id}: ${outcome.result.status}` +
        ` (cost ${cost}, ${outcome.result.durationMs} ms)` +
        (outcome.result.reason !== undefined ? ` — ${outcome.result.reason}` : ""),
    );
  }
  const { verdict, mergedFiles } = await arbitrate({
    repo,
    task,
    redactTask: opts.redactTask,
    baseFiles,
    outcomes,
    testCommand,
    testTimeoutMs: Math.min(opts.timeoutMs, 300_000),
    keypair,
    version: VERSION,
  });
  const outPath = await writeVerdictFile(verdict, opts.out);
  await appendLog(verdict, join(home, "log.jsonl"));
  console.log(`tier: ${verdict.tier}`);
  console.log(`verdict: ${verdict.id}`);
  console.log(`written to ${outPath}`);
  if (verdict.merge.conflicts.length > 0) {
    console.log(`conflicts: ${verdict.merge.conflicts.length} (see verdict for both sides)`);
  }
  if (mergedFiles.size > 0 && verdict.tier !== "FAILED") {
    console.log(
      "To apply the merged result to your working tree, review the diff with `tri diff` first.",
    );
  }
  return verdict.tier === "FAILED" ? 1 : 0;
}

/** Load a verdict file, or fail with a clean usage error (never a raw
 * JSON parse stack). */
async function readVerdictOrFail(file: string): Promise<Verdict> {
  try {
    return await readVerdict(resolve(file));
  } catch {
    fail(`cannot read verdict: ${file} (missing, or not valid JSON)`);
  }
}

/**
 * Load a verdict and verify it before any content is shown. `show`
 * and `diff` must not present an unverified verdict as fact (F12):
 * a tampered verdict is refused with exit 2, exactly like `verify`.
 * Returns null on verification failure.
 */
async function loadVerifiedVerdict(file: string): Promise<Verdict | null> {
  const verdict = await readVerdictOrFail(file);
  let result: VerifyVerdictResult;
  try {
    result = verifyVerdict(verdict);
  } catch {
    result = { ok: false, reason: "malformed-verdict" };
  }
  if (!result.ok) {
    console.log(`INVALID  reason=${result.reason ?? "unknown"} file=${file}`);
    return null;
  }
  return verdict;
}

async function cmdVerify(args: string[]): Promise<number> {
  const [file] = args;
  if (file === undefined || args.length !== 1) fail("usage: tri verify <verdict.json>");
  const verdict = await readVerdictOrFail(file);
  // Verification must never throw on malformed input (B3): any throw
  // is INVALID, exit 2 — exactly like loadVerifiedVerdict.
  let result: VerifyVerdictResult;
  try {
    result = verifyVerdict(verdict);
  } catch {
    result = { ok: false, reason: "malformed-verdict" };
  }
  if (result.ok) {
    console.log(`VALID  tier=${verdict.tier} id=${verdict.id}`);
    return 0;
  }
  console.log(`INVALID  reason=${result.reason ?? "unknown"} file=${file}`);
  return 2;
}

async function cmdShow(args: string[]): Promise<number> {
  const [file] = args;
  if (file === undefined || args.length !== 1) fail("usage: tri show <verdict.json>");
  const verdict = await loadVerifiedVerdict(file);
  if (verdict === null) return 2;
  console.log(`triangulate verdict ${verdict.id}`);
  console.log(`  format: ${verdict.format}  tier: ${verdict.tier}  created: ${verdict.created_at}`);
  console.log(
    `  task: ${verdict.task.text ?? `<redacted, hash ${verdict.task.hash?.slice(0, 12) ?? "?"}…>`}`,
  );
  console.log(`  repo: ${verdict.repo.path} (base ${verdict.repo.base})`);
  console.log("  jurors:");
  for (const juror of verdict.jurors) {
    console.log(
      `    ${juror.id} (${juror.adapter}, ${juror.model}): ${juror.status}, ` +
        `cost ${juror.costMinor === null ? "unknown" : `${juror.costMinor} minor`}, ` +
        `${juror.durationMs} ms` +
        (juror.reason !== undefined ? ` — ${juror.reason}` : ""),
    );
  }
  console.log(
    `  merge: ${verdict.merge.conflicts.length} conflict(s), ${verdict.merge.dropped.length} dropped hunk(s)` +
      (verdict.merge.astRefined !== undefined && verdict.merge.astRefined.length > 0
        ? `, AST-refined: ${verdict.merge.astRefined.join(", ")}`
        : ""),
  );
  if (verdict.tests !== null) {
    console.log(
      `  tests: ${verdict.tests.outcome} (command: ${verdict.tests.command}, exit ${verdict.tests.exitCode}, flaky: ${verdict.tests.flaky})`,
    );
  } else {
    console.log("  tests: not run");
  }
  if (verdict.dissent.length > 0) {
    console.log("  dissent:");
    for (const entry of verdict.dissent) {
      console.log(`    ${entry.kind}${entry.juror !== undefined ? ` (${entry.juror})` : ""}: ${entry.note}`);
    }
  }
  return 0;
}

async function cmdDiff(args: string[]): Promise<number> {
  const [file] = args;
  if (file === undefined || args.length !== 1) fail("usage: tri diff <verdict.json>");
  const verdict = await loadVerifiedVerdict(file);
  if (verdict === null) return 2;
  if (verdict.merge.diff.length === 0) {
    console.log("(no merged diff — the run produced no merge)");
    return 0;
  }
  process.stdout.write(verdict.merge.diff);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    console.log(HELP);
    return 0;
  }
  if (command === "--version" || command === "-V") {
    console.log(`triangulate ${VERSION}`);
    return 0;
  }
  try {
    switch (command) {
      case "run":
        return await cmdRun(rest);
      case "verify":
        return await cmdVerify(rest);
      case "show":
        return await cmdShow(rest);
      case "diff":
        return await cmdDiff(rest);
      default:
        fail(`unknown command: ${command}`);
    }
  } catch (error) {
    // fail() already printed the message; anything else is unexpected.
    if (!(error instanceof UsageError)) {
      console.error(`tri: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
