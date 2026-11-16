# Triangulate

A multi-model coding jury. Give the same coding task to Claude, Codex, Gemini, and Grok at once, then diff what they produced, arbitrate deterministically, and merge the best output — with a signed, content-addressed verdict that records every disagreement.

## The problem

When you ask one AI model to write code, you get one answer and no way to know if it's the good one. Ask four models and you get four answers — and a new problem: which parts do they agree on, where do they disagree, and which disagreement is right? Today that means eyeballing four diffs by hand, or trusting whichever model you asked last.

## The solution, in plain language

Triangulate runs the same task on four models in parallel, each in its own private copy of your repository. It then compares their work line by line, merges the parts they agree on (or that don't overlap), and — where they genuinely conflict — lets your own project's tests decide, by trying each side and keeping the one that passes. The result is a merged change plus a **verdict**: a signed record of what each model produced, what the merge kept, what it dropped and why, and what the tests said. Anyone can verify the verdict offline, with no server and no registry — the signature and the content hash are in the file.

What Triangulate is *not*: a judge. No model grades another model here. The merge is deterministic rules plus your tests, and the verdict is a record, not a proof of correctness.

## Quick start

```sh
npm install -g @tamtunnel/triangulate
# or: npx @tamtunnel/triangulate

# One task, four jurors, in a git repository:
tri run --task "Add a subtract function next to add" --repo ./my-project

# See what happened:
tri show triangulate-verdict.json
tri diff triangulate-verdict.json

# Verify the verdict offline (no network, no registry):
tri verify triangulate-verdict.json
```

Requirements: Node 24+, a git repository (the base is `HEAD`), and the model CLIs you want to use — Claude Code (`claude`), the OpenAI Codex CLI (`codex`), the Gemini CLI (`gemini`) — plus `XAI_API_KEY` for Grok, which ships as an API adapter (there is no mature Grok coding CLI). Each juror gets only its own key; keys never appear in a verdict, a log, or an error message.

Try it without any credentials first:

```sh
tri run --task "Add a note" --repo ./my-project --fake --no-test
tri run --task "Add a note" --repo ./my-project --models claude,codex --dry-run
```

`--fake` runs scripted fake jurors ($0, no network) so you can see the whole pipeline — worktrees, merge, verdict, log. `--dry-run` prints the exact commands a live run would execute, and runs nothing.

Common flags: `--models claude,codex` (a subset), `--timeout <ms>` per juror (default 600000), `--budget <minor>` per-juror cost budget (0 = no cap), `--global-budget <minor>` cap on total spend across jurors (0 = no cap; jurors then launch one at a time and launching stops once the cumulative reported cost exceeds it — see Cost), `--test-cmd <cmd>` (default: auto-detect `npm test`), `--no-test` (skip the test check), `--redact-task` (omit the task text from the verdict — the hash stays), `--out <path>` (default `./triangulate-verdict.json`).

Your signing key lives in `~/.triangulate/` (or `$TRIANGULATE_HOME`): generated on first run, private key `0600`, never leaves the machine. The private key is passphrase-encrypted at rest (scrypt + AES-256-GCM) — `tri run` prompts for the passphrase once per run on your terminal; it is never stored, never logged, and never passed in the environment. `tri verify`, `show`, and `diff` need no passphrase (they use the public key). For non-interactive runs (CI), set `TRIANGULATE_KEY_PASSPHRASE` — note this downgrades the protection: on Linux a same-user process can read a parent's environment via `/proc`, so a passphrase supplied this way is readable by candidate code during test-pick. Every verdict is signed with it, and the public key is embedded in the verdict so anyone can verify offline. There is no registry and no revocation in v1 — if your key is lost or replaced, verdicts signed by the old key can no longer be re-signed, and a new key starts a new identity. Keep a backup of `~/.triangulate/key.pem` somewhere safe (the backup is useless without the passphrase — keep both, separately).

## How it works

```
tri run --task "..." --repo ./my-project
  │
  ├─ Orchestrator: one git worktree per juror (base = HEAD)
  │   ├─ claude  ──► claude CLI, in its own worktree
  │   ├─ codex   ──► codex CLI, in its own worktree
  │   ├─ gemini  ──► gemini CLI, in its own worktree
  │   └─ grok    ──► xAI API adapter (labelled "api" in every verdict)
  │   Each juror's candidate is captured from its worktree with git —
  │   model output is never parsed as a diff.
  │
  ├─ Differ: line-level 3-way merge, then AST-aware refinement for
  │   TypeScript/JavaScript (tree-sitter). Rules, in order:
  │   agreement → disjoint → subset → tests → unresolved (conflict
  │   markers, both sides recorded). Nothing is dropped silently:
  │   every hunk lands in the merge, a conflict, or a dropped-hunk
  │   record with a rule reference.
  │
  ├─ Arbitrator: tiers the merge (UNANIMOUS / MAJORITY / DIVERGED /
  │   FAILED), runs the repo's own test command on the merged result,
  │   and — only when the rules leave ≤ 3 conflicts — test-picks:
  │   each side is applied to the base in isolation and the tests
  │   are run; a side that passes twice wins. The final test check
  │   on the merged result never changes the tier; test-pick can
  │   resolve conflicts, which is what moves a run from DIVERGED
  │   to MAJORITY.
  │
  └─ Verdict (triangulate/1): signed (Ed25519, JCS canonicalization,
      content-addressed id = SHA-256 of the canonical payload),
      written to --out and appended to ~/.triangulate/log.jsonl
      (a hash-chained log).
```

### The verdict format (`triangulate/1`)

One JSON document: `format`, `created_at`, `tool`, `task` (text unless `--redact-task`, always the SHA-256 hash), `repo` (path + base), `jurors[]` (id, model, adapter `cli`|`api`, status, cost or `null`, duration, candidate hash), `candidates[]` (juror, unified diff, hash), `merge` (diff, conflicts with both sides + rule + winner, dropped hunks with rule references, AST-refined files), `tests` (command, exit code, output hash, flaky flag, outcome), `tier`, `dissent` (every disagreement as facts), `signer` (public key + kid). Then `id` (SHA-256 of the canonical payload) and `signature` (Ed25519 JWS over the same canonical payload). `tri verify` recomputes both offline.

### Tiers

- **UNANIMOUS** — every juror produced the identical diff.
- **MAJORITY** — the merge completed with zero unresolved conflicts (includes clean non-overlapping merges).
- **DIVERGED** — at least one conflict survives the rules and the test-pick.
- **FAILED** — no juror produced a candidate at all.

A juror that fails, times out, or blows its budget is recorded with its status and reason — never silently retried, never silently dropped from the record.

### Cost

Cost is a feature, never a claim. A juror's cost is reported only when the tool reports it (Claude's `total_cost_usd`, Codex's JSONL usage events when present); otherwise it is `null` — "unknown", never invented. The per-juror budget is enforced at completion for CLI adapters: a CLI cannot observe its own cost mid-run, so a juror whose reported cost exceeds the budget is recorded as `budget` and its candidate is excluded from the merge. The run itself is bounded mid-run by the timeout. The fake adapter enforces its budget mid-run (it is the only adapter that can). `--global-budget <minor>` caps total spend across jurors: jurors then launch one at a time, and launching stops once the cumulative reported cost exceeds the cap; jurors never launched are recorded as `budget` and the verdict records the partial state. Costs the tools do not report (`null`) cannot be counted toward the cap, so a global budget is a bound on reported spend, not on true spend.

## Honest limits

Read these before you trust a verdict:

- **A verdict is not proof of correctness.** Agreement is evidence, not truth — four models can share the same mistake. The merge can still produce broken code; the test check is your own test suite, not a guarantee.
- **Jurors are not independent.** The models have overlapping training data. Call the panel *heterogeneous*, never independent.
- **Models cost real money**, per run, per juror. The budget cap is enforced at completion for CLI jurors (see above); a run can spend up to its timeout before the cost is known.
- **API keys are yours.** They are passed only to the juror that owns them and are redacted from every output — but they live in your environment, and Triangulate never stores them.
- **Test-pick and the final test check execute candidate code — as you, unsandboxed.** Resolving a conflict by tests means running each side's code (test files and anything the test command loads) in a disposable worktree. That code runs as your user, with your privileges. Two bounds apply, and one honest limit: the test command runs with a scrubbed environment — PATH and locale basics only, with HOME and TMPDIR pointed at scratch directories inside the disposable worktree root — and the command itself is pinned to the *base* repo's definition (`npm test` runs the test script from HEAD's `package.json`, never a candidate's rewrite of it). If the base repo has no test script, test-pick and the final check are skipped and the verdict says so. What the scrub does *not* do: it cannot hide your real home directory or your own environment from a determined process running as you. On any OS, a candidate can resolve your home from the passwd database (`os.userInfo()`, `/etc/passwd`, `getent`, `~user`) and read any file under it — `~/.ssh`, `~/.aws`, and other credentials included. On Linux it can also read the parent process's environment via `/proc`. The signing key is the one exception: `key.pem` is passphrase-encrypted at rest, so a stolen copy is ciphertext (see "Your signing key" above). Everything else under your home is reachable by candidate code. If that is not acceptable for a task or a repo, use `--no-test`: the merge still happens, conflicts that need test-pick stay unresolved, and no candidate code runs. The model CLIs themselves still run unsandboxed (see the FAQ below).
- **Model versions drift.** A verdict records the model string the tool reported at run time, or `"unknown"` when it did not report one.
- **Binary files are outside the text merge.** A juror that changes a binary file has the change listed in its candidate record (`binaryChanges`), but the merge does not carry binary content.
- **No telemetry in v1.** Triangulate phones home to nobody; the only network traffic is the jurors' own calls to their vendors (and Grok's API call).

## Provenance and ownership

- Every merged line traces to the juror that wrote it: the verdict's candidates carry each juror's diff, and dropped hunks name the juror and the rule that dropped them. Triangulate never claims to have authored the code — it records who did.
- Model outputs belong to whoever the model vendor's terms say they belong to. Triangulate makes no ownership claim over them.
- The verdict format is versioned (`triangulate/1`). If the format changes, the version changes, and old verdicts still verify with their own format.

## FAQs

**Do I need all four models?**
No. `--models` takes any subset. A single juror still produces a signed verdict (tier MAJORITY when it merges cleanly), but the point of the tool is the panel.

**Why is Grok an API adapter?**
There is no mature Grok coding CLI. The Grok juror calls the xAI chat-completions API, asks for a JSON map of changed files, validates it (relative paths only), applies it to its worktree, and is then diffed with git exactly like the CLI jurors. Every verdict labels it `adapter: "api"` so a reader never mistakes it for a native-CLI juror.

**What if the models disagree and the tests can't tell them apart?**
The conflict stays unresolved (tier DIVERGED), both sides are recorded in the verdict with conflict markers in the merged diff, and you decide. Nothing is silently resolved by a model — there is no LLM judge in v1, not even a labelled one.

**What if a juror tries to escape its worktree?**
The candidate is captured only from the juror's own worktree, so an escape write is never merged — but the worktree is a capture boundary, not a sandbox. The model CLIs run un-sandboxed with your full privileges, so a juror could read or write outside its worktree; it just can't get that into the merge. Symlinks in a worktree are never followed during capture: a symlinked file is recorded as skipped, not read. The worktrees are removed when the run ends, success or failure.

One asymmetry is deliberate and worth knowing: the test runs get a scratch HOME (see the honest limits above) because they execute *candidate code* by design, but the model CLIs run with your real HOME because they authenticate via config files under it (Claude `~/.claude.json`, Codex `~/.codex`, Gemini `~/.gemini`) — a scratch HOME would break their logins. That means a prompt-injected CLI could read your files — `~/.ssh`, `~/.aws`, and anything else under your home. The signing key file itself is passphrase-encrypted, so a stolen copy is ciphertext; the key is not the exposure here, your other credentials are. A separate key-holding process is out of scope for v1.

**How do I rotate the verdict log?**
The log at `~/.triangulate/log.jsonl` is append-only and Triangulate never deletes entries. To rotate it, move `log.jsonl` aside (e.g. `log-2026-11.jsonl`) — the next run starts a fresh chain, and `tri verify` still verifies old verdict files. The log is a local audit trail, not a database: if it grows large, archive it. Rotation is the operator's job in v1.

**Can I use this in CI?**
Yes: `tri run` exits 0 when a verdict is produced (including DIVERGED), 1 on usage errors or tier FAILED. `tri verify` exits 0 for a valid verdict, 2 for an invalid one. The verdict file is the artifact; the log is local.

**How do I apply the merged result?**
Review it first — `tri diff` shows the merged diff, `tri show` shows the conflicts and dissent. Then apply the merged files to your working tree yourself (v1 does not write into your repo; the worktrees are disposable and removed after the run).

## Repository

- **License:** Apache 2.0. Every source file carries the SPDX header.
- **Stack:** TypeScript / Node 24+, single-package CLI (`tri`), zero-dependency core (JCS + Ed25519 JWS vendored in-core), tree-sitter for AST diffing only. No Rust, no xtool, no REA in v1.
- **Layout:** `src/core/` (JCS, JWS, verdict format, keys, store), `src/adapters/` (one per model + fake), `src/differ.ts` (Myers diff + 3-way merge), `src/ast.ts` (tree-sitter node merge), `src/orchestrator.ts` (worktrees + capture), `src/arbitrator.ts` (tiers + test-pick + signing), `src/cli.ts`, `test/` (node:test, no test framework dependency).
- **Scripts:** `npm test` (full suite), `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke` (end-to-end CLI smoke with fake jurors + a real-adapter `--dry-run`).
- **Assessment and gate files** (`ASSESSMENT.md`, `REVIEW.md`, `JUDGE.md`) are local working notes and are never committed.
