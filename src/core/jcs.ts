// SPDX-License-Identifier: Apache-2.0
// JCS canonicalization (RFC 8785) — JSON Canonicalization Scheme.
// Zero-dependency: used to compute content-addressed verdict ids and the
// exact bytes that get signed. The same verdict content serializes to the
// same string regardless of key order (gate probe D-4).

import { createHash } from "node:crypto";

export class CanonicalizationError extends Error {}

export const MAX_CANONICAL_DEPTH = 100;

/** Escape one string per RFC 8785 §3.2.2.2. */
function escapeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    // Lone surrogates are not well-formed JSON strings; reject them.
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        throw new CanonicalizationError("lone high surrogate in string");
      }
      out += s.charAt(i) + s.charAt(i + 1);
      i += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CanonicalizationError("lone low surrogate in string");
    }
    switch (code) {
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += "\\\\";
        break;
      case 0x08:
        out += "\\b";
        break;
      case 0x09:
        out += "\\t";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0c:
        out += "\\f";
        break;
      case 0x0d:
        out += "\\r";
        break;
      default:
        if (code < 0x20) {
          out += `\\u${code.toString(16).padStart(4, "0")}`;
        } else {
          out += s[i];
        }
    }
  }
  return `${out}"`;
}

/** Serialize one number per RFC 8785 §3.2.2.3 (ECMAScript Number::toString). */
function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new CanonicalizationError("non-finite number cannot be canonicalized");
  }
  // -0 serializes as 0.
  if (Object.is(n, -0)) return "0";
  return n.toString();
}

function canonicalizeValue(value: unknown, depth: number): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new CanonicalizationError("maximum canonicalization depth exceeded");
  }
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return serializeNumber(value);
    case "string":
      return escapeString(value);
    case "object": {
      if (Array.isArray(value)) {
        const parts: string[] = [];
        for (const item of value) {
          if (item === undefined || typeof item === "function" || typeof item === "symbol") {
            throw new CanonicalizationError("arrays must not contain undefined/function/symbol");
          }
          parts.push(canonicalizeValue(item, depth + 1));
        }
        return `[${parts.join(",")}]`;
      }
      // Plain object: keys sorted by UTF-16 code-unit order (JS default
      // string sort is exactly that). Undefined/function/symbol values are
      // dropped, matching JSON.stringify; a key whose value is dropped
      // simply does not appear.
      const entries: [string, unknown][] = [];
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
        entries.push([k, v]);
      }
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const parts = entries.map(
        ([k, v]) => `${escapeString(k)}:${canonicalizeValue(v, depth + 1)}`,
      );
      return `{${parts.join(",")}}`;
    }
    default:
      throw new CanonicalizationError(`cannot canonicalize ${typeof value}`);
  }
}

/** Serialize a JSON value to its JCS canonical form. */
export function canonicalize(value: unknown): string {
  return canonicalizeValue(value, 0);
}

/** SHA-256 hex of the JCS canonical form. */
export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}
