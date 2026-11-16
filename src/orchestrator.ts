// SPDX-License-Identifier: Apache-2.0
// Orchestrator: runs one juror per model in its own git worktree of the
// target repo, captures each candidate as a full file snapshot, and
// returns the outcomes for the arbitrator. The worktree is a capture
// boundary, not a sandbox (S-4): a juror subprocess runs with the
// user's full privileges and can read or write outside its worktree,
// but the candidate diff is computed from that worktree alone, so an
// escape write is never captured or merged. Symlinks are never
// followed during capture (F1): a symlinked file is recorded as
// skipped, never read. Adapters must honor timeoutMs themselves (CLI
// adapters kill their subprocess; Grok aborts its fetch); the
// orchestrator's race is a backstop that records the timeout even if
// an adapter misbehaves.

import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { diffHash, renderUnifiedDiff } from "./differ.js";
import type { FileMap } from "./differ.js";
import { redactSecrets } from "./adapters/types.js";
import type { JurorAdapter, JurorRunResult } from "./adapters/types.js";

const execFileAsync = promisify(execFile);

export interface JurorOutcome {
  adapter: JurorAdapter;
  result: JurorRunResult;
  /** Full post-run snapshot: base files with this juror's changes applied. Empty when not ok. */
  files: FileMap;
  /** Unified diff of this candidate against the base, or "" when no changes. */
  diff: string;
  diffHash: string;
  /** Binary files the juror changed (excluded from the text merge, disclosed in the verdict). */
  binaryChanges: string[];
  /** Symlinked paths the juror created/changed: never followed during
   * capture (F1), disclosed in the verdict instead of read. */
  skippedChanges: string[];
}

export interface OrchestratorResult {
  outcomes: JurorOutcome[];
  baseFiles: FileMap;
}

export interface OrchestratorOptions {
  repo: string;
  task: string;
  jurors: JurorAdapter[];
  timeoutMs: number;
  /** Per-juror cost budget in minor units (0 = no cap). */
  budgetMinor: number;
  /** Global cost budget across all jurors in minor units (0 = no cap).
   * When set, jurors launch sequentially and launching stops once the
   * cumulative reported cost exceeds it (A-2); costs the tools do not
   * report (null) cannot be counted toward the cap. */
  globalBudgetMinor?: number;
  env: NodeJS.ProcessEnv;
  dryRun?: boolean;
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192);
  return sample.includes(0);
}

async function snapshotHead(repo: string): Promise<FileMap> {
  const listing = await git(repo, ["ls-tree", "-r", "-z", "--name-only", "HEAD"]);
  const names = listing.split("\0").filter((name) => name.length > 0);
  const files: FileMap = new Map();
  await Promise.all(
    names.map(async (name) => {
      const { stdout } = await execFileAsync("git", ["-C", repo, "show", `HEAD:${name}`], {
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
      });
      const buffer = stdout as unknown as Buffer;
      if (isBinary(buffer)) return; // binary files are outside the text merge (v1 limit)
      files.set(name, buffer.toString("utf8"));
    }),
  );
  return files;
}

function renderDiff(base: FileMap, candidate: FileMap): string {
  const parts: string[] = [];
  const names = new Set([...base.keys(), ...candidate.keys()]);
  for (const name of [...names].sort()) {
    const oldContent = base.get(name);
    const newContent = candidate.get(name);
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

async function runJuror(
  adapter: JurorAdapter,
  opts: OrchestratorOptions,
  repo: string,
  root: string,
  baseFiles: FileMap,
): Promise<JurorOutcome> {
  const worktree = join(root, adapter.id);
  const empty: JurorOutcome = {
    adapter,
    result: {
      status: "failed",
      costMinor: null,
      durationMs: 0,
      modelVersion: "unknown",
      stdout: "",
      stderr: "",
    },
    files: new Map(),
    diff: "",
    diffHash: diffHash(""),
    binaryChanges: [],
    skippedChanges: [],
  };
  try {
    await git(repo, ["worktree", "add", worktree, "HEAD"]);
  } catch (error) {
    empty.result.reason = `could not create worktree: ${redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 200)}`;
    return empty;
  }
  try {
    await writeFile(join(worktree, ".triangulate-task.md"), opts.task, "utf8");
    const started = Date.now();
    const runPromise = adapter
      .run({
        task: opts.task,
        worktree,
        timeoutMs: opts.timeoutMs,
        budgetMinor: opts.budgetMinor,
        env: opts.env,
        ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
      })
      .catch((error: unknown): JurorRunResult => ({
        status: "failed",
        costMinor: null,
        durationMs: Date.now() - started,
        modelVersion: "unknown",
        stdout: "",
        stderr: "",
        reason: `adapter threw: ${redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
      }));
    const timeoutPromise = new Promise<JurorRunResult>((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          status: "timeout",
          costMinor: null,
          durationMs: Date.now() - started,
          modelVersion: "unknown",
          stdout: "",
          stderr: "",
          reason: `${adapter.id} juror exceeded its timeout`,
        });
      }, opts.timeoutMs);
      // Unref: the timer must not keep the process alive after the run
      // finished — it is a backstop, not work. (A stuck adapter keeps
      // the loop alive through its own handles, so the timer still fires.)
      timer.unref();
    });
    const result = await Promise.race([runPromise, timeoutPromise]);
    await rm(join(worktree, ".triangulate-task.md"), { force: true });

    // Per-juror cost budget: CLI adapters cannot observe cost mid-run,
    // so the budget is enforced here at completion (A-1). The candidate
    // is excluded from the merge; the cost is still recorded.
    if (
      result.status === "ok" &&
      result.costMinor !== null &&
      opts.budgetMinor > 0 &&
      result.costMinor > opts.budgetMinor
    ) {
      return {
        adapter,
        result: {
          ...result,
          status: "budget",
          reason: `cost ${result.costMinor} minor exceeds budget ${opts.budgetMinor}`,
        },
        files: new Map(),
        diff: "",
        diffHash: diffHash(""),
        binaryChanges: [],
        skippedChanges: [],
      };
    }
    if (result.status !== "ok") {
      return { ...empty, result };
    }

    // Capture the candidate: git status in the worktree, then apply the
    // changes onto a copy of the base snapshot. --untracked-files=all
    // lists untracked files individually (without it, an untracked
    // directory is reported as one entry and readFile would EISDIR).
    // A capture failure records this juror as failed instead of
    // rejecting the whole run — one bad juror must never take down
    // the run (F3).
    try {
      const status = await git(worktree, ["status", "--porcelain", "-z", "--untracked-files=all"]);
      const files: FileMap = new Map(baseFiles);
      const binaryChanges: string[] = [];
      const skippedChanges: string[] = [];
      const entries = status.split("\0").filter((line) => line.length > 0);
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        if (entry === undefined) break;
        const code = entry.slice(0, 2);
        const path = entry.slice(3);
        if (code[0] === "R") {
          // Rename: the next -z entry is the old path.
          const oldPath = entries[i + 1];
          i += 1;
          if (oldPath !== undefined) files.delete(oldPath);
        }
        if (code.includes("D")) {
          files.delete(path);
          continue;
        }
        // Never follow a symlink out of the worktree (F1): a juror
        // that links to a file outside the repo must not get its
        // contents into the candidate, the diff, or the verdict.
        const target = join(worktree, path);
        const st = await lstat(target);
        if (st.isSymbolicLink()) {
          skippedChanges.push(path);
          continue;
        }
        const buffer = await readFile(target);
        if (isBinary(buffer)) {
          binaryChanges.push(path);
          continue;
        }
        files.set(path, buffer.toString("utf8"));
      }
      const diff = renderDiff(baseFiles, files);
      return { adapter, result, files, diff, diffHash: diffHash(diff), binaryChanges, skippedChanges };
    } catch (error) {
      return {
        ...empty,
        result: {
          ...result,
          status: "failed",
          reason: `capture failed: ${redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
        },
      };
    }
  } finally {
    try {
      await git(repo, ["worktree", "remove", "--force", worktree]);
    } catch {
      await rm(worktree, { recursive: true, force: true });
    }
  }
}

export async function orchestrate(opts: OrchestratorOptions): Promise<OrchestratorResult> {
  // The target must be a git repository; the base is HEAD.
  try {
    await git(opts.repo, ["rev-parse", "--git-dir"]);
  } catch {
    throw new Error(`not a git repository: ${opts.repo}`);
  }
  const baseFiles = await snapshotHead(opts.repo);
  const root = await mkdtemp(join(tmpdir(), "triangulate-"));
  try {
    const globalBudget = opts.globalBudgetMinor ?? 0;
    if (globalBudget > 0) {
      // Global budget (A-2): jurors launch one at a time so the
      // cumulative reported cost is known before the next launch.
      // Once it exceeds the cap, the remaining jurors are recorded as
      // `budget` (never run) and the verdict records the partial
      // state. Costs the tools do not report (null) cannot be counted.
      const outcomes: JurorOutcome[] = [];
      let cumulative = 0;
      for (const adapter of opts.jurors) {
        if (cumulative > globalBudget) {
          outcomes.push({
            adapter,
            result: {
              status: "budget",
              costMinor: null,
              durationMs: 0,
              modelVersion: "unknown",
              stdout: "",
              stderr: "",
              reason: `not run: global budget ${globalBudget} minor exceeded (cumulative reported cost ${cumulative} minor)`,
            },
            files: new Map(),
            diff: "",
            diffHash: diffHash(""),
            binaryChanges: [],
            skippedChanges: [],
          });
          continue;
        }
        const outcome = await runJuror(adapter, opts, opts.repo, root, baseFiles);
        outcomes.push(outcome);
        if (outcome.result.costMinor !== null) cumulative += outcome.result.costMinor;
      }
      return { outcomes, baseFiles };
    }
    const outcomes = await Promise.all(
      opts.jurors.map((adapter) => runJuror(adapter, opts, opts.repo, root, baseFiles)),
    );
    return { outcomes, baseFiles };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
