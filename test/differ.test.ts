// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import {
  DiffTooLargeError,
  diffLines,
  mergeCandidates,
  opsToHunks,
  renderUnifiedDiff,
} from "../src/differ.js";
import type { FileMap } from "../src/differ.js";

function map(entries: [string, string][]): FileMap {
  return new Map(entries);
}

test("diff: minimal edit script", () => {
  const ops = diffLines(["a", "b", "c"], ["a", "x", "c"]);
  assert.deepEqual(
    ops.map((o) => `${o.type}:${o.line}`),
    ["equal:a", "delete:b", "insert:x", "equal:c"],
  );
});

test("diff: empty inputs", () => {
  assert.deepEqual(diffLines([], []), []);
  assert.deepEqual(
    diffLines([], ["a"]).map((o) => o.type),
    ["insert"],
  );
  assert.deepEqual(
    diffLines(["a"], []).map((o) => o.type),
    ["delete"],
  );
});

test("diff: hunks are in base coordinates", () => {
  const hunks = opsToHunks(diffLines(["a", "b", "c", "d"], ["a", "x", "y", "d"]));
  assert.equal(hunks.length, 1);
  const hunk = hunks[0];
  assert.ok(hunk !== undefined);
  assert.equal(hunk.baseStart, 1);
  assert.equal(hunk.baseEnd, 3);
  assert.deepEqual(hunk.newLines, ["x", "y"]);
});

test("diff: pure insertion is an empty-range hunk", () => {
  const hunks = opsToHunks(diffLines(["a", "c"], ["a", "b", "c"]));
  assert.equal(hunks.length, 1);
  const hunk = hunks[0];
  assert.ok(hunk !== undefined);
  assert.equal(hunk.baseStart, 1);
  assert.equal(hunk.baseEnd, 1);
  assert.deepEqual(hunk.newLines, ["b"]);
});

test("renderUnifiedDiff: headers and +/- lines", () => {
  const diff = renderUnifiedDiff("f.txt", ["a", "b", "c"], ["a", "x", "c"]);
  assert.match(diff, /^--- a\/f\.txt\n\+\+\+ b\/f\.txt\n@@/);
  assert.match(diff, /^-b\n\+x\n/m);
  assert.equal(renderUnifiedDiff("f.txt", ["a"], ["a"]), "");
});

test("merge: non-overlapping changes merge cleanly", () => {
  const base = map([["f.txt", "l1\nl2\nl3\nl4\nl5"]]);
  const result = mergeCandidates(base, [
    { juror: "claude", files: map([["f.txt", "L1\nl2\nl3\nl4\nl5"]]) },
    { juror: "codex", files: map([["f.txt", "l1\nl2\nl3\nl4\nL5"]]) },
  ]);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.merged.get("f.txt"), "L1\nl2\nl3\nl4\nL5");
});

test("merge: identical changes collapse to agreement", () => {
  const base = map([["f.txt", "a\nb\nc"]]);
  const result = mergeCandidates(base, [
    { juror: "claude", files: map([["f.txt", "a\nB\nc"]]) },
    { juror: "codex", files: map([["f.txt", "a\nB\nc"]]) },
    { juror: "gemini", files: map([["f.txt", "a\nB\nc"]]) },
  ]);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.merged.get("f.txt"), "a\nB\nc");
});

test("merge: same line changed differently is an unresolved conflict", () => {
  const base = map([["f.txt", "a\nb\nc"]]);
  const result = mergeCandidates(base, [
    { juror: "claude", files: map([["f.txt", "a\nB1\nc"]]) },
    { juror: "codex", files: map([["f.txt", "a\nB2\nc"]]) },
  ]);
  assert.equal(result.conflicts.length, 1);
  const conflict = result.conflicts[0];
  assert.ok(conflict !== undefined);
  assert.equal(conflict.rule, "unresolved");
  assert.deepEqual(Object.keys(conflict.sides).sort(), ["claude", "codex"]);
  const merged = result.merged.get("f.txt") as string;
  assert.match(merged, /<<<<<<< triangulate: conflict/);
  assert.match(merged, /B1/);
  assert.match(merged, /B2/);
  assert.match(merged, />>>>>>> triangulate/);
});

test("merge: adjacent changes to different lines merge (disjoint rule)", () => {
  const base = map([["f.txt", "a\nb\nc\nd"]]);
  const result = mergeCandidates(base, [
    { juror: "claude", files: map([["f.txt", "A\nb\nc\nd"]]) },
    { juror: "codex", files: map([["f.txt", "a\nB\nc\nd"]]) },
  ]);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.merged.get("f.txt"), "A\nB\nc\nd");
});

test("merge: subset rule takes the superset and records the drop (D-6)", () => {
  const base = map([["f.txt", "a\nb\nc"]]);
  const result = mergeCandidates(base, [
    { juror: "claude", files: map([["f.txt", "a\nB\nc"]]) },
    { juror: "codex", files: map([["f.txt", "a\nB\nC2\nc"]]) },
  ]);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.merged.get("f.txt"), "a\nB\nC2\nc");
  assert.equal(result.dropped.length, 1);
  const dropped = result.dropped[0];
  assert.ok(dropped !== undefined);
  assert.equal(dropped.juror, "claude");
  assert.equal(dropped.rule, "subset");
});

test("merge: test-pick choice resolves a conflict and records it", () => {
  const base = map([["f.txt", "a\nb\nc"]]);
  const result = mergeCandidates(
    base,
    [
      { juror: "claude", files: map([["f.txt", "a\nB1\nc"]]) },
      { juror: "codex", files: map([["f.txt", "a\nB2\nc"]]) },
    ],
    { choices: new Map([["f.txt:1:2", "codex"]]) },
  );
  assert.equal(result.merged.get("f.txt"), "a\nB2\nc");
  assert.equal(result.conflicts.length, 1);
  const conflict = result.conflicts[0];
  assert.ok(conflict !== undefined);
  assert.equal(conflict.rule, "tests");
  assert.equal(conflict.winner, "codex");
  assert.equal(result.dropped.length, 1);
  const dropped = result.dropped[0];
  assert.ok(dropped !== undefined);
  assert.equal(dropped.rule, "tests");
});

test("merge: determinism — juror order does not change the output (D-1)", () => {
  const base = map([
    ["f.txt", "a\nb\nc\nd\ne\nf"],
    ["g.txt", "1\n2\n3"],
  ]);
  const candidates = [
    { juror: "claude", files: map([["f.txt", "A\nb\nc\nd\ne\nf"], ["g.txt", "1\n2\n3"]]) },
    { juror: "codex", files: map([["f.txt", "a\nb\nC\nd\ne\nf"], ["g.txt", "1\n2\n3"]]) },
    { juror: "gemini", files: map([["f.txt", "a\nb\nc\nd\nE\nf"], ["g.txt", "1\n2\n3"]]) },
  ];
  const r1 = mergeCandidates(base, candidates);
  const r2 = mergeCandidates(base, [...candidates].reverse());
  const [c0, c1, c2] = candidates;
  assert.ok(c0 !== undefined && c1 !== undefined && c2 !== undefined);
  const r3 = mergeCandidates(base, [c2, c0, c1]);
  assert.equal(r1.merged.get("f.txt"), r2.merged.get("f.txt"));
  assert.equal(r1.merged.get("f.txt"), r3.merged.get("f.txt"));
  assert.deepEqual(r1.conflicts, r2.conflicts);
});

test("merge: added file — identical content agrees, different content conflicts", () => {
  const base = map([]);
  const agree = mergeCandidates(base, [
    { juror: "claude", files: map([["new.txt", "hello"]]) },
    { juror: "codex", files: map([["new.txt", "hello"]]) },
  ]);
  assert.equal(agree.conflicts.length, 0);
  assert.equal(agree.merged.get("new.txt"), "hello");

  const clash = mergeCandidates(base, [
    { juror: "claude", files: map([["new.txt", "hello"]]) },
    { juror: "codex", files: map([["new.txt", "goodbye"]]) },
  ]);
  assert.equal(clash.conflicts.length, 1);
  const conflict = clash.conflicts[0];
  assert.ok(conflict !== undefined);
  assert.equal(conflict.baseLines, null);
});

test("merge: delete vs modify is a conflict; delete by all is agreement", () => {
  const base = map([["f.txt", "a\nb"]]);
  const clash = mergeCandidates(base, [
    { juror: "claude", files: map([]) },
    { juror: "codex", files: map([["f.txt", "a\nB"]]) },
  ]);
  assert.equal(clash.conflicts.length, 1);
  assert.equal(clash.merged.get("f.txt"), "a\nb");

  const agree = mergeCandidates(base, [
    { juror: "claude", files: map([]) },
    { juror: "codex", files: map([]) },
  ]);
  assert.equal(agree.conflicts.length, 0);
  assert.equal(agree.merged.has("f.txt"), false);
});

test("merge: every candidate hunk appears somewhere (D-6)", () => {
  const base = map([["f.txt", "a\nb\nc\nd"]]);
  const result = mergeCandidates(base, [
    { juror: "claude", files: map([["f.txt", "A\nb\nc\nd"]]) },
    { juror: "codex", files: map([["f.txt", "a\nB\nc\nd"]]) },
    { juror: "gemini", files: map([["f.txt", "a\nb\nC\nd"]]) },
  ]);
  // All three single-line changes are non-overlapping: the merged file
  // must contain all of them, with no conflict and no drop.
  assert.equal(result.merged.get("f.txt"), "A\nB\nC\nd");
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.dropped.length, 0);
});

test("merge: delete vs keep is recorded and the file stays (F4, D-6)", () => {
  const base = map([["victim.txt", "keep me\n"]]);
  const result = mergeCandidates(base, [
    { juror: "claude", files: map([]) },
    { juror: "codex", files: map([["victim.txt", "keep me\n"]]) },
  ]);
  // Deletion needs agreement: the file stays, and the disagreement is
  // on the record as an unresolved whole-file conflict.
  assert.equal(result.merged.get("victim.txt"), "keep me\n");
  assert.equal(result.conflicts.length, 1);
  const conflict = result.conflicts[0];
  assert.ok(conflict !== undefined);
  assert.equal(conflict.rule, "unresolved");
  assert.equal(conflict.baseLines, null);
  assert.deepEqual(Object.keys(conflict.sides).sort(), ["claude", "codex"]);
  assert.deepEqual(conflict.sides["claude"], []);
});

test("merge: delete + insertion at the same anchor both survive, either juror order (F5)", () => {
  const base = map([["f.txt", "l1\nl2\nl3\nl4\nl5\nl6\nl7\n"]]);
  const del = map([["f.txt", "l1\nl2\nl3\nl4\nl6\nl7\n"]]);
  const ins = map([["f.txt", "l1\nl2\nl3\nl4\nINSERTED\nl5\nl6\nl7\n"]]);
  for (const candidates of [
    [
      { juror: "aaa", files: del },
      { juror: "bbb", files: ins },
    ],
    [
      { juror: "aaa", files: ins },
      { juror: "zzz", files: del },
    ],
  ]) {
    const result = mergeCandidates(base, candidates);
    const merged = result.merged.get("f.txt") ?? "";
    assert.ok(merged.includes("INSERTED"), `insertion survived: ${JSON.stringify(merged)}`);
    assert.equal(
      merged.split("\n").includes("l5"),
      false,
      `deletion survived: ${JSON.stringify(merged)}`,
    );
    assert.equal(result.dropped.length, 0);
  }
});

test("merge: whole-file test-pick choice resolves an added-file conflict (F6)", () => {
  const base = map([]);
  const result = mergeCandidates(
    base,
    [
      { juror: "claude", files: map([["new.txt", "side A\n"]]) },
      { juror: "codex", files: map([["new.txt", "side B\n"]]) },
    ],
    { choices: new Map([["new.txt:whole", "codex"]]) },
  );
  assert.equal(result.merged.get("new.txt"), "side B\n");
  assert.equal(result.conflicts.length, 1);
  const conflict = result.conflicts[0];
  assert.ok(conflict !== undefined);
  assert.equal(conflict.rule, "tests");
  assert.equal(conflict.winner, "codex");
  assert.equal(result.dropped.length, 1);
  const dropped = result.dropped[0];
  assert.ok(dropped !== undefined);
  assert.equal(dropped.juror, "claude");
  assert.equal(dropped.rule, "tests");
});

test("merge: whole-file test-pick choice resolves delete vs keep (F6)", () => {
  const base = map([["victim.txt", "keep me\n"]]);
  const result = mergeCandidates(
    base,
    [
      { juror: "claude", files: map([]) },
      { juror: "codex", files: map([["victim.txt", "keep me\n"]]) },
    ],
    { choices: new Map([["victim.txt:whole", "claude"]]) },
  );
  assert.equal(result.merged.has("victim.txt"), false);
  const conflict = result.conflicts[0];
  assert.ok(conflict !== undefined);
  assert.equal(conflict.rule, "tests");
  assert.equal(conflict.winner, "claude");
});

test("diff: edit distance past the trace budget throws DiffTooLargeError (F8)", () => {
  const a = Array.from({ length: 4000 }, (_, i) => `base-line-${i}`);
  const b = Array.from({ length: 4000 }, (_, i) => `cand-line-${i}`);
  assert.throws(() => diffLines(a, b), DiffTooLargeError);
});

test("merge: two 20k-line files with no common lines become a whole-file conflict, no OOM (F8)", () => {
  const a = Array.from({ length: 20_000 }, (_, i) => `base-line-${i}`).join("\n");
  const b = Array.from({ length: 20_000 }, (_, i) => `cand-line-${i}`).join("\n");
  const c = Array.from({ length: 20_000 }, (_, i) => `other-line-${i}`).join("\n");
  const result = mergeCandidates(map([["f.txt", a]]), [
    { juror: "claude", files: map([["f.txt", b]]) },
    { juror: "codex", files: map([["f.txt", c]]) },
  ]);
  assert.equal(result.conflicts.length, 1);
  const conflict = result.conflicts[0];
  assert.ok(conflict !== undefined);
  assert.equal(conflict.rule, "unresolved");
  // Sides are truncated in the record (S-8).
  const sides = conflict.sides["claude"] ?? [];
  assert.ok(sides.length <= 101);
  assert.match(sides[sides.length - 1] ?? "", /truncated/);
  assert.equal(result.merged.get("f.txt"), a);
});

test("renderUnifiedDiff: oversize input renders a placeholder, never throws (F3)", () => {
  const big = Array.from({ length: 20_001 }, (_, i) => `line ${i}`);
  const diff = renderUnifiedDiff("big.txt", [], big);
  assert.match(diff, /oversize/);
  assert.equal(diff.includes("line 20000"), false);
});
