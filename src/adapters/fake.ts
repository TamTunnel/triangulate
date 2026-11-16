// SPDX-License-Identifier: Apache-2.0
// Fake juror adapter — the deliberate pattern: scripted behavior, $0,
// fully deterministic, so the whole workflow (worktrees, merge,
// arbitrator, verdict) is testable without model credentials or network.
// The fake writes files into its worktree itself; the orchestrator then
// captures the diff with git, exactly as it does for real jurors.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JurorAdapter, JurorRunInput, JurorRunResult } from "./types.js";

export type FakeBehavior =
  | "pass" // apply the script, exit 0
  | "fail" // exit non-zero without touching the tree
  | "timeout" // sleep past the timeout (the orchestrator kills it)
  | "budget"; // exceed the cost budget mid-run (orchestrator aborts)

export interface FakeScript {
  /** Relative path -> new content (null = delete the file). */
  files: Record<string, string | null>;
  /** Cost to report, in minor units. Defaults to 100. */
  costMinor?: number;
  behavior?: FakeBehavior;
  /** Model string to report. Defaults to "fake-1.0". */
  modelVersion?: string;
}

export class FakeAdapter implements JurorAdapter {
  readonly id: string;
  readonly kind = "cli" as const;
  private readonly script: FakeScript;

  constructor(id: string, script: FakeScript) {
    this.id = id;
    this.script = script;
  }

  async run(input: JurorRunInput): Promise<JurorRunResult> {
    const started = Date.now();
    const behavior = this.script.behavior ?? "pass";
    const duration = (): number => Date.now() - started;

    if (input.dryRun === true) {
      return {
        status: "ok",
        costMinor: 0,
        durationMs: 0,
        modelVersion: this.script.modelVersion ?? "fake-1.0",
        stdout: "",
        stderr: "",
        command: ["fake", this.id, "--task", input.task.slice(0, 80)],
      };
    }

    if (behavior === "timeout") {
      // Sleep past the timeout; the orchestrator's kill is what records
      // the timeout. Sleep in small slices so a kill lands promptly.
      const until = Date.now() + input.timeoutMs + 500;
      while (Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return {
        status: "timeout",
        costMinor: null,
        durationMs: duration(),
        modelVersion: this.script.modelVersion ?? "fake-1.0",
        stdout: "",
        stderr: "",
        reason: "fake juror exceeded its timeout",
      };
    }

    if (behavior === "fail") {
      return {
        status: "failed",
        costMinor: null,
        durationMs: duration(),
        modelVersion: this.script.modelVersion ?? "fake-1.0",
        stdout: "",
        stderr: "fake juror failed (scripted)",
        reason: "fake juror failed (scripted)",
      };
    }

    if (behavior === "budget") {
      // Exceed the budget before doing any work: the run is aborted and
      // recorded as budget, with no candidate produced.
      return {
        status: "budget",
        costMinor: (input.budgetMinor > 0 ? input.budgetMinor : 100) + 1,
        durationMs: duration(),
        modelVersion: this.script.modelVersion ?? "fake-1.0",
        stdout: "",
        stderr: "",
        reason: "fake juror exceeded its cost budget",
      };
    }

    for (const [relative, content] of Object.entries(this.script.files)) {
      const target = join(input.worktree, relative);
      if (content === null) {
        await rm(target, { force: true });
      } else {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
      }
    }
    return {
      status: "ok",
      costMinor: this.script.costMinor ?? 100,
      durationMs: duration(),
      modelVersion: this.script.modelVersion ?? "fake-1.0",
      stdout: `fake ${this.id}: applied ${Object.keys(this.script.files).length} file change(s)`,
      stderr: "",
    };
  }
}
