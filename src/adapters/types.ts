// SPDX-License-Identifier: Apache-2.0
// Juror adapter interface. Every model — native CLI or API — speaks the
// same interface, so a fifth juror is a config change, not an architecture
// change (assessment §5). Adapters return a status and a cost; they never
// return a diff — the orchestrator captures the candidate diff from the
// juror's worktree with git, so no model output is ever parsed as a diff.

export type JurorStatus = "ok" | "failed" | "timeout" | "budget";

export interface JurorRunInput {
  task: string;
  /** Absolute path of the juror's private worktree. */
  worktree: string;
  /** Wall-clock cap for the run. A juror that exceeds it is killed. */
  timeoutMs: number;
  /** Per-juror cost budget in minor currency units (0 = no cap). */
  budgetMinor: number;
  /** Full process env; the adapter passes on only what its juror needs (S-5). */
  env: NodeJS.ProcessEnv;
  /** When true, return the exact command that would run, without running it. */
  dryRun?: boolean;
}

export interface JurorRunResult {
  status: JurorStatus;
  /** Cost in minor units, or null when the tool does not report it. Never invented. */
  costMinor: number | null;
  durationMs: number;
  /** Model id + version as reported at run time, or "unknown". */
  modelVersion: string;
  /** Truncated (64 KiB) and key-redacted stdout. */
  stdout: string;
  /** Truncated (64 KiB) and key-redacted stderr. */
  stderr: string;
  /** Short failure reason when status is not ok (redacted — never contains keys). */
  reason?: string;
  /** The exact command that was (or would be) run, for --dry-run and for the verdict trail. */
  command?: string[];
}

export interface JurorAdapter {
  /** Juror id: claude | codex | gemini | grok | fake-*. */
  id: string;
  /** "cli" for native CLIs, "api" for the Grok API adapter (labelled in every verdict). */
  kind: "cli" | "api";
  run(input: JurorRunInput): Promise<JurorRunResult>;
}

/** API-key-shaped values must never appear in a verdict, a log, or an error (S-1). */
const KEY_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-proj-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /xai-[A-Za-z0-9_-]{10,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];

export const OUTPUT_CAP = 65_536;

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of KEY_PATTERNS) {
    out = out.replace(pattern, "<redacted-key>");
  }
  return out;
}

export function truncateOutput(text: string): string {
  const redacted = redactSecrets(text);
  if (redacted.length <= OUTPUT_CAP) return redacted;
  return `${redacted.slice(0, OUTPUT_CAP)}\n<output truncated at ${OUTPUT_CAP} bytes>`;
}

/** Environment for a subprocess: PATH/HOME/TMPDIR plus exactly the keys the juror owns (S-5). */
export function scopedEnv(
  env: NodeJS.ProcessEnv,
  allowedKeys: string[],
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "USER", "SHELL", "TERM", "LANG", "LC_ALL"]) {
    if (env[name] !== undefined) out[name] = env[name];
  }
  for (const name of allowedKeys) {
    if (env[name] !== undefined) out[name] = env[name];
  }
  return out;
}
