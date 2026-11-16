// SPDX-License-Identifier: Apache-2.0
// Smoke run: end-to-end CLI exercise with fake jurors ($0, no model
// credentials), plus a real-adapter --dry-run to show the exact
// commands a live run would execute. Run with `npm run smoke`.
// Exits non-zero on any failed check.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
};

const repo = await mkdtemp(join(tmpdir(), "tri-smoke-"));
const home = await mkdtemp(join(tmpdir(), "tri-smoke-home-"));
const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
git("init", "-b", "master");
git("config", "user.email", "smoke@local");
git("config", "user.name", "Smoke");
await writeFile(
  join(repo, "src.js"),
  "export function add(a, b) {\n  return a + b;\n}\n",
  "utf8",
);
await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
git("add", ".");
git("commit", "-m", "init");

const tri = new URL("../dist/cli.js", import.meta.url).pathname;
const env = { ...process.env, TRIANGULATE_HOME: home };
const run = (args) =>
  spawnSync("node", [tri, ...args], { encoding: "utf8", env });

// 1. Fake run end to end.
const out = join(repo, "verdict.json");
const fake = run([
  "run",
  "--task",
  "add a subtract function next to add",
  "--repo",
  repo,
  "--models",
  "claude,codex,gemini,grok",
  "--fake",
  "--no-test",
  "--out",
  out,
]);
check("fake run exits 0", fake.status === 0, fake.stderr.trim().split("\n").pop() ?? "");
const verdict = JSON.parse(await readFile(out, "utf8"));
check("verdict format is triangulate/1", verdict.format === "triangulate/1");
check("verdict tier is MAJORITY", verdict.tier === "MAJORITY", verdict.tier);
check("four jurors recorded", verdict.jurors.length === 4);
const { GrokAdapter } = await import("../dist/adapters/grok.js");
check("real grok adapter is labelled api", new GrokAdapter().kind === "api");

// 2. verify / show / diff round-trip.
check("verify passes", run(["verify", out]).status === 0);
check("show exits 0", run(["show", out]).status === 0);
const diff = run(["diff", out]);
check("diff prints the merged diff", diff.status === 0 && diff.stdout.includes("notes/"));

// 3. Tampered verdict fails verification.
const tampered = { ...verdict, tier: "UNANIMOUS" };
await writeFile(out, JSON.stringify(tampered), "utf8");
check("tampered verdict fails verify (exit 2)", run(["verify", out]).status === 2);

// 4. Real-adapter dry run: shows the exact commands, runs nothing.
const dry = run([
  "run",
  "--task",
  "add a subtract function",
  "--repo",
  repo,
  "--models",
  "claude,codex,gemini,grok",
  "--dry-run",
]);
check("dry run exits 0", dry.status === 0);
check("dry run shows claude command", dry.stdout.includes("claude -p"));
check("dry run shows codex command", dry.stdout.includes("codex exec"));
check("dry run shows gemini command", dry.stdout.includes("gemini -p"));
check("dry run shows grok api", dry.stdout.includes("grok-api"));

// 5. The log was appended.
const log = await readFile(join(home, "log.jsonl"), "utf8");
check("log contains the verdict id", log.includes(verdict.id));

console.log(process.exitCode === 1 ? "smoke: FAILED" : "smoke: all checks passed");
