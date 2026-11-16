// SPDX-License-Identifier: Apache-2.0
// Regression tests for the interactive passphrase prompt
// (src/core/passphrase.ts), in particular N13: EOF at the prompt must
// be a clean error, never a hang.
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { PassphraseError, readLineOrThrow } from "../src/core/passphrase.js";

test("passphrase: EOF with no line rejects cleanly instead of hanging (N13)", async () => {
  await assert.rejects(readLineOrThrow(Readable.from([])), (error: unknown) => {
    assert.ok(error instanceof PassphraseError);
    assert.match(error.message, /end of input/);
    return true;
  });
});

test("passphrase: a line followed by EOF resolves the line (N13)", async () => {
  assert.equal(await readLineOrThrow(Readable.from(["secret\n"])), "secret");
  // No trailing newline: readline still delivers the buffered line.
  assert.equal(await readLineOrThrow(Readable.from(["no-newline"])), "no-newline");
});
