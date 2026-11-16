// SPDX-License-Identifier: Apache-2.0
// Cross-process mutual exclusion via an atomic mkdir: creating a
// directory fails with EEXIST when it already exists, so the first
// creator holds the lock. Used by the hash-chained log (A-3: two
// simultaneous runs must not interleave log entries) and by keypair
// creation (two first runs must not generate different keys). A lock
// left behind by a crashed holder is stale after `staleMs` and is
// removed by the next waiter.
//
// Two hazards, and how they are closed (N2):
// - A live-but-slow holder was evictable: the waiter judged staleness
//   from the lock directory's mtime, and a holder whose critical
//   section outlasted `staleMs` looked crashed. The holder now
//   heartbeats — it refreshes the directory mtime on a timer while it
//   holds the lock — so a holder that is making progress is never
//   evicted. Residual: a holder whose process is *frozen* (SIGSTOP,
//   wedged event loop) past `staleMs` can still be evicted, because a
//   frozen holder cannot heartbeat; that is inherent to any
//   mkdir-lock with stale recovery.
// - A releaser could steal a successor's lock: if holder A's lock was
//   removed as "stale" and waiter B re-took it, A's `finally` removed
//   B's directory. The lock now carries an owner token, and release
//   removes the directory only when the token still matches.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const staleMs = opts.staleMs ?? 60_000;
  await mkdir(dirname(lockPath), { recursive: true });
  const token = `${process.pid}:${Date.now()}:${randomBytes(8).toString("hex")}`;
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for lock: ${lockPath}`);
    }
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const st = await stat(lockPath);
        stale = Date.now() - st.mtimeMs > staleMs;
      } catch {
        // The lock vanished between the failed mkdir and the stat:
        // loop and try to take it.
        stale = false;
      }
      if (stale) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
      }
      await sleep(10);
    }
  }
  // We hold the lock: record ownership, then heartbeat so a waiter
  // never mistakes a live holder for a crashed one.
  await writeFile(join(lockPath, "owner"), token, "utf8");
  const heartbeat = setInterval(() => {
    utimes(lockPath, new Date(), new Date()).catch(() => undefined);
  }, Math.max(10, Math.floor(staleMs / 3)));
  heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    // Release only if we still own it. If a waiter evicted us while
    // frozen and re-took the lock, the owner file holds the successor's
    // token and removing the directory would steal their lock.
    const owner = await readFile(join(lockPath, "owner"), "utf8").catch(() => null);
    if (owner === token) {
      await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
