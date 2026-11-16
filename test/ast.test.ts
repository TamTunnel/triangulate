// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mergeCandidates } from "../src/differ.js";
import type { FileMap } from "../src/differ.js";

function map(entries: [string, string][]): FileMap {
  return new Map(entries);
}

const BASE_TS = `export function foo(): number {
  return 1;
}

export function bar(): number {
  return 2;
}
`;

test("ast: reformat of one function + edit of another merges (ast-disjoint)", () => {
  // claude reformats foo (same AST, different whitespace) and rewrites
  // its body across many lines; gemini edits bar only. Line merge would
  // see overlapping hunks; the node merge attributes them separately.
  const reformatted = `export function foo( ): number {
  const x = 1;
  return x;
}

export function bar(): number {
  return 2;
}
`;
  const editedBar = `export function foo(): number {
  return 1;
}

export function bar(): number {
  return 3;
}
`;
  const result = mergeCandidates(map([["src/a.ts", BASE_TS]]), [
    { juror: "claude", files: map([["src/a.ts", reformatted]]) },
    { juror: "gemini", files: map([["src/a.ts", editedBar]]) },
  ]);
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(result.astRefined, ["src/a.ts"]);
  const merged = result.merged.get("src/a.ts") as string;
  assert.match(merged, /const x = 1;/);
  assert.match(merged, /return 3;/);
});

test("ast: two jurors editing the same function fall back to the line merge", () => {
  const a = `export function foo(): number {
  return 10;
}

export function bar(): number {
  return 2;
}
`;
  const b = `export function foo(): number {
  return 20;
}

export function bar(): number {
  return 2;
}
`;
  const result = mergeCandidates(map([["src/a.ts", BASE_TS]]), [
    { juror: "claude", files: map([["src/a.ts", a]]) },
    { juror: "codex", files: map([["src/a.ts", b]]) },
  ]);
  // Same node changed differently: AST merge refuses, line merge conflicts.
  assert.equal(result.astRefined.length, 0);
  assert.equal(result.conflicts.length, 1);
  const conflict = result.conflicts[0];
  assert.ok(conflict !== undefined);
  assert.equal(conflict.rule, "unresolved");
});

test("ast: a candidate adding a new function blocks AST merge", () => {
  const added = `${BASE_TS}
export function baz(): number {
  return 3;
}
`;
  const edited = `export function foo(): number {
  return 10;
}

export function bar(): number {
  return 2;
}
`;
  const result = mergeCandidates(map([["src/a.ts", BASE_TS]]), [
    { juror: "claude", files: map([["src/a.ts", added]]) },
    { juror: "gemini", files: map([["src/a.ts", edited]]) },
  ]);
  assert.equal(result.astRefined.length, 0);
  // Line merge still resolves it: the addition and the edit don't overlap.
  assert.equal(result.conflicts.length, 0);
  const merged = result.merged.get("src/a.ts") as string;
  assert.match(merged, /return 10;/);
  assert.match(merged, /function baz/);
});

test("ast: identical node changes agree", () => {
  const changed = `export function foo(): number {
  return 5;
}

export function bar(): number {
  return 2;
}
`;
  const result = mergeCandidates(map([["src/a.ts", BASE_TS]]), [
    { juror: "claude", files: map([["src/a.ts", changed]]) },
    { juror: "codex", files: map([["src/a.ts", changed]]) },
  ]);
  assert.equal(result.conflicts.length, 0);
  assert.match(result.merged.get("src/a.ts") as string, /return 5;/);
});
