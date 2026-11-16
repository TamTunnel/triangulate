// SPDX-License-Identifier: Apache-2.0
// Codex juror: drives the OpenAI Codex CLI non-interactively.
// Command verified against the installed binary (codex-cli 0.164.0):
//   codex exec --json -s workspace-write --approve-for-me -C <worktree> <task>
// `--json` emits JSONL events on stdout; cost is read from a
// `total_cost_usd` field in any event when the tool reports it, and is
// "unknown" otherwise (never invented). The worktree sandbox keeps the
// juror's writes inside its own copy; approvals for anything beyond
// that are routed through automatic review, not bypassed.

import { failureReason, runCommand } from "./spawn.js";
import { scopedEnv } from "./types.js";
import type { JurorAdapter, JurorRunInput, JurorRunResult } from "./types.js";

export class CodexAdapter implements JurorAdapter {
  readonly id = "codex";
  readonly kind = "cli" as const;

  buildCommand(task: string, worktree: string): string[] {
    return [
      "codex",
      "exec",
      "--json",
      "-s",
      "workspace-write",
      "--approve-for-me",
      "-C",
      worktree,
      task,
    ];
  }

  async run(input: JurorRunInput): Promise<JurorRunResult> {
    const started = Date.now();
    const command = this.buildCommand(input.task, input.worktree);
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
    const env = scopedEnv(input.env, ["OPENAI_API_KEY", "CODEX_HOME"]);
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
        reason: "codex CLI not found (install the OpenAI Codex CLI)",
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
        reason: "codex juror exceeded its timeout",
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
        reason: failureReason("codex exited non-zero", result),
        command,
      };
    }
    let costMinor: number | null = null;
    let modelVersion = "unknown";
    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof event["total_cost_usd"] === "number") {
          costMinor = Math.round(event["total_cost_usd"] * 100);
        }
        const usage = event["usage"] as Record<string, unknown> | undefined;
        if (usage !== undefined && typeof usage["total_cost_usd"] === "number") {
          costMinor = Math.round(usage["total_cost_usd"] * 100);
        }
        if (typeof event["model"] === "string" && event["model"].length > 0) {
          modelVersion = event["model"];
        }
      } catch {
        // Non-JSON lines in the stream are ignored.
      }
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
