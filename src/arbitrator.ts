// SPDX-License-Identifier: Apache-2.0
// Arbitrator: turns juror outcomes into a signed verdict. The merge is
// deterministic rules (the differ) plus the repo's own test command —
// never an LLM, never a vote, never a model's synthesis (assessment §5).
// Test-pick: when a conflict survives the rules, each side is applied to
// the BASE file in isolation and the repo's tests are run; a side that
// passes twice wins, and the win is recorded with rule "tests". A test
// result never changes the tier (D-5): the tier describes the merge,
// the test record describes the check.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { mergeCandidates, renderUnifiedDiff } from "./differ.js";
import type { ConflictRecord as DifferConflict, FileMap } from "./differ.js";
import { signVerdict, taskHash } from "./core/verdict.js";
import type {
  CandidateRecord,
  ConflictRecord,
  DissentEntry,
  JurorRecord,
  TestRecord,
  Verdict,
  VerdictPayload,
  VerdictTier,
} from "./core/verdict.js";
import { canonicalHash } from "./core/jcs.js";
import type { Keypair } from "./core/jws.js";
import { redactSecrets, truncateOutput } from "./adapters/types.js";
import type { JurorOutcome } from "./orchestrator.js";

const execFileAsync = promisify(execFile);

/** Test-pick is only attempted when the conflict count is this small (bounds test runs). */
export const MAX_TEST_PICK_CONFLICTS = 3;

export interface ArbitrateOptions {
  repo: string;
  task: string;
  redactTask: boolean;
  baseFiles: FileMap;
  outcomes: JurorOutcome[];
  /** The repo's test command, or null for no test check. */
  testCommand: string | null;
  testTimeoutMs: number;
  keypair: Keypair;
  version: string;
}

export interface ArbitrateResult {
  verdict: Verdict;
  /** The merged file set (base files with the merge applied). Empty when FAILED. */
  mergedFiles: FileMap;
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

interface TestRun {
  exitCode: number | null;
  outputHash: string;
  passed: boolean;
  timedOut: boolean;
}

/** Run the repo's test command in a disposable worktree holding `files`. */
async function runTestsInWorktree(
  repo: string,
  files: FileMap,
  baseFiles: FileMap,
  command: string,
  timeoutMs: number,
): Promise<TestRun> {
  const root = await mkdtemp(join(tmpdir(), "triangulate-test-"));
  const worktree = join(root, "wt");
  try {
    await git(repo, ["worktree", "add", worktree, "HEAD"]);
    for (const [name, content] of files) {
      const target = join(worktree, name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    for (const name of baseFiles.keys()) {
      if (!files.has(name)) {
        await rm(join(worktree, name), { force: true });
      }
    }
    const started = Date.now();
    let exitCode: number | null = null;
    let output = "";
    let timedOut = false;
    try {
      const { stdout, stderr } = await execFileAsync("sh", ["-c", command], {
        cwd: worktree,
        timeout: timeoutMs,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      output = `${stdout}\n${stderr}`;
      exitCode = 0;
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number;
        killed?: boolean;
      };
      output = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
      if (typeof err.code === "number") exitCode = err.code;
      timedOut = err.killed === true || (Date.now() - started >= timeoutMs && exitCode === null);
    }
    const truncated = truncateOutput(output);
    return {
      exitCode,
      outputHash: canonicalHash(truncated),
      passed: exitCode === 0,
      timedOut,
    };
  } finally {
    try {
      await git(repo, ["worktree", "remove", "--force", worktree]);
    } catch {
      await rm(worktree, { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
}

/** Apply one conflict side to the base file, in isolation (no markers). */
function applySideToBase(
  baseFiles: FileMap,
  conflict: DifferConflict,
  juror: string,
): FileMap {
  const out: FileMap = new Map(baseFiles);
  const side = conflict.sides[juror] ?? [];
  if (conflict.baseLines === null) {
    // Whole-file conflict: the side's lines are the whole file.
    if (side.length === 0) out.delete(conflict.file);
    else out.set(conflict.file, side.join("\n"));
    return out;
  }
  const base = baseFiles.get(conflict.file);
  if (base === undefined) return out;
  const lines = base.split("\n");
  // baseLines is a 1-based inclusive range; the 0-based exclusive end is
  // the same number, so only the start is shifted.
  const start = conflict.baseLines.start - 1;
  const end = conflict.baseLines.end;
  lines.splice(start, end - start, ...side);
  out.set(conflict.file, lines.join("\n"));
  return out;
}

function renderDiff(base: FileMap, merged: FileMap): string {
  const parts: string[] = [];
  const names = new Set([...base.keys(), ...merged.keys()]);
  for (const name of [...names].sort()) {
    const oldContent = base.get(name);
    const newContent = merged.get(name);
    if (oldContent === newContent) continue;
    parts.push(
      renderUnifiedDiff(
        name,
        oldContent === undefined ? [] : oldContent.split("\n"),
        newContent === undefined ? [] : newContent.split("\n"),
      ),
    );
  }
  return parts.join("");
}

function toVerdictConflict(conflict: DifferConflict): ConflictRecord {
  return {
    file: conflict.file,
    baseLines: conflict.baseLines,
    sides: conflict.sides,
    rule: conflict.rule,
    ...(conflict.winner !== undefined ? { winner: conflict.winner } : {}),
  };
}

export async function arbitrate(opts: ArbitrateOptions): Promise<ArbitrateResult> {
  const okOutcomes = opts.outcomes.filter((o) => o.result.status === "ok");
  const jurors: JurorRecord[] = opts.outcomes.map((o) => ({
    id: o.adapter.id,
    model: o.result.modelVersion,
    adapter: o.adapter.kind,
    status: o.result.status,
    costMinor: o.result.costMinor,
    durationMs: o.result.durationMs,
    candidateHash: o.result.status === "ok" ? o.diffHash : null,
    ...(o.result.reason !== undefined ? { reason: redactSecrets(o.result.reason) } : {}),
  }));
  const candidates: CandidateRecord[] = okOutcomes.map((o) => ({
    juror: o.adapter.id,
    diff: o.diff,
    hash: o.diffHash,
    ...(o.binaryChanges.length > 0 ? { binaryChanges: o.binaryChanges } : {}),
  }));

  // No juror produced a candidate: the run failed outright.
  if (okOutcomes.length === 0) {
    const payload: VerdictPayload = {
      format: "triangulate/1",
      created_at: new Date().toISOString(),
      tool: { name: "triangulate", version: opts.version },
      task: {
        ...(opts.redactTask ? {} : { text: opts.task }),
        hash: taskHash(opts.task),
      },
      repo: { path: opts.repo, base: "HEAD" },
      jurors,
      candidates: [],
      merge: { diff: "", conflicts: [], dropped: [] },
      tests: null,
      tier: "FAILED",
      dissent: opts.outcomes.map((o) => ({
        kind: `juror-${o.result.status}`,
        juror: o.adapter.id,
        note: o.result.reason ?? o.result.status,
      })),
      signer: {
        publicKey: opts.keypair.publicKey,
        kid: opts.keypair.kid,
      },
    };
    return { verdict: signVerdict(payload, opts.keypair), mergedFiles: new Map() };
  }

  // First pass: deterministic rules only.
  let merge = mergeCandidates(
    opts.baseFiles,
    okOutcomes.map((o) => ({ juror: o.adapter.id, files: o.files })),
  );
  const firstOutcome = okOutcomes[0];
  const allIdentical =
    okOutcomes.length > 1 &&
    firstOutcome !== undefined &&
    okOutcomes.every((o) => o.diffHash === firstOutcome.diffHash);

  // Test-pick: only when the rules left a small number of conflicts and
  // a test command exists. Each side is tested in isolation on the base.
  if (merge.conflicts.length > 0 && merge.conflicts.length <= MAX_TEST_PICK_CONFLICTS && opts.testCommand !== null) {
    const choices = new Map<string, string>();
    for (const conflict of merge.conflicts) {
      // The differ keys choices by 0-based base coordinates; the conflict
      // record stores a 1-based inclusive range, so the start shifts by
      // one and the end (exclusive in 0-based terms) stays the same.
      const key =
        conflict.baseLines === null
          ? `${conflict.file}:whole`
          : `${conflict.file}:${conflict.baseLines.start - 1}:${conflict.baseLines.end}`;
      const sideIds = Object.keys(conflict.sides).sort();
      let winner: string | null = null;
      for (const sideId of sideIds) {
        const variant = applySideToBase(opts.baseFiles, conflict, sideId);
        const first = await runTestsInWorktree(
          opts.repo,
          variant,
          opts.baseFiles,
          opts.testCommand,
          opts.testTimeoutMs,
        );
        if (!first.passed) continue;
        // Confirm: a side that passes once must pass a second time (D-5).
        const second = await runTestsInWorktree(
          opts.repo,
          variant,
          opts.baseFiles,
          opts.testCommand,
          opts.testTimeoutMs,
        );
        if (second.passed) {
          winner = sideId;
          break;
        }
      }
      if (winner !== null) choices.set(key, winner);
    }
    if (choices.size > 0) {
      merge = mergeCandidates(
        opts.baseFiles,
        okOutcomes.map((o) => ({ juror: o.adapter.id, files: o.files })),
        { choices },
      );
    }
  }

  // A conflict record with a rule is a *resolved* disagreement (the
  // differ records test-pick wins there); only "unresolved" conflicts
  // make the run DIVERGED.
  const unresolved = merge.conflicts.filter((c) => c.rule === "unresolved");
  const tier: VerdictTier =
    unresolved.length > 0 ? "DIVERGED" : allIdentical ? "UNANIMOUS" : "MAJORITY";
  const mergedDiff = renderDiff(opts.baseFiles, merge.merged);

  // Final test check on the merged result (recorded, never tier-changing — D-5).
  // The FAILED path returned earlier, so tier is one of the merge tiers here.
  let tests: TestRecord | null = null;
  if (opts.testCommand !== null) {
    const first = await runTestsInWorktree(
      opts.repo,
      merge.merged,
      opts.baseFiles,
      opts.testCommand,
      opts.testTimeoutMs,
    );
    let flaky = false;
    let outcome: TestRecord["outcome"] = first.passed ? "pass" : "fail";
    let exitCode = first.exitCode;
    let outputHash = first.outputHash;
    if (!first.passed && !first.timedOut) {
      const second = await runTestsInWorktree(
        opts.repo,
        merge.merged,
        opts.baseFiles,
        opts.testCommand,
        opts.testTimeoutMs,
      );
      if (second.passed) {
        flaky = true;
        outcome = "flaky";
        exitCode = second.exitCode;
        outputHash = second.outputHash;
      }
    }
    tests = { command: opts.testCommand, exitCode, outputHash, flaky, outcome };
  }

  // Dissent: every disagreement that survived into the verdict, as facts.
  const dissent: DissentEntry[] = [];
  for (const conflict of merge.conflicts) {
    dissent.push({
      kind: "conflict",
      file: conflict.file,
      note:
        conflict.rule === "unresolved"
          ? `unresolved conflict between ${Object.keys(conflict.sides).sort().join(", ")}`
          : `conflict between ${Object.keys(conflict.sides).sort().join(", ")} resolved by rule ${conflict.rule}${conflict.winner !== undefined ? `, winner ${conflict.winner}` : ""}`,
    });
  }
  for (const dropped of merge.dropped) {
    dissent.push({
      kind: "dropped-hunk",
      juror: dropped.juror,
      file: dropped.file,
      note: `hunk dropped by rule ${dropped.rule}: ${dropped.detail}`,
    });
  }
  for (const outcome of opts.outcomes) {
    if (outcome.result.status !== "ok") {
      dissent.push({
        kind: `juror-${outcome.result.status}`,
        juror: outcome.adapter.id,
        note: outcome.result.reason ?? outcome.result.status,
      });
    }
  }

  const payload: VerdictPayload = {
    format: "triangulate/1",
    created_at: new Date().toISOString(),
    tool: { name: "triangulate", version: opts.version },
    task: {
      ...(opts.redactTask ? {} : { text: opts.task }),
      hash: taskHash(opts.task),
    },
    repo: { path: opts.repo, base: "HEAD" },
    jurors,
    candidates,
    merge: {
      diff: mergedDiff,
      conflicts: merge.conflicts.map(toVerdictConflict),
      dropped: merge.dropped,
      ...(merge.astRefined.length > 0 ? { astRefined: merge.astRefined } : {}),
    },
    tests,
    tier,
    dissent,
    signer: { publicKey: opts.keypair.publicKey, kid: opts.keypair.kid },
  };
  return { verdict: signVerdict(payload, opts.keypair), mergedFiles: merge.merged };
}
