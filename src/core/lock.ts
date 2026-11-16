// SPDX-License-Identifier: Apache-2.0
// Cross-process mutual exclusion via an atomic mkdir: creating a
// directory fails with EEXIST when it already exists, so the first
// creator holds the lock. Used by the hash-chained log (A-3: two
// simultaneous runs must not interleave log entries) and by keypair
// creation (two first runs must not generate different keys). A lock
// left behind by a crashed holder is stale after `staleMs` and is
// removed by the next waiter; holders finish in milliseconds, so a
// lock older than the staleness window cannot be a live holder.

import { mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const staleMs = opts.staleMs ?? 60_000;
  await mkdir(dirname(lockPath), { recursive: true });
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
  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
  }
}
