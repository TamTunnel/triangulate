// SPDX-License-Identifier: Apache-2.0
// Gemini juror: drives the Gemini CLI non-interactively.
// Command per the Gemini CLI's documented non-interactive mode:
//   gemini -p <task> -y
// (`-p` runs one prompt and exits; `-y` auto-approves edits, which is
// what a juror in its own disposable worktree needs.) Output is plain
// text, so cost is "unknown" unless the tool starts reporting it —
// never invented. This adapter was NOT run against a real Gemini CLI
// here (not installed, no key) — see --dry-run.

import { failureReason, runCommand } from "./spawn.js";
import { scopedEnv } from "./types.js";
import type { JurorAdapter, JurorRunInput, JurorRunResult } from "./types.js";

export class GeminiAdapter implements JurorAdapter {
  readonly id = "gemini";
  readonly kind = "cli" as const;

  buildCommand(task: string): string[] {
    return ["gemini", "-p", task, "-y"];
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
    const env = scopedEnv(input.env, ["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
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
        reason: "gemini CLI not found (install the Gemini CLI)",
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
        reason: "gemini juror exceeded its timeout",
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
        reason: failureReason("gemini exited non-zero", result),
        command,
      };
    }
    return {
      status: "ok",
      costMinor: null,
      durationMs,
      modelVersion: "unknown",
      stdout: result.stdout,
      stderr: result.stderr,
      command,
    };
  }
}
