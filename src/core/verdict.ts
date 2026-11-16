// SPDX-License-Identifier: Apache-2.0
// The `triangulate/1` verdict format — the product.
// A verdict is a signed, content-addressed record of a multi-model run:
// the task, what each juror produced, the deterministic merge, the test
// check, the tier, and every disagreement. It is a record, not a proof
// of correctness (see README honest limits): agreement is evidence,
// not truth.
//
// Signing: the payload (every field except `id` and `signature`) is
// JCS-canonicalized; `id` is the SHA-256 of that canonical form; the
// JWS signs the same canonical form. `tri verify` recomputes both
// offline, with no network and no registry.

import { createHash } from "node:crypto";
import { canonicalHash, canonicalize } from "./jcs.js";
import { signJws, verifyJws } from "./jws.js";
import type { Ed25519Jwk, Keypair } from "./jws.js";

export const VERDICT_FORMAT = "triangulate/1" as const;
export const TOOL_NAME = "triangulate" as const;

export type VerdictTier = "UNANIMOUS" | "MAJORITY" | "DIVERGED" | "FAILED";

export type JurorStatus = "ok" | "failed" | "timeout" | "budget";
export type AdapterKind = "cli" | "api";

export interface JurorRecord {
  /** Juror id: claude | codex | gemini | grok | fake-*. */
  id: string;
  /** Model id + version as reported at run time, or "unknown". */
  model: string;
  adapter: AdapterKind;
  status: JurorStatus;
  /** Cost in minor currency units, or null when the tool does not report it. Never invented. */
  costMinor: number | null;
  durationMs: number;
  /** SHA-256 of the candidate diff's canonical form, or null when the juror produced none. */
  candidateHash: string | null;
  /** Short failure reason when status is not ok (redacted — never contains keys). */
  reason?: string;
}

export interface CandidateRecord {
  juror: string;
  /** Unified diff of the juror's worktree against the base, or "" when empty. */
  diff: string;
  hash: string;
  /** Binary files the juror changed (excluded from the text merge, disclosed here). */
  binaryChanges?: string[];
}

export interface ConflictRecord {
  file: string;
  /** 1-based base line range the conflict spans, or null for whole-file conflicts. */
  baseLines: { start: number; end: number } | null;
  /** Juror id -> replacement lines (or file content for whole-file conflicts). */
  sides: Record<string, string[]>;
  /** Resolution rule applied, or "unresolved". */
  rule: "disjoint" | "ast-disjoint" | "subset" | "tests" | "unresolved";
  /** Juror whose side won, when a rule picked one. */
  winner?: string;
}

export interface DroppedHunkRecord {
  file: string;
  juror: string;
  /** Why the hunk did not make the merge: a rule reference, not prose. */
  rule: "subset" | "tests" | "superseded-by-identical";
  detail: string;
}

export interface TestRecord {
  command: string;
  /** Exit code, or null when the command could not run. */
  exitCode: number | null;
  /** SHA-256 of the (truncated) stdout+stderr, or null when not run. */
  outputHash: string | null;
  /** True when the first run failed and a rerun passed. */
  flaky: boolean;
  outcome: "pass" | "fail" | "flaky" | "not-run";
}

export interface MergeRecord {
  /** The merged diff (unified, against the base). Empty when FAILED. */
  diff: string;
  conflicts: ConflictRecord[];
  dropped: DroppedHunkRecord[];
  /** Files whose merge used AST-aware node refinement (provenance for the merge). */
  astRefined?: string[];
}

export interface DissentEntry {
  /** What disagreed: "conflict" | "dropped-hunk" | "juror-failed" | "juror-budget" | "juror-timeout". */
  kind: string;
  juror?: string;
  file?: string;
  /** A rule reference or a short factual note — never model prose. */
  note: string;
}

/** Everything that gets signed. `id` and `signature` are computed from this. */
export interface VerdictPayload {
  format: typeof VERDICT_FORMAT;
  created_at: string;
  tool: { name: string; version: string };
  task: {
    /** Task text, unless --redact-task (then omitted, hash only). */
    text?: string;
    /** SHA-256 of the task text. */
    hash: string;
  };
  repo: { path: string; base: string };
  jurors: JurorRecord[];
  candidates: CandidateRecord[];
  merge: MergeRecord;
  /** Null when no test command was configured or it could not run. */
  tests: TestRecord | null;
  tier: VerdictTier;
  dissent: DissentEntry[];
  signer: { publicKey: Ed25519Jwk; kid: string };
}

/** A signed verdict document: payload + content-addressed id + JWS. */
export interface Verdict extends VerdictPayload {
  id: string;
  signature: string;
}

export function taskHash(taskText: string): string {
  return createHash("sha256").update(taskText, "utf8").digest("hex");
}

/** The exact bytes that are hashed (id) and signed (JWS). */
export function canonicalPayload(payload: VerdictPayload): string {
  return canonicalize(payload);
}

/** Sign a payload into a full verdict document. */
export function signVerdict(payload: VerdictPayload, keypair: Keypair): Verdict {
  const canonical = canonicalPayload(payload);
  const id = createHash("sha256").update(canonical, "utf8").digest("hex");
  const signature = signJws({ keypair, payload });
  return { ...payload, id, signature };
}

export interface VerifyVerdictResult {
  ok: boolean;
  reason?: string;
}

/**
 * Offline verification: recompute the id from the canonical payload and
 * verify the JWS against the embedded signer key. Returns the first
 * failure found; a verdict that fails here must not be trusted.
 */
export function verifyVerdict(verdict: Verdict): VerifyVerdictResult {
  if (verdict.format !== VERDICT_FORMAT) return { ok: false, reason: "format-mismatch" };
  const { id, signature, ...payload } = verdict as Verdict & Record<string, unknown>;
  // The payload must contain exactly the signed fields; anything extra
  // in the envelope that is not id/signature is part of the payload and
  // therefore covered by the id recomputation below.
  const recomputed = canonicalHash(payload);
  if (recomputed !== id) return { ok: false, reason: "id-mismatch" };
  const signer = (payload as VerdictPayload).signer;
  if (!signer || typeof signer.kid !== "string" || !signer.publicKey) {
    return { ok: false, reason: "missing-signer" };
  }
  const result = verifyJws(signature, signer.publicKey);
  if (!result.ok) return { ok: false, reason: result.reason ?? "bad-signature" };
  // The JWS payload must be the same canonical payload that produced the id.
  if (canonicalize(result.payload) !== canonicalPayload(payload)) {
    return { ok: false, reason: "payload-mismatch" };
  }
  return { ok: true };
}
