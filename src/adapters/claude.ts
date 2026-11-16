// SPDX-License-Identifier: Apache-2.0
// Claude juror: drives the Claude Code CLI non-interactively.
// Command verified against Claude Code's documented print mode:
//   claude -p <task> --output-format json --dangerously-skip-permissions
// The CLI runs inside the juror's worktree; the orchestrator captures
// the diff with git afterwards. Cost comes from the JSON output's
// total_cost_usd; when the tool does not report it, cost is "unknown"
// (never invented). This adapter was NOT run against a real Claude Code
// binary here (not installed, no key) — see --dry-run.

import { failureReason, runCommand } from "./spawn.js";
import { scopedEnv } from "./types.js";
import type { JurorAdapter, JurorRunInput, JurorRunResult } from "./types.js";

export class ClaudeAdapter implements JurorAdapter {
  readonly id = "claude";
  readonly kind = "cli" as const;

  buildCommand(task: string): string[] {
    return ["claude", "-p", task, "--output-format", "json", "--dangerously-skip-permissions"];
  }

  async run(input: JurorRunInput): Promise<JurorRunResult> {
    const started = Date.now();
    const command = this.buildCommand(input.task);
    if (input.dryRun === true) {
      return {
        status: "ok",
        costMinor: 0,
        durationMs: 0,
        modelVersion: "unknown",
        stdout: "",
        stderr: "",
        command,
      };
    }
    const env = scopedEnv(input.env, ["ANTHROPIC_API_KEY"]);
    const [binary, ...args] = command;
    if (binary === undefined) {
      return {
        status: "failed",
        costMinor: null,
        durationMs: Date.now() - started,
        modelVersion: "unknown",
        stdout: "",
        stderr: "",
        reason: "internal error: empty command",
        command,
      };
    }
    const result = await runCommand(binary, args, {
      cwd: input.worktree,
      env,
      timeoutMs: input.timeoutMs,
    });
    const durationMs = Date.now() - started;
    if (!result.spawned) {
      return {
        status: "failed",
        costMinor: null,
        durationMs,
        modelVersion: "unknown",
        stdout: "",
        stderr: "",
        reason: "claude CLI not found (install Claude Code)",
        command,
      };
    }
    if (result.timedOut) {
      return {
        status: "timeout",
        costMinor: null,
        durationMs,
        modelVersion: "unknown",
        stdout: result.stdout,
        stderr: result.stderr,
        reason: "claude juror exceeded its timeout",
        command,
      };
    }
    if (result.exitCode !== 0) {
      return {
        status: "failed",
        costMinor: null,
        durationMs,
        modelVersion: "unknown",
        stdout: result.stdout,
        stderr: result.stderr,
        reason: failureReason("claude exited non-zero", result),
        command,
      };
    }
    let costMinor: number | null = null;
    let modelVersion = "unknown";
    try {
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      if (typeof parsed["total_cost_usd"] === "number") {
        costMinor = Math.round(parsed["total_cost_usd"] * 100);
      }
      if (typeof parsed["model"] === "string" && parsed["model"].length > 0) {
        modelVersion = parsed["model"];
      }
    } catch {
      // Unparseable output: the juror may still have edited files (the
      // orchestrator diffs the worktree). Cost stays unknown.
    }
    return {
      status: "ok",
      costMinor,
      durationMs,
      modelVersion,
      stdout: result.stdout,
      stderr: result.stderr,
      command,
    };
  }
}
