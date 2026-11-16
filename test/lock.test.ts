// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "../src/core/lock.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("lock: a slow holder is never evicted as stale (N2)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tri-lock-"));
  const lockPath = join(dir, "test.lock");
  // J5b shape: the holder takes 800ms while staleness is 100ms. The
  // heartbeat must keep its mtime fresh, so a waiter never removes a
  // live holder's lock and both never hold it at once.
  let current = 0;
  let maxConcurrent = 0;
  const holder = withFileLock(
    lockPath,
    async () => {
      current += 1;
      maxConcurrent = Math.max(maxConcurrent, current);
      await sleep(800);
      current -= 1;
    },
    { staleMs: 100 },
  );
  const waiter = withFileLock(
    lockPath,
    async () => {
      current += 1;
      maxConcurrent = Math.max(maxConcurrent, current);
      await sleep(10);
      current -= 1;
    },
    { staleMs: 100, timeoutMs: 10_000 },
  );
  await Promise.all([holder, waiter]);
  assert.equal(maxConcurrent, 1);
});

test("lock: a lock left by a crashed holder is reclaimed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tri-lock-"));
  const lockPath = join(dir, "test.lock");
  await mkdir(lockPath);
  // Age the directory past the staleness window, as a crashed holder
  // would leave it: no heartbeat is running, so it is genuinely stale.
  const old = new Date(Date.now() - 10_000);
  await utimes(lockPath, old, old);
  let ran = false;
  await withFileLock(
    lockPath,
    async () => {
      // The lock directory exists while we hold it.
      await stat(lockPath);
      ran = true;
    },
    { staleMs: 100, timeoutMs: 5000 },
  );
  assert.equal(ran, true);
  // The lock is gone after a clean release.
  await assert.rejects(stat(lockPath), /ENOENT/);
});

test("lock: a releaser never removes a successor's lock (N2)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tri-lock-"));
  const lockPath = join(dir, "test.lock");
  await withFileLock(
    lockPath,
    async () => {
      // Simulate the frozen-holder residual: while this holder was
      // stalled, a waiter evicted its directory and re-took the lock
      // with its own owner token. Release must not remove it.
      await rm(lockPath, { recursive: true, force: true });
      await mkdir(lockPath);
      await writeFile(join(lockPath, "owner"), "successor-token", "utf8");
    },
    { staleMs: 60_000 },
  );
  // The successor's lock survived our release.
  assert.equal(await readFile(join(lockPath, "owner"), "utf8"), "successor-token");
});
