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
  /** Symlinked paths the juror created/changed: never followed during
   * capture (F1), disclosed here instead of read. */
  skippedChanges?: string[];
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((e) => typeof e === "string");
}

function isTier(v: unknown): v is VerdictTier {
  return v === "UNANIMOUS" || v === "MAJORITY" || v === "DIVERGED" || v === "FAILED";
}

/**
 * Structural validation of a verdict payload (B3). Verdict files are
 * untrusted input — shared, downloaded, attached to agent listings —
 * so a VALID stamp must mean "a well-formed, correctly signed
 * verdict", not merely "a signature that checks out over whatever
 * JSON was handed in". A correctly signed document with `task` or
 * `merge` deleted, or `jurors` replaced by a string, is INVALID, and
 * must never reach `show`/`diff` (which index into these fields).
 * Unknown extra fields are allowed: they are part of the payload and
 * therefore covered by the id recomputation.
 */
export function isValidVerdictShape(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (payload["format"] !== VERDICT_FORMAT) return false;
  if (typeof payload["created_at"] !== "string") return false;
  const tool = payload["tool"];
  if (!isRecord(tool) || typeof tool["name"] !== "string" || typeof tool["version"] !== "string") {
    return false;
  }
  const task = payload["task"];
  if (!isRecord(task) || typeof task["hash"] !== "string") return false;
  if (task["text"] !== undefined && typeof task["text"] !== "string") return false;
  const repo = payload["repo"];
  if (!isRecord(repo) || typeof repo["path"] !== "string" || typeof repo["base"] !== "string") {
    return false;
  }
  const jurors = payload["jurors"];
  if (!Array.isArray(jurors)) return false;
  for (const j of jurors) {
    if (!isRecord(j)) return false;
    if (typeof j["id"] !== "string" || typeof j["model"] !== "string") return false;
    if (j["adapter"] !== "cli" && j["adapter"] !== "api") return false;
    if (
      j["status"] !== "ok" &&
      j["status"] !== "failed" &&
      j["status"] !== "timeout" &&
      j["status"] !== "budget"
    ) {
      return false;
    }
    if (j["costMinor"] !== null && typeof j["costMinor"] !== "number") return false;
    if (typeof j["durationMs"] !== "number") return false;
    if (j["candidateHash"] !== null && typeof j["candidateHash"] !== "string") return false;
    if (j["reason"] !== undefined && typeof j["reason"] !== "string") return false;
  }
  const candidates = payload["candidates"];
  if (!Array.isArray(candidates)) return false;
  for (const c of candidates) {
    if (!isRecord(c)) return false;
    if (typeof c["juror"] !== "string" || typeof c["diff"] !== "string") return false;
    if (typeof c["hash"] !== "string") return false;
    if (c["binaryChanges"] !== undefined && !isStringArray(c["binaryChanges"])) return false;
    if (c["skippedChanges"] !== undefined && !isStringArray(c["skippedChanges"])) return false;
  }
  const merge = payload["merge"];
  if (!isRecord(merge) || typeof merge["diff"] !== "string") return false;
  if (!Array.isArray(merge["conflicts"]) || !Array.isArray(merge["dropped"])) return false;
  for (const c of merge["conflicts"] as unknown[]) {
    if (!isRecord(c)) return false;
    if (typeof c["file"] !== "string") return false;
    const bl = c["baseLines"];
    if (bl !== null) {
      if (!isRecord(bl) || typeof bl["start"] !== "number" || typeof bl["end"] !== "number") {
        return false;
      }
    }
    if (!isRecord(c["sides"])) return false;
    for (const side of Object.values(c["sides"])) {
      if (!isStringArray(side)) return false;
    }
    if (
      c["rule"] !== "disjoint" &&
      c["rule"] !== "ast-disjoint" &&
      c["rule"] !== "subset" &&
      c["rule"] !== "tests" &&
      c["rule"] !== "unresolved"
    ) {
      return false;
    }
    if (c["winner"] !== undefined && typeof c["winner"] !== "string") return false;
  }
  for (const d of merge["dropped"] as unknown[]) {
    if (!isRecord(d)) return false;
    if (
      typeof d["file"] !== "string" ||
      typeof d["juror"] !== "string" ||
      typeof d["rule"] !== "string" ||
      typeof d["detail"] !== "string"
    ) {
      return false;
    }
  }
  if (merge["astRefined"] !== undefined && !isStringArray(merge["astRefined"])) return false;
  const tests = payload["tests"];
  if (tests !== null) {
    if (!isRecord(tests)) return false;
    if (typeof tests["command"] !== "string") return false;
    if (tests["exitCode"] !== null && typeof tests["exitCode"] !== "number") return false;
    if (tests["outputHash"] !== null && typeof tests["outputHash"] !== "string") return false;
    if (typeof tests["flaky"] !== "boolean") return false;
    if (
      tests["outcome"] !== "pass" &&
      tests["outcome"] !== "fail" &&
      tests["outcome"] !== "flaky" &&
      tests["outcome"] !== "not-run"
    ) {
      return false;
    }
  }
  if (!isTier(payload["tier"])) return false;
  // A verdict with no jurors and a non-FAILED tier is semantically
  // empty (N10): UNANIMOUS/MAJORITY/DIVERGED over zero jurors means
  // nothing, so it is malformed rather than valid. FAILED is the
  // exception: a run in which every juror failed still records its
  // (possibly empty) outcome list, and that verdict must verify.
  if (payload["tier"] !== "FAILED" && jurors.length === 0) return false;
  if (!Array.isArray(payload["dissent"])) return false;
  for (const d of payload["dissent"] as unknown[]) {
    if (!isRecord(d)) return false;
    if (typeof d["kind"] !== "string" || typeof d["note"] !== "string") return false;
    if (d["juror"] !== undefined && typeof d["juror"] !== "string") return false;
    if (d["file"] !== undefined && typeof d["file"] !== "string") return false;
  }
  const signer = payload["signer"];
  if (!isRecord(signer) || typeof signer["kid"] !== "string") return false;
  const pub = signer["publicKey"];
  if (
    !isRecord(pub) ||
    pub["kty"] !== "OKP" ||
    pub["crv"] !== "Ed25519" ||
    typeof pub["x"] !== "string"
  ) {
    return false;
  }
  return true;
}

/**
 * Offline verification: recompute the id from the canonical payload and
 * verify the JWS against the embedded signer key. Returns the first
 * failure found; a verdict that fails here must not be trusted.
 */
export function verifyVerdict(verdict: Verdict): VerifyVerdictResult {
  if (verdict === null || typeof verdict !== "object" || Array.isArray(verdict)) {
    return { ok: false, reason: "malformed-verdict" };
  }
  // The signature is split inside verifyJws: a non-string (or missing)
  // signature must be INVALID, never a thrown TypeError (B3).
  if (typeof verdict.id !== "string" || typeof verdict.signature !== "string") {
    return { ok: false, reason: "malformed-verdict" };
  }
  if (verdict.format !== VERDICT_FORMAT) return { ok: false, reason: "format-mismatch" };
  const { id, signature, ...payload } = verdict as Verdict & Record<string, unknown>;
  // Shape first: a signature over a structurally malformed payload is
  // still INVALID — the signature only proves who signed these bytes,
  // not that the bytes form a verdict.
  if (!isValidVerdictShape(payload)) return { ok: false, reason: "malformed-verdict" };
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
