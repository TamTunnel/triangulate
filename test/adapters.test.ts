// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAdapter } from "../src/adapters/fake.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { GeminiAdapter } from "../src/adapters/gemini.js";
import { GrokAdapter } from "../src/adapters/grok.js";
import { redactSecrets, scopedEnv, truncateOutput } from "../src/adapters/types.js";
import type { JurorRunInput } from "../src/adapters/types.js";

function input(overrides: Partial<JurorRunInput> = {}): JurorRunInput {
  return {
    task: "do the thing",
    worktree: "/tmp/nowhere",
    timeoutMs: 5000,
    budgetMinor: 0,
    env: {},
    ...overrides,
  };
}

test("fake: pass writes and deletes files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tri-fake-"));
  await writeFile(join(dir, "old.txt"), "old", "utf8");
  const adapter = new FakeAdapter("fake-a", {
    files: { "a.txt": "hello", "old.txt": null },
    costMinor: 250,
    modelVersion: "fake-2.0",
  });
  const result = await adapter.run(input({ worktree: dir }));
  assert.equal(result.status, "ok");
  assert.equal(result.costMinor, 250);
  assert.equal(result.modelVersion, "fake-2.0");
  assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "hello");
  await assert.rejects(readFile(join(dir, "old.txt"), "utf8"));
});

test("fake: fail, budget, and timeout behaviors", async () => {
  const fail = await new FakeAdapter("f", { files: {}, behavior: "fail" }).run(input());
  assert.equal(fail.status, "failed");
  assert.equal(fail.costMinor, null);

  const budget = await new FakeAdapter("f", { files: {}, behavior: "budget" }).run(
    input({ budgetMinor: 500 }),
  );
  assert.equal(budget.status, "budget");
  assert.equal(budget.costMinor, 501);

  const started = Date.now();
  const timeout = await new FakeAdapter("f", { files: {}, behavior: "timeout" }).run(
    input({ timeoutMs: 100 }),
  );
  assert.equal(timeout.status, "timeout");
  assert.ok(Date.now() - started < 2000, "fake timeout must not hang the test");
});

test("adapters: dry-run returns the exact command without running it", async () => {
  const claude = await new ClaudeAdapter().run(input({ dryRun: true }));
  assert.equal(claude.status, "ok");
  assert.deepEqual(claude.command?.slice(0, 2), ["claude", "-p"]);

  const codex = await new CodexAdapter().run(input({ dryRun: true }));
  assert.equal(codex.status, "ok");
  assert.deepEqual(codex.command?.slice(0, 2), ["codex", "exec"]);
  assert.ok(codex.command?.includes("workspace-write"));

  const gemini = await new GeminiAdapter().run(input({ dryRun: true }));
  assert.equal(gemini.status, "ok");
  assert.deepEqual(gemini.command?.slice(0, 2), ["gemini", "-p"]);

  const grok = await new GrokAdapter().run(input({ dryRun: true, env: { GROK_MODEL: "grok-4" } }));
  assert.equal(grok.status, "ok");
  assert.equal(grok.command?.[1], "grok-4");
});

test("claude/gemini: missing binary fails cleanly (never hangs, never invents output)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tri-missing-"));
  const claude = await new ClaudeAdapter().run(input({ worktree: dir, timeoutMs: 5000 }));
  assert.equal(claude.status, "failed");
  assert.match(claude.reason ?? "", /not found/);
  const gemini = await new GeminiAdapter().run(input({ worktree: dir, timeoutMs: 5000 }));
  assert.equal(gemini.status, "failed");
  assert.match(gemini.reason ?? "", /not found/);
});

test("grok: applies a valid file map, rejects traversal and bad JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tri-grok-"));
  const originalFetch = globalThis.fetch;
  try {
    const fakeResponse = (content: string) => ({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          model: "grok-4",
          choices: [{ message: { content } }],
        }),
    });
    globalThis.fetch = () =>
      Promise.resolve(fakeResponse(JSON.stringify({ "src/a.ts": "export const a = 1;\n" })) as never);
    const ok = await new GrokAdapter().run(
      input({ worktree: dir, env: { XAI_API_KEY: "xai-test-key" } }),
    );
    assert.equal(ok.status, "ok");
    assert.equal(ok.modelVersion, "grok-4");
    assert.equal(await readFile(join(dir, "src/a.ts"), "utf8"), "export const a = 1;\n");

    globalThis.fetch = () =>
      Promise.resolve(fakeResponse(JSON.stringify({ "../escape.txt": "x" })) as never);
    const traversal = await new GrokAdapter().run(
      input({ worktree: dir, env: { XAI_API_KEY: "xai-test-key" } }),
    );
    assert.equal(traversal.status, "failed");

    globalThis.fetch = () => Promise.resolve(fakeResponse("not json at all") as never);
    const bad = await new GrokAdapter().run(
      input({ worktree: dir, env: { XAI_API_KEY: "xai-test-key" } }),
    );
    assert.equal(bad.status, "failed");

    const noKey = await new GrokAdapter().run(input({ worktree: dir, env: {} }));
    assert.equal(noKey.status, "failed");
    assert.match(noKey.reason ?? "", /XAI_API_KEY/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("grok: file map cannot overwrite .git or write through a symlink (F2, S-2/S-7)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tri-grok2-"));
  await writeFile(join(dir, "a.txt"), "hello\n", "utf8");
  const originalFetch = globalThis.fetch;
  try {
    const fakeResponse = (content: string) => ({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          model: "grok-4",
          choices: [{ message: { content } }],
        }),
    });
    // `.git` pointer overwrite (the P7 attack): rejected, file untouched.
    await writeFile(join(dir, ".git"), "gitdir: /tmp/real-git-dir\n", "utf8");
    globalThis.fetch = () =>
      Promise.resolve(
        fakeResponse(JSON.stringify({ ".git": "gitdir: /tmp/evil-git-dir", "a.txt": "hi\n" })) as never,
      );
    const gitAttack = await new GrokAdapter().run(
      input({ worktree: dir, env: { XAI_API_KEY: "xai-test-key" } }),
    );
    assert.equal(gitAttack.status, "failed");
    assert.equal(await readFile(join(dir, ".git"), "utf8"), "gitdir: /tmp/real-git-dir\n");
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "hello\n");

    // `.git/config` nested path: rejected too.
    globalThis.fetch = () =>
      Promise.resolve(
        fakeResponse(JSON.stringify({ ".git/config": "[core]\n" })) as never,
      );
    const nested = await new GrokAdapter().run(
      input({ worktree: dir, env: { XAI_API_KEY: "xai-test-key" } }),
    );
    assert.equal(nested.status, "failed");

    // Write through a symlinked directory: rejected, outside file untouched.
    const outside = await mkdtemp(join(tmpdir(), "tri-outside-"));
    const outsideFile = join(outside, "target.txt");
    await writeFile(outsideFile, "untouched", "utf8");
    await symlink(outside, join(dir, "link"));
    globalThis.fetch = () =>
      Promise.resolve(
        fakeResponse(JSON.stringify({ "link/evil.txt": "pwned" })) as never,
      );
    const linkAttack = await new GrokAdapter().run(
      input({ worktree: dir, env: { XAI_API_KEY: "xai-test-key" } }),
    );
    assert.equal(linkAttack.status, "failed");
    assert.equal(await readFile(outsideFile, "utf8"), "untouched");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("redaction: key-shaped values never survive (S-1)", () => {
  const dirty =
    "key sk-ant-api03-abcdef1234567890 and xai-abcdef1234 and AKIAIOSFODNN7EXAMPLE and ghp_abcdefghij1234567890 and AIzaSyA-1234567890abcdefghijklmnopqrstu and ya29.a0AfH6SMBx-abcdef1234567890";
  const clean = redactSecrets(dirty);
  assert.equal(clean.includes("sk-ant-"), false);
  assert.equal(clean.includes("xai-"), false);
  assert.equal(clean.includes("AKIA"), false);
  assert.equal(clean.includes("ghp_"), false);
  assert.equal(clean.includes("AIza"), false);
  assert.equal(clean.includes("ya29."), false);
  assert.equal(clean.includes("<redacted-key>"), true);
});

test("truncateOutput: caps at 64 KiB", () => {
  const long = "x".repeat(100_000);
  const out = truncateOutput(long);
  assert.ok(out.length < 100_000);
  assert.match(out, /truncated/);
});

test("scopedEnv: only the juror's own keys pass through (S-5)", () => {
  const env = scopedEnv(
    {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      OPENAI_API_KEY: "sk-secret",
      XAI_API_KEY: "xai-secret",
      HOME: "/home/x",
    },
    ["ANTHROPIC_API_KEY"],
  );
  assert.equal(env["ANTHROPIC_API_KEY"], "sk-ant-secret");
  assert.equal(env["OPENAI_API_KEY"], undefined);
  assert.equal(env["XAI_API_KEY"], undefined);
  assert.equal(env["PATH"], "/usr/bin");
});
