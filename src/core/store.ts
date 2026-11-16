// SPDX-License-Identifier: Apache-2.0
// Verdict store: files, no daemon, no database. A verdict is one
// `triangulate/1` JSON document; runs append to a hash-chained JSONL log
// (same pattern as Vouchard's audit log and Successor's audit chain).

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalHash } from "./jcs.js";
import type { Verdict, VerdictTier } from "./verdict.js";

export interface LogEntry {
  seq: number;
  id: string;
  tier: VerdictTier;
  created_at: string;
  /** Hash of the previous entry ("" for the first). */
  prev: string;
  /** SHA-256 of the canonical {seq, id, tier, created_at, prev}. */
  hash: string;
}

export function logEntryHash(entry: Omit<LogEntry, "hash">): string {
  return canonicalHash({
    seq: entry.seq,
    id: entry.id,
    tier: entry.tier,
    created_at: entry.created_at,
    prev: entry.prev,
  });
}

export function defaultStoreDir(): string {
  return process.env["TRIANGULATE_HOME"] ?? join(process.env["HOME"] ?? "", ".triangulate");
}

/** Write a verdict document to <dir>/<id>.json (pretty-printed for humans). */
export async function writeVerdict(verdict: Verdict, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${verdict.id}.json`);
  await writeFile(path, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
  return path;
}

/** Write a verdict document to an exact file path (the CLI's --out). */
export async function writeVerdictFile(verdict: Verdict, filePath: string): Promise<string> {
  const parent = join(filePath, "..");
  await mkdir(parent, { recursive: true });
  await writeFile(filePath, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
  return filePath;
}

/** Read and parse a verdict document. Throws on malformed JSON. */
export async function readVerdict(path: string): Promise<Verdict> {
  const text = await readFile(path, "utf8");
  return JSON.parse(text) as Verdict;
}

/** Append one hash-chained entry to the JSONL log; returns the entry. */
export async function appendLog(
  verdict: Verdict,
  logPath: string,
): Promise<LogEntry> {
  let prev = "";
  let seq = 0;
  try {
    const text = await readFile(logPath, "utf8");
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1];
      if (lastLine !== undefined) {
        const last = JSON.parse(lastLine) as LogEntry;
        prev = last.hash;
        seq = last.seq + 1;
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && code !== "ENOENT") throw error;
  }
  const base = { seq, id: verdict.id, tier: verdict.tier, created_at: verdict.created_at, prev };
  const entry: LogEntry = { ...base, hash: logEntryHash(base) };
  await mkdir(join(logPath, ".."), { recursive: true }).catch(() => undefined);
  await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

/** Read the log; returns [] when it does not exist yet. */
export async function readLog(logPath: string): Promise<LogEntry[]> {
  try {
    const text = await readFile(logPath, "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as LogEntry);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && code !== "ENOENT") throw error;
    return [];
  }
}

/** Verify the hash chain: every entry links to the previous hash. */
export function verifyLog(entries: LogEntry[]): { ok: boolean; reason?: string } {
  let prev = "";
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry === undefined) return { ok: false, reason: `missing entry at ${i}` };
    if (entry.seq !== i) return { ok: false, reason: `seq gap at ${i}` };
    if (entry.prev !== prev) return { ok: false, reason: `prev mismatch at seq ${i}` };
    const { hash, ...base } = entry;
    if (logEntryHash(base) !== hash) {
      return { ok: false, reason: `hash mismatch at seq ${i}` };
    }
    prev = hash;
  }
  return { ok: true };
}
