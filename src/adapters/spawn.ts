// SPDX-License-Identifier: Apache-2.0
// Shared subprocess runner for native-CLI adapters. Handles timeouts
// (kill on expiry, status "timeout"), output caps + key redaction, and
// the "binary not found" case (status "failed" with a clear reason).

import { spawn } from "node:child_process";
import { redactSecrets, truncateOutput } from "./types.js";

export interface RunCommandResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** False when the binary could not be spawned at all. */
  spawned: boolean;
}

export async function runCommand(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; stdin?: string },
): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeoutMs,
        killSignal: "SIGKILL",
        // Detached: the child leads its own process group, so a
        // timeout can kill the whole tree (N2) — a CLI that spawns
        // grandchildren must not leave orphans spending after its
        // juror is recorded as timed out.
        detached: true,
      });
    } catch {
      resolve({
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawned: false,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the whole process group, not just the direct child.
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, opts.timeoutMs);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 262_144) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 262_144) stderr += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        signal: null,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        timedOut: false,
        spawned: false,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal: signal === null ? null : String(signal),
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        timedOut,
        spawned: true,
      });
    });
    if (opts.stdin !== undefined && child.stdin !== null) {
      child.stdin.end(opts.stdin);
    }
  });
}

/** Short, redacted one-line reason from a command result. */
export function failureReason(prefix: string, result: RunCommandResult): string {
  const detail = result.stderr.trim().split("\n").pop() ?? "";
  const clean = redactSecrets(detail).slice(0, 200);
  return clean.length > 0 ? `${prefix}: ${clean}` : prefix;
}
