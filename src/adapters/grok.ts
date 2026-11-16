// SPDX-License-Identifier: Apache-2.0
// Grok juror: an API adapter, not a native CLI — there is no mature Grok
// coding CLI, so this juror talks to the xAI chat-completions API and
// applies the returned file map to its worktree. It is labelled
// `adapter: "api"` in every verdict, so a reader never mistakes it for a
// native-CLI juror. The model is asked for a JSON map of changed files
// (path -> complete new contents); the map is validated (relative paths
// only, string values) and the orchestrator then diffs the worktree
// with git, exactly as for CLI jurors. Cost is not computed from a price
// table — the API reports usage, not a dollar figure, so cost is
// "unknown" unless a future version adds a pinned price table.

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { redactSecrets, truncateOutput } from "./types.js";
import type { JurorAdapter, JurorRunInput, JurorRunResult } from "./types.js";

const API_URL = "https://api.x.ai/v1/chat/completions";
/** Total repo context sent in the prompt (bytes). Larger files are skipped, not truncated mid-line. */
const CONTEXT_CAP = 65_536;
const MAX_FILE_BYTES = 32_768;

const SYSTEM_PROMPT = `You are a coding agent completing a task in a repository. Reply with a single JSON object mapping each changed file's relative path to its complete new contents, e.g. {"src/app.ts": "...new file contents..."}. Include only files you changed. Do not include any other text, explanation, or markdown fences.`;

async function collectContext(worktree: string): Promise<string> {
  const lines: string[] = [];
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (total >= CONTEXT_CAP) return;
      const path = join(dir, entry.name);
      const rel = relative(worktree, path);
      if (rel.startsWith(".git") || rel === ".git") continue;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        await walk(path);
      } else if (entry.isFile()) {
        const info = await stat(path);
        if (info.size > MAX_FILE_BYTES) continue;
        try {
          const content = await readFile(path, "utf8");
          const block = `--- ${rel} ---\n${content}\n`;
          if (total + block.length > CONTEXT_CAP) continue;
          lines.push(block);
          total += block.length;
        } catch {
          // Binary or unreadable files are skipped silently.
        }
      }
    }
  };
  await walk(worktree);
  return lines.join("");
}

function parseFileMap(content: string): Map<string, string> | null {
  let text = content.trim();
  const fence = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fence !== null && fence[1] !== undefined) text = fence[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const out = new Map<string, string>();
  for (const [path, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") return null;
    if (path.length === 0 || path.startsWith("/") || path.includes("..")) return null;
    out.set(path, value);
  }
  return out;
}

export class GrokAdapter implements JurorAdapter {
  readonly id = "grok";
  readonly kind = "api" as const;

  async run(input: JurorRunInput): Promise<JurorRunResult> {
    const started = Date.now();
    const duration = (): number => Date.now() - started;
    const model = input.env["GROK_MODEL"] ?? "grok-4";
    if (input.dryRun === true) {
      return {
        status: "ok",
        costMinor: 0,
        durationMs: 0,
        modelVersion: model,
        stdout: "",
        stderr: "",
        command: ["grok-api", model, "--task", input.task.slice(0, 80)],
      };
    }
    const apiKey = input.env["XAI_API_KEY"];
    if (apiKey === undefined || apiKey.length === 0) {
      return {
        status: "failed",
        costMinor: null,
        durationMs: duration(),
        modelVersion: model,
        stdout: "",
        stderr: "",
        reason: "XAI_API_KEY is not set",
      };
    }
    const context = await collectContext(input.worktree);
    const userPrompt = `Task:\n${input.task}\n\nRepository (relevant files):\n${context}`;
    let response: Response;
    try {
      response = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 8192,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(input.timeoutMs),
      });
    } catch (error) {
      const isTimeout =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return {
        status: isTimeout ? "timeout" : "failed",
        costMinor: null,
        durationMs: duration(),
        modelVersion: model,
        stdout: "",
        stderr: "",
        reason: isTimeout
          ? "grok juror exceeded its timeout"
          : `grok request failed: ${redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
      };
    }
    if (!response.ok) {
      return {
        status: "failed",
        costMinor: null,
        durationMs: duration(),
        modelVersion: model,
        stdout: "",
        stderr: "",
        reason: `grok API returned HTTP ${response.status}`,
      };
    }
    const body = (await response.json()) as Record<string, unknown>;
    const choices = body["choices"] as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.["message"] as Record<string, unknown> | undefined;
    const content = typeof message?.["content"] === "string" ? message["content"] : "";
    const modelVersion =
      typeof body["model"] === "string" && body["model"].length > 0
        ? body["model"]
        : model;
    const fileMap = parseFileMap(content);
    if (fileMap === null) {
      return {
        status: "failed",
        costMinor: null,
        durationMs: duration(),
        modelVersion,
        stdout: truncateOutput(content),
        stderr: "",
        reason: "grok returned output that was not a valid file map",
      };
    }
    for (const [relativePath, fileContent] of fileMap) {
      const target = join(input.worktree, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, fileContent, "utf8");
    }
    return {
      status: "ok",
      costMinor: null,
      durationMs: duration(),
      modelVersion,
      stdout: truncateOutput(content),
      stderr: "",
    };
  }
}
