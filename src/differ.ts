// SPDX-License-Identifier: Apache-2.0
// Deterministic 3-way merge of candidate file snapshots against a base.
//
// Design (assessment §5): line-level merge first, with a conflict record.
// Identical hunks (by content) collapse to agreement; non-overlapping
// changes merge; overlapping hunks that differ become a conflict with
// both sides preserved — never silently resolved by a model. The merge
// is a pure function of (base, candidates): given the same candidate
// diffs, the output is byte-identical regardless of juror completion
// order (gate probe D-1) — candidates are processed in juror-id order.
//
// Conflict resolution rules, in order:
//   "disjoint"    — sides changed disjoint base lines (and no insertion
//                   anchor collision): apply all sides.
//   "ast-disjoint"— (TS/JS only, see ast.ts) sides changed disjoint
//                   top-level named nodes: apply each side's node text.
//   "subset"      — one side's replacement is a strict subsequence of
//                   another's: take the superset, record the drop.
//   "tests"       — the arbitrator picked a winner by running the repo's
//                   tests (passed via `choices`); recorded, never silent.
//   "unresolved"  — merged output keeps conflict markers and both sides.
//
// Size bounds (gate probe S-8): files over 1 MiB or 20,000 lines are
// treated as whole-file replacements, never diffed line by line.

import { canonicalHash } from "./core/jcs.js";
import type { ConflictRecord, DroppedHunkRecord } from "./core/verdict.js";
export type { ConflictRecord, DroppedHunkRecord } from "./core/verdict.js";
// Circular import with ast.ts (ast.ts imports diffLines/opsToHunks
// from here): safe in practice — both modules use each other only at
// call time, never at module-eval time — but fragile; do not add
// module-eval-time cross-uses.
import { tryAstMerge } from "./ast.js";

export const MAX_FILE_BYTES = 1_048_576;
export const MAX_FILE_LINES = 20_000;

/**
 * The Myers trace stores one V array per edit step D; on inputs that
 * differ almost everywhere D ≈ n+m and the trace is O(D·N) memory
 * (measured +316 MB at 4,000 fully-different lines, ~15 GB
 * extrapolated at the 20k-line cap). Bound the trace to this many
 * bytes: past it, diffLines throws DiffTooLargeError and callers treat
 * the file as a whole-file replacement instead (S-8).
 */
export const MAX_TRACE_BYTES = 64 * 1024 * 1024;

export class DiffTooLargeError extends Error {
  constructor() {
    super("diff edit distance exceeds the trace budget");
  }
}

/** Whole-file conflict sides are truncated: a 20,000-line file must not
 * embed its full content in the verdict (S-8). Test-pick applies sides
 * from the candidate snapshots, never from the recorded sides, so
 * truncation loses no arbitration fidelity. */
export const MAX_CONFLICT_SIDE_LINES = 100;

function truncateSide(lines: string[]): string[] {
  if (lines.length <= MAX_CONFLICT_SIDE_LINES) return lines;
  return [
    ...lines.slice(0, MAX_CONFLICT_SIDE_LINES),
    `<triangulate: truncated ${lines.length - MAX_CONFLICT_SIDE_LINES} more lines>`,
  ];
}

function truncatedSides(sides: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(sides).map(([juror, lines]) => [juror, truncateSide(lines)]),
  );
}

export type FileMap = Map<string, string>;

export interface CandidateSnapshot {
  juror: string;
  files: FileMap;
}

export interface MergeOptions {
  /** Conflict key `${file}:${start}:${end}` -> winning juror id (test-pick). */
  choices?: Map<string, string>;
}

export interface MergeResult {
  merged: FileMap;
  conflicts: ConflictRecord[];
  dropped: DroppedHunkRecord[];
  /** Files resolved by the AST node merge instead of the line merge. */
  astRefined: string[];
}

/** One contiguous edit relative to the base. */
export interface Hunk {
  /** 0-based, half-open base range the hunk replaces. Empty range = pure insertion. */
  baseStart: number;
  baseEnd: number;
  newLines: string[];
}

export type DiffOp =
  | { type: "equal"; line: string }
  | { type: "delete"; line: string }
  | { type: "insert"; line: string };

/**
 * Myers O(ND) line diff. Returns the minimal edit script from `a` to `b`.
 * Throws on inputs over the size caps — callers treat those as whole-file
 * replacements instead.
 */
/** Index into a V array: out-of-range reads are 0 (the array is zero-filled). */
function vAt(v: Int32Array, i: number): number {
  return v[i] ?? 0;
}

/** A line at a provably in-range index (the Myers walk guarantees it). */
function lineAt(lines: string[], i: number): string {
  const line = lines[i];
  if (line === undefined) throw new Error("diff index out of range");
  return line;
}

export function diffLines(a: string[], b: string[]): DiffOp[] {
  if (a.length > MAX_FILE_LINES || b.length > MAX_FILE_LINES) {
    throw new Error("file exceeds line cap");
  }
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  // Bound the trace: each V array is 4*(2*max+1) bytes, one per D.
  const dMax = Math.max(1, Math.floor(MAX_TRACE_BYTES / ((2 * max + 1) * 4)));
  // Trace of V arrays per D, for backtracking.
  const trace: Int32Array[] = [];
  const v = new Int32Array(2 * max + 1);
  const offset = max;
  let foundD = -1;
  outer: for (let d = 0; d <= max; d += 1) {
    if (d > dMax) throw new DiffTooLargeError();
    const vd = new Int32Array(2 * max + 1);
    vd.set(v);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && vAt(vd, offset + k - 1) < vAt(vd, offset + k + 1))) {
        x = vAt(vd, offset + k + 1);
      } else {
        x = vAt(vd, offset + k - 1) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      vd[offset + k] = x;
      if (x >= n && y >= m) {
        foundD = d;
        trace.push(vd);
        break outer;
      }
    }
    trace.push(vd);
    v.set(vd);
  }
  if (foundD === -1) throw new Error("diff failed to converge");
  // Backtrack through the trace.
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = foundD; d > 0; d -= 1) {
    const vd = trace[d];
    const vPrev = trace[d - 1];
    if (vd === undefined || vPrev === undefined) throw new Error("diff trace corrupted");
    const k = x - y;
    const prevK =
      k === -d || (k !== d && vAt(vPrev, offset + k - 1) < vAt(vPrev, offset + k + 1))
        ? k + 1
        : k - 1;
    const prevX = vAt(vPrev, offset + prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: "equal", line: lineAt(a, x - 1) });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      ops.push({ type: "insert", line: lineAt(b, y - 1) });
      y -= 1;
    } else {
      ops.push({ type: "delete", line: lineAt(a, x - 1) });
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ type: "equal", line: lineAt(a, x - 1) });
    x -= 1;
    y -= 1;
  }
  ops.reverse();
  return ops;
}

/** Group a Myers edit script into hunks in base coordinates. */
export function opsToHunks(ops: DiffOp[]): Hunk[] {
  const hunks: Hunk[] = [];
  let baseIdx = 0;
  let current: Hunk | null = null;
  const flush = () => {
    if (current !== null) {
      hunks.push(current);
      current = null;
    }
  };
  for (const op of ops) {
    if (op.type === "equal") {
      flush();
      baseIdx += 1;
    } else if (op.type === "delete") {
      if (current === null) current = { baseStart: baseIdx, baseEnd: baseIdx, newLines: [] };
      current.baseEnd = baseIdx + 1;
      baseIdx += 1;
    } else {
      if (current === null) current = { baseStart: baseIdx, baseEnd: baseIdx, newLines: [] };
      current.newLines.push(op.line);
    }
  }
  flush();
  return hunks;
}

/** Split file content into lines; join() round-trips exactly. */
export function splitLines(content: string): string[] {
  return content.split("\n");
}

function joinLines(lines: string[]): string {
  return lines.join("\n");
}

function isSubsequence(needle: string[], haystack: string[]): boolean {
  if (needle.length === 0) return true;
  let j = 0;
  for (const line of haystack) {
    if (line === needle[j]) {
      j += 1;
      if (j === needle.length) return true;
    }
  }
  return false;
}

/** Render a unified diff (3 lines of context) from base to new lines.
 * Never throws on oversize input: a file over the caps, or a pair
 * whose edit distance exceeds the trace budget, renders as a short
 * placeholder instead — the render paths (orchestrator, arbitrator)
 * must never crash a run over one bad file (F3). */
export function renderUnifiedDiff(file: string, baseLines: string[], newLines: string[]): string {
  const oversizeNote = (reason: string): string =>
    `--- a/${file}\n+++ b/${file}\n@@ oversize: ${reason}; diff omitted @@\n`;
  if (baseLines.length > MAX_FILE_LINES || newLines.length > MAX_FILE_LINES) {
    return oversizeNote("file exceeds the line cap");
  }
  let ops: DiffOp[];
  try {
    ops = diffLines(baseLines, newLines);
  } catch {
    return oversizeNote("files differ too much to diff line by line");
  }
  const context = 3;
  // Group change ops; equal runs of <= 2*context between changes stay in
  // one hunk, longer runs split hunks.
  interface Group {
    startOp: number;
    endOp: number; // exclusive
  }
  const groups: Group[] = [];
  let current: Group | null = null;
  let equalRun = 0;
  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index];
    if (op === undefined) continue;
    if (op.type === "equal") {
      equalRun += 1;
      if (current !== null && equalRun > context * 2) {
        current.endOp = index - equalRun + context;
        groups.push(current);
        current = null;
        equalRun = 0;
      }
      continue;
    }
    if (current === null) {
      current = { startOp: Math.max(0, index - context), endOp: index + 1 };
    } else {
      current.endOp = index + 1;
    }
    equalRun = 0;
  }
  if (current !== null) {
    current.endOp = Math.min(ops.length, current.endOp + context);
    groups.push(current);
  }
  if (groups.length === 0) return "";
  const out: string[] = [`--- a/${file}`, `+++ b/${file}`];
  for (const group of groups) {
    let baseStart = 0;
    let newStart = 0;
    for (let i = 0; i < group.startOp; i += 1) {
      const op = ops[i];
      if (op === undefined) continue;
      if (op.type !== "insert") baseStart += 1;
      if (op.type !== "delete") newStart += 1;
    }
    let baseCount = 0;
    let newCount = 0;
    const lines: string[] = [];
    for (let i = group.startOp; i < group.endOp; i += 1) {
      const op = ops[i];
      if (op === undefined) continue;
      if (op.type === "equal") {
        lines.push(` ${op.line}`);
        baseCount += 1;
        newCount += 1;
      } else if (op.type === "delete") {
        lines.push(`-${op.line}`);
        baseCount += 1;
      } else {
        lines.push(`+${op.line}`);
        newCount += 1;
      }
    }
    out.push(`@@ -${baseStart + 1},${baseCount} +${newStart + 1},${newCount} @@`);
    out.push(...lines);
  }
  return `${out.join("\n")}\n`;
}

interface RegionSide {
  juror: string;
  hunks: Hunk[];
  replacement: string[];
  /** Base lines this side changes (union of its hunk ranges). */
  changedLines: Set<number>;
  /** Insertion anchors (base positions where baseStart == baseEnd). */
  anchors: Set<number>;
}

function mergeFileLines(
  file: string,
  baseLines: string[],
  perJurorHunks: Map<string, Hunk[]>,
  choices: Map<string, string>,
  conflicts: ConflictRecord[],
  dropped: DroppedHunkRecord[],
): string[] {
  // Collect all hunk ranges and partition the base into regions.
  interface Range {
    start: number;
    end: number;
  }
  const ranges: Range[] = [];
  for (const hunks of perJurorHunks.values()) {
    for (const h of hunks) ranges.push({ start: h.baseStart, end: h.baseEnd });
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const regions: Range[] = [];
  for (const range of ranges) {
    const last = regions[regions.length - 1];
    if (last !== undefined && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      regions.push({ ...range });
    }
  }

  const out: string[] = [];
  let cursor = 0;
  for (const region of regions) {
    out.push(...baseLines.slice(cursor, region.start));
    const sides: RegionSide[] = [];
    for (const [juror, hunks] of [...perJurorHunks.entries()].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      const inRegion = hunks.filter(
        (h) => h.baseStart >= region.start && h.baseEnd <= region.end,
      );
      if (inRegion.length === 0) continue;
      const replacement: string[] = [];
      const changedLines = new Set<number>();
      const anchors = new Set<number>();
      for (const h of inRegion) {
        replacement.push(...h.newLines);
        for (let i = h.baseStart; i < h.baseEnd; i += 1) changedLines.add(i);
        if (h.baseStart === h.baseEnd) anchors.add(h.baseStart);
      }
      sides.push({ juror, hunks: inRegion, replacement, changedLines, anchors });
    }
    out.push(
      ...resolveRegion(file, region, sides, baseLines, choices, conflicts, dropped),
    );
    cursor = region.end;
  }
  out.push(...baseLines.slice(cursor));
  return out;
}

/** Apply all sides' edits to a region when they touch disjoint base lines. */
function applyDisjoint(
  region: { start: number; end: number },
  sides: RegionSide[],
  baseLines: string[],
): string[] | null {
  // Pairwise disjoint changed lines, and no insertion anchor inside
  // another side's changed range (or equal to another side's anchor).
  for (let i = 0; i < sides.length; i += 1) {
    for (let j = i + 1; j < sides.length; j += 1) {
      const si = sides[i];
      const sj = sides[j];
      if (si === undefined || sj === undefined) continue;
      for (const line of si.changedLines) {
        if (sj.changedLines.has(line)) return null;
      }
      for (const anchor of si.anchors) {
        if (sj.anchors.has(anchor)) return null;
        // Anchor strictly inside the other side's changed range.
        for (const h of sj.hunks) {
          if (anchor > h.baseStart && anchor < h.baseEnd) return null;
        }
      }
      for (const anchor of sj.anchors) {
        if (si.anchors.has(anchor)) return null;
        for (const h of si.hunks) {
          if (anchor > h.baseStart && anchor < h.baseEnd) return null;
        }
      }
    }
  }
  // Apply: walk the region's base lines, emitting each side's replacement
  // for the hunks it owns, in base order. Several hunks may share one
  // anchor (a pure insertion and the deletion/replacement that starts
  // there): they are a list, not one entry — keying by baseStart alone
  // silently dropped whichever hunk was overwritten (F5).
  const out: string[] = [];
  const byStart = new Map<number, { side: RegionSide; hunk: Hunk }[]>();
  for (const side of sides) {
    for (const hunk of side.hunks) {
      const list = byStart.get(hunk.baseStart) ?? [];
      list.push({ side, hunk });
      byStart.set(hunk.baseStart, list);
    }
  }
  let i = region.start;
  while (i < region.end) {
    const hits = byStart.get(i);
    if (hits !== undefined) {
      // Pure insertions first (they consume no base lines), then the
      // replacement/deletion that shares the anchor — both effects
      // survive.
      const ordered = [...hits].sort(
        (a, b) => a.hunk.baseEnd - a.hunk.baseStart - (b.hunk.baseEnd - b.hunk.baseStart),
      );
      let next = i + 1;
      for (const hit of ordered) {
        out.push(...hit.hunk.newLines);
        next = Math.max(next, hit.hunk.baseEnd);
      }
      i = next;
    } else {
      // Insertion anchors at this position (pure insertions, baseStart == baseEnd).
      for (const side of sides) {
        for (const hunk of side.hunks) {
          if (hunk.baseStart === i && hunk.baseEnd === i) {
            out.push(...hunk.newLines);
          }
        }
      }
      const line = baseLines[i];
      if (line !== undefined) out.push(line);
      i += 1;
    }
  }
  // Trailing pure insertions at region.end.
  for (const side of sides) {
    for (const hunk of side.hunks) {
      if (hunk.baseStart === region.end && hunk.baseEnd === region.end) {
        out.push(...hunk.newLines);
      }
    }
  }
  return out;
}

function resolveRegion(
  file: string,
  region: { start: number; end: number },
  sides: RegionSide[],
  baseLines: string[],
  choices: Map<string, string>,
  conflicts: ConflictRecord[],
  dropped: DroppedHunkRecord[],
): string[] {
  if (sides.length === 0) return baseLines.slice(region.start, region.end);
  const firstSide = sides[0];
  if (firstSide === undefined) return baseLines.slice(region.start, region.end);
  if (sides.length === 1) return firstSide.replacement;
  // Agreement: all sides produced identical replacements.
  const first = firstSide.replacement.join("\n");
  if (sides.every((s) => s.replacement.join("\n") === first)) {
    return firstSide.replacement;
  }
  const key = `${file}:${region.start}:${region.end}`;
  // Disjoint rule.
  const disjoint = applyDisjoint(region, sides, baseLines);
  if (disjoint !== null) return disjoint;
  // Subset rule: one side's replacement is a strict subsequence of
  // another's — take the superset, record the drop.
  for (const a of sides) {
    for (const b of sides) {
      if (a === b) continue;
      if (a.replacement.length < b.replacement.length && isSubsequence(a.replacement, b.replacement)) {
        dropped.push({
          file,
          juror: a.juror,
          rule: "subset",
          detail: `replacement is a strict subsequence of ${b.juror}'s replacement at base lines ${region.start + 1}-${region.end}`,
        });
        return b.replacement;
      }
    }
  }
  // Test-pick choice from the arbitrator (last resort before DIVERGED).
  const chosen = choices.get(key);
  if (chosen !== undefined) {
    const winner = sides.find((s) => s.juror === chosen);
    if (winner !== undefined) {
      for (const side of sides) {
        if (side.juror !== chosen) {
          dropped.push({
            file,
            juror: side.juror,
            rule: "tests",
            detail: `conflict at base lines ${region.start + 1}-${region.end} resolved for ${chosen} by test run`,
          });
        }
      }
      conflicts.push({
        file,
        baseLines: { start: region.start + 1, end: region.end },
        sides: Object.fromEntries(sides.map((s) => [s.juror, s.replacement])),
        rule: "tests",
        winner: chosen,
      });
      return winner.replacement;
    }
  }
  // Unresolved: conflict markers in the merged output, both sides kept.
  const out: string[] = [];
  const names = sides.map((s) => s.juror).join(" vs ");
  out.push(`<<<<<<< triangulate: conflict (${names})`);
  sides.forEach((side, index) => {
    if (index > 0) out.push("=======");
    out.push(...side.replacement);
  });
  out.push(">>>>>>> triangulate");
  conflicts.push({
    file,
    baseLines: { start: region.start + 1, end: region.end },
    sides: Object.fromEntries(sides.map((s) => [s.juror, s.replacement])),
    rule: "unresolved",
  });
  return out;
}

function isCodeFile(path: string): boolean {
  return /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(path);
}

/**
 * A test-pick choice for a whole-file conflict (`${file}:whole`):
 * records the win (rule "tests") and the losers' drops, and returns
 * the winning juror id — or null when no choice applies. The caller
 * applies the winner's side (content, or deletion when the winner is
 * a deleter). Without this, whole-file conflicts were test-picked for
 * a choice the differ could never apply (F6).
 */
function applyWholeFileChoice(
  path: string,
  sides: Record<string, string[]>,
  choices: Map<string, string>,
  conflicts: ConflictRecord[],
  dropped: DroppedHunkRecord[],
): string | null {
  const winner = choices.get(`${path}:whole`);
  if (winner === undefined) return null;
  if (sides[winner] === undefined) return null;
  for (const juror of Object.keys(sides).sort()) {
    if (juror !== winner) {
      dropped.push({
        file: path,
        juror,
        rule: "tests",
        detail: `whole-file conflict resolved for ${winner} by test run`,
      });
    }
  }
  conflicts.push({
    file: path,
    baseLines: null,
    sides: truncatedSides(sides),
    rule: "tests",
    winner,
  });
  return winner;
}

export function mergeCandidates(
  base: FileMap,
  candidates: CandidateSnapshot[],
  options: MergeOptions = {},
): MergeResult {
  const choices = options.choices ?? new Map<string, string>();
  const conflicts: ConflictRecord[] = [];
  const dropped: DroppedHunkRecord[] = [];
  const astRefined: string[] = [];
  const merged: FileMap = new Map();
  const sorted = [...candidates].sort((a, b) => (a.juror < b.juror ? -1 : 1));

  const allPaths = new Set<string>([...base.keys()]);
  for (const c of sorted) for (const p of c.files.keys()) allPaths.add(p);

  for (const path of [...allPaths].sort()) {
    const baseContent = base.get(path);
    const holders = sorted.filter((c) => c.files.has(path));
    const deleters = sorted.filter((c) => baseContent !== undefined && !c.files.has(path));

    if (baseContent === undefined) {
      // Added file.
      if (holders.length === 0) continue;
      const contents = holders.map((h) => h.files.get(path) as string);
      const firstContent = contents[0];
      if (firstContent !== undefined && contents.every((c) => c === firstContent)) {
        merged.set(path, firstContent);
        continue;
      }
      // Subset rule on whole-file content.
      const lines = contents.map((c) => splitLines(c));
      let resolved = false;
      for (let i = 0; i < holders.length && !resolved; i += 1) {
        for (let j = 0; j < holders.length; j += 1) {
          if (i === j) continue;
          const li = lines[i];
          const lj = lines[j];
          const hi = holders[i];
          const hj = holders[j];
          if (
            li !== undefined &&
            lj !== undefined &&
            hi !== undefined &&
            hj !== undefined &&
            li.length < lj.length &&
            isSubsequence(li, lj)
          ) {
            dropped.push({
              file: path,
              juror: hi.juror,
              rule: "subset",
              detail: `added file is a strict subsequence of ${hj.juror}'s version`,
            });
            const cj = contents[j];
            if (cj !== undefined) merged.set(path, cj);
            resolved = true;
            break;
          }
        }
      }
      if (resolved) continue;
      const sides: Record<string, string[]> = {};
      for (let i = 0; i < holders.length; i += 1) {
        const holder = holders[i];
        const content = lines[i];
        if (holder !== undefined && content !== undefined) sides[holder.juror] = content;
      }
      // Test-pick choice (F6): the winner's content becomes the file.
      const wholeWinner = applyWholeFileChoice(path, sides, choices, conflicts, dropped);
      if (wholeWinner !== null) {
        const winnerIndex = holders.findIndex((h) => h.juror === wholeWinner);
        const winnerContent = winnerIndex >= 0 ? contents[winnerIndex] : undefined;
        if (winnerContent !== undefined) merged.set(path, winnerContent);
        continue;
      }
      conflicts.push({ file: path, baseLines: null, sides: truncatedSides(sides), rule: "unresolved" });
      const out: string[] = ["<<<<<<< triangulate: conflict (added file)"];
      holders.forEach((h, i) => {
        if (i > 0) out.push("=======");
        const content = lines[i];
        if (content !== undefined) out.push(...content);
      });
      out.push(">>>>>>> triangulate");
      merged.set(path, joinLines(out));
      continue;
    }

    if (holders.length === 0) {
      // Deleted by every candidate that touches it — or untouched.
      if (deleters.length === sorted.length) {
        // Deleted by all jurors: agreement.
        continue;
      }
      if (deleters.length > 0) {
        // Some jurors deleted it, others left it alone: the file stays
        // (deletion needs agreement; the dissent records it).
        merged.set(path, baseContent);
        continue;
      }
      merged.set(path, baseContent);
      continue;
    }

    if (deleters.length > 0) {
      // Delete vs modify conflict.
      const modifiers = holders.filter((h) => h.files.get(path) !== baseContent);
      if (modifiers.length === 0) {
        // Delete vs keep: some jurors deleted the file, the rest left
        // it untouched. The file stays — deletion needs agreement —
        // and the disagreement is recorded as an unresolved whole-file
        // conflict (F4), never silently dropped (D-6). Test-pick may
        // resolve it (F6): a deleter win deletes the file, a keeper
        // win keeps it.
        const keepers = holders.filter((h) => h.files.get(path) === baseContent);
        const sides: Record<string, string[]> = {};
        for (const d of deleters) sides[d.juror] = [];
        for (const k of keepers) sides[k.juror] = splitLines(baseContent);
        const winner = applyWholeFileChoice(path, sides, choices, conflicts, dropped);
        if (winner !== null) {
          if (!deleters.some((d) => d.juror === winner)) {
            merged.set(path, baseContent);
          }
          // A deleter win: the file is not set in the merge (deleted).
        } else {
          conflicts.push({
            file: path,
            baseLines: null,
            sides: truncatedSides(sides),
            rule: "unresolved",
          });
          merged.set(path, baseContent);
        }
        continue;
      }
      const sides: Record<string, string[]> = {};
      for (const d of deleters) sides[d.juror] = [];
      for (const m of modifiers) {
        const content = m.files.get(path);
        if (content !== undefined) sides[m.juror] = splitLines(content);
      }
      const winner = applyWholeFileChoice(path, sides, choices, conflicts, dropped);
      if (winner !== null) {
        if (deleters.some((d) => d.juror === winner)) {
          // Winner deleted the file: do not set it in the merge.
        } else {
          const content = modifiers.find((m) => m.juror === winner)?.files.get(path);
          if (content !== undefined) merged.set(path, content);
        }
        continue;
      }
      conflicts.push({
        file: path,
        baseLines: null,
        sides: truncatedSides(sides),
        rule: "unresolved",
      });
      merged.set(path, baseContent);
      continue;
    }

    // Modified by one or more jurors.
    const modifiers = holders.filter((h) => h.files.get(path) !== baseContent);
    if (modifiers.length === 0) {
      merged.set(path, baseContent);
      continue;
    }
    if (modifiers.length === 1) {
      const content = modifiers[0]?.files.get(path);
      if (content !== undefined) merged.set(path, content);
      continue;
    }

    // AST node merge first for code files: if the candidates changed
    // disjoint top-level named nodes, splice node texts (rule
    // "ast-disjoint" is implicit — the file lands in astRefined).
    if (isCodeFile(path)) {
      const astResult = tryAstMerge(
        baseContent,
        new Map(modifiers.map((m) => [m.juror, m.files.get(path) as string])),
        path,
      );
      if (astResult !== null) {
        merged.set(path, astResult);
        astRefined.push(path);
        continue;
      }
    }

    // Line merge.
    const baseLines = splitLines(baseContent);
    const perJurorHunks = new Map<string, Hunk[]>();
    let oversize = false;
    for (const m of modifiers) {
      const content = m.files.get(path) as string;
      if (
        Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES ||
        splitLines(content).length > MAX_FILE_LINES
      ) {
        oversize = true;
        break;
      }
      try {
        perJurorHunks.set(m.juror, opsToHunks(diffLines(baseLines, splitLines(content))));
      } catch {
        oversize = true;
        break;
      }
    }
    if (oversize) {
      // Whole-file replacement conflict: too big to diff line by line.
      // Sides are truncated in the record (S-8); test-pick applies
      // the winner's full content from the candidate snapshot (F6).
      const sides: Record<string, string[]> = Object.fromEntries(
        modifiers.map((m) => [m.juror, splitLines(m.files.get(path) as string)]),
      );
      const winner = applyWholeFileChoice(path, sides, choices, conflicts, dropped);
      if (winner !== null) {
        const content = modifiers.find((m) => m.juror === winner)?.files.get(path);
        if (content !== undefined) merged.set(path, content);
        continue;
      }
      conflicts.push({
        file: path,
        baseLines: null,
        sides: truncatedSides(sides),
        rule: "unresolved",
      });
      merged.set(path, baseContent);
      continue;
    }
    const mergedLines = mergeFileLines(path, baseLines, perJurorHunks, choices, conflicts, dropped);
    merged.set(path, joinLines(mergedLines));
  }

  return { merged, conflicts, dropped, astRefined };
}

/** Hash of a candidate's unified diff (for JurorRecord.candidateHash). */
export function diffHash(diff: string): string {
  return canonicalHash(diff);
}
