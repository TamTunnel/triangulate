// SPDX-License-Identifier: Apache-2.0
// Interactive passphrase prompt for the signing key (assessment §9,
// decision (c)). Prompts once per signing run on the controlling
// terminal, with echo off. Node has no built-in termios, so echo is
// toggled with the POSIX `stty` binary (present on macOS and Linux).
// If echo cannot be disabled, or there is no terminal at all, this
// throws PassphraseError — a clean error, never a stack trace — and
// the caller must fall back to TRIANGULATE_KEY_PASSPHRASE or fail.
// The passphrase is never echoed, never logged, and the returned
// Buffer is the caller's to zero after use.

import { spawnSync } from "node:child_process";
import { closeSync, createReadStream, openSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

export class PassphraseError extends Error {}

function stty(fd: number, arg: "-echo" | "echo"): void {
  const result = spawnSync("stty", [arg], { stdio: [fd, "ignore", "ignore"] });
  if (result.error !== undefined || result.status !== 0) {
    throw new PassphraseError(
      "cannot control terminal echo (stty failed); " +
        "set TRIANGULATE_KEY_PASSPHRASE to provide the signing-key passphrase",
    );
  }
}

/**
 * Read one line from a stream. Rejects cleanly on EOF (N13) instead
 * of hanging: readline emits `close` when the input ends without a
 * line, and a promise that only listens for `line`/`error` never
 * settles. Exported for tests (an empty Readable is EOF at once).
 */
export async function readLineOrThrow(stream: Readable): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    rl.once("line", (value) => {
      settle(() => {
        rl.close();
        resolvePromise(value);
      });
    });
    rl.once("close", () => {
      settle(() =>
        rejectPromise(
          new PassphraseError(
            "passphrase entry aborted (end of input); " +
              "run interactively or set TRIANGULATE_KEY_PASSPHRASE",
          ),
        ),
      );
    });
    rl.once("error", (error) => {
      settle(() => {
        rl.close();
        rejectPromise(error);
      });
    });
    stream.once("error", (error) => {
      settle(() => {
        rl.close();
        rejectPromise(error);
      });
    });
  });
}

/**
 * Prompt for a passphrase on the controlling terminal (/dev/tty when
 * available, else stdin when it is a TTY), with echo off. The prompt
 * text goes to stderr, which is the terminal in the normal case.
 */
export async function promptPassphrase(promptText: string): Promise<Buffer> {
  let ttyFd: number | null = null;
  let fd: number;
  try {
    ttyFd = openSync("/dev/tty", "r+");
    fd = ttyFd;
  } catch {
    if (process.stdin.isTTY !== true) {
      throw new PassphraseError(
        "no terminal available to prompt for the signing-key passphrase; " +
          "run interactively or set TRIANGULATE_KEY_PASSPHRASE",
      );
    }
    fd = 0;
  }
  try {
    stty(fd, "-echo");
    process.stderr.write(promptText);
    const stream = createReadStream("", { fd, autoClose: false });
    const line = await readLineOrThrow(stream);
    return Buffer.from(line, "utf8");
  } finally {
    try {
      stty(fd, "echo");
    } catch {
      // Best effort: echo is already on, or stty is gone.
    }
    process.stderr.write("\n");
    if (ttyFd !== null) closeSync(ttyFd);
  }
}
