// SPDX-License-Identifier: Apache-2.0
// Writing a file inside a directory tree when the path comes from
// untrusted content (a model response): every path component that
// already exists must be a real directory — never a symlink — the
// final target must not be a symlink, and the open itself uses
// O_NOFOLLOW. Together that means a file map cannot redirect a write
// outside the tree (S-7), not even through a symlinked directory
// committed in the base repo, and not even to the worktree's own
// `.git` pointer (which parseFileMap rejects separately).

import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

/** Resolve `relativePath` under `root`, refusing symlink escapes. */
export async function resolveSafeTarget(root: string, relativePath: string): Promise<string> {
  const parts = relativePath.split("/").filter((p) => p.length > 0 && p !== ".");
  if (parts.length === 0) throw new Error(`refusing to write empty path under ${root}`);
  let cur = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i] as string;
    cur = join(cur, part);
    try {
      const st = await lstat(cur);
      if (st.isSymbolicLink()) {
        throw new Error(`refusing to write through symlinked directory: ${relativePath}`);
      }
      if (!st.isDirectory()) {
        throw new Error(`path component is not a directory: ${relativePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break; // rest does not exist yet
      throw error;
    }
  }
  const target = join(root, ...parts);
  try {
    const st = await lstat(target);
    if (st.isSymbolicLink()) {
      throw new Error(`refusing to write through symlink: ${relativePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return target;
}

/** Write `content` to `relativePath` under `root`, never following a symlink. */
export async function writeFileWithin(root: string, relativePath: string, content: string): Promise<void> {
  const target = await resolveSafeTarget(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  // mkdir -p follows symlinks in the parent chain, so re-check the
  // real parent after creating it: it must still be inside the root.
  const rootReal = await realpath(root);
  const parentReal = await realpath(dirname(target));
  if (parentReal !== rootReal && !parentReal.startsWith(rootReal + sep)) {
    throw new Error(`refusing to write outside ${root}: ${relativePath}`);
  }
  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}
