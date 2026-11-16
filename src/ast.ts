// SPDX-License-Identifier: Apache-2.0
// AST-aware refinement for TypeScript/JavaScript files (tree-sitter).
//
// When line-level hunks overlap, the differ falls back here: if the
// candidates changed disjoint top-level named declarations (functions,
// classes, interfaces, type aliases, enums), the merge splices each
// side's node text into the base. This rescues the common case where
// one juror reformats a file (a huge line diff) while another edits a
// different function. When the node sets overlap, or any change falls
// outside a named declaration, this returns null and the differ uses
// the line merge (and records the conflict there).
//
// Rules: a node is identified by kind + name. A candidate that adds a
// new top-level declaration, deletes one, or renames one blocks the AST
// merge for that file — the line merge handles those cases. Node text
// is compared exactly; whitespace-only differences count as changes.

import Parser from "tree-sitter";
import tsGrammars from "tree-sitter-typescript";
import JavaScript from "tree-sitter-javascript";
import { diffLines, opsToHunks } from "./differ.js";

// The grammar packages are CJS; the default import is the exports object.
const { typescript, tsx } = tsGrammars as { typescript: unknown; tsx: unknown };

const NAMED_DECL_KINDS = new Set([
  "function_declaration",
  "class_declaration",
  "abstract_class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
]);

interface NamedNode {
  key: string;
  /** Byte offsets into the source. */
  start: number;
  end: number;
  text: string;
}

function languageFor(path: string): unknown {
  if (/\.(ts|mts|cts)$/.test(path)) return typescript;
  if (/\.tsx$/.test(path)) return tsx;
  if (/\.(js|jsx|mjs|cjs)$/.test(path)) return JavaScript;
  return null;
}

function topLevelNodes(source: string, language: unknown): NamedNode[] | null {
  let parser: Parser;
  try {
    parser = new Parser();
    parser.setLanguage(language);
  } catch {
    return null;
  }
  const tree = parser.parse(source);
  const nodes: NamedNode[] = [];
  // Top-level declarations may be wrapped in `export_statement`
  // (`export function foo() {}`) — unwrap one level.
  const declarations: Parser.SyntaxNode[] = [];
  for (const child of tree.rootNode.namedChildren) {
    if (child.type === "export_statement") {
      declarations.push(...child.namedChildren);
    } else {
      declarations.push(child);
    }
  }
  for (const child of declarations) {
    if (!NAMED_DECL_KINDS.has(child.type)) continue;
    const nameNode = child.childForFieldName("name");
    if (nameNode === null) continue;
    nodes.push({
      key: `${child.type}:${nameNode.text}`,
      start: child.startIndex,
      end: child.endIndex,
      text: child.text,
    });
  }
  return nodes;
}

/**
 * Attempt a node-level merge. Returns the merged file content, or null
 * when the AST merge cannot apply cleanly (caller falls back to the
 * line merge).
 */
export function tryAstMerge(
  baseContent: string,
  candidates: Map<string, string>,
  path: string,
): string | null {
  const language = languageFor(path);
  if (language === null) return null;
  const baseNodes = topLevelNodes(baseContent, language);
  if (baseNodes === null) return null;
  const baseByKey = new Map(baseNodes.map((n) => [n.key, n]));

  // Every changed line must lie inside a named base node, or the merge
  // cannot attribute it. Line starts are byte offsets (tree-sitter
  // works in UTF-8 bytes); binary-search them per lookup.
  const baseLines = baseContent.split("\n");
  const lineStarts = lineStartOffsets(baseContent);
  const rowOfOffset = (byteOffset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      const midStart = lineStarts[mid];
      if (midStart === undefined) break;
      if (midStart <= byteOffset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const nodeOfLine = (row: number): NamedNode | null => {
    for (const node of baseNodes) {
      const startRow = rowOfOffset(node.start);
      const endRow = rowOfOffset(node.end);
      if (row >= startRow && row <= endRow) return node;
    }
    return null;
  };

  // Per candidate: changed node keys -> replacement text (null = deleted).
  const replacements = new Map<string, { text: string | null; start: number; end: number }>();
  for (const [juror, content] of candidates) {
    void juror;
    let hunks;
    try {
      hunks = opsToHunks(diffLines(baseLines, content.split("\n")));
    } catch {
      return null;
    }
    // Check attribution: every changed base line must be inside a node.
    const changedKeys = new Set<string>();
    for (const hunk of hunks) {
      for (let line = hunk.baseStart; line < hunk.baseEnd; line += 1) {
        const node = nodeOfLine(line);
        if (node === null) return null;
        changedKeys.add(node.key);
      }
      // Pure insertions anchor to a base position: attribute to the node
      // containing the anchor line (or the previous line at EOF).
      if (hunk.baseStart === hunk.baseEnd) {
        const anchor = Math.max(0, Math.min(hunk.baseStart, baseLines.length - 1));
        const node = nodeOfLine(anchor);
        if (node === null) return null;
        changedKeys.add(node.key);
      }
    }
    // A candidate that adds a new top-level declaration blocks the merge:
    // its new node has no base key to splice into.
    const candNodes = topLevelNodes(content, language);
    if (candNodes === null) return null;
    for (const candNode of candNodes) {
      if (!baseByKey.has(candNode.key)) return null;
    }
    for (const key of changedKeys) {
      const baseNode = baseByKey.get(key) as NamedNode;
      const candNode = candNodes.find((n) => n.key === key) ?? null;
      const text = candNode === null ? null : candNode.text;
      if (text === baseNode.text) continue;
      const existing = replacements.get(key);
      if (existing !== undefined) {
        // Another candidate already claimed this node: identical text is
        // agreement, different text is a node conflict -> fall back.
        if (existing.text !== text) return null;
        continue;
      }
      replacements.set(key, { text, start: baseNode.start, end: baseNode.end });
    }
  }

  if (replacements.size === 0) return null;
  // Splice from the end so earlier offsets stay valid. Work on bytes:
  // tree-sitter offsets are UTF-8 byte offsets.
  const buf = Buffer.from(baseContent, "utf8");
  const ordered = [...replacements.values()].sort((a, b) => b.start - a.start);
  const chunks: Buffer[] = [];
  let cursor = buf.length;
  for (const rep of ordered) {
    chunks.unshift(buf.subarray(rep.end, cursor));
    if (rep.text !== null) chunks.unshift(Buffer.from(rep.text, "utf8"));
    cursor = rep.start;
  }
  chunks.unshift(buf.subarray(0, cursor));
  return Buffer.concat(chunks).toString("utf8");
}

/** Byte offset at which each 0-based line starts. */
function lineStartOffsets(source: string): number[] {
  const buf = Buffer.from(source, "utf8");
  const starts = [0];
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x0a) starts.push(i + 1);
  }
  return starts;
}
