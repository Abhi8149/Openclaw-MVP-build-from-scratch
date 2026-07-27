# AbhiClaw — Competitive Analysis & Improvement Roadmap

An honest audit of this codebase against Claude Code, OpenCode (sst), and OpenClaw, plus a
prioritized list of what to fix, change, and build to be competitive as an open-source project.

Every claim below is anchored to a specific file and line in this repo.

---

## Part 0 — What you actually have today

Read the whole tree so the rest of this doc has a shared baseline.

| Subsystem | Where | State |
|---|---|---|
| CLI entry | `index.ts`, `tui/runWakeup.ts` | commander → banner → mode picker (CLI / Web / Telegram-stub) |
| Modes | `modes/cli.ts` | agent, plan, ask, rewind |
| Agent loop | `modes/agents/orchestrator.ts` | `streamText` + self-healing retry loop |
| Staging | `modes/agents/tool-executor.ts` | overlay `Map` + `deleted` `Set`; nothing touches disk until `/apply` |
| Approval | `modes/agents/approval.ts`, `risk-classifier.ts` | safe/low/high tiers, dangerous-shell regexes, typed confirmation |
| Checkpoints | `utils/git.ts`, `modes/agents/rewind.ts` | auto-commit with `abhiclaw: ` prefix, hard-reset rewind |
| Retrieval | `utils/semantic-retrieval.ts` | SQLite index, tree-sitter (optional) + regex fallback, embeddings + TF-IDF fallback, symbol-level index |
| Context compaction | `ai/memory.ts` | model wrapper that summarizes history into a scratchpad |
| Repo map | `utils/repo-map.ts` | regex scan, `.ts`/`.js` only |
| Web GUI | `modes/agents/gui-server.ts` | 1079-line single file, `node:http` + SSE, dependency graph, file pinning |
| Parallel agents | `actor-engine/` | SQLite queue with atomic claim — **orphaned, see P0-7** |
| Model routing | `ai/sqlite-router.ts` | relational model registry — **orphaned, see P0-7** |

### Where you genuinely lead

These are real differentiators. Do not throw them away while refactoring — they are your pitch.

1. **Staged-by-default mutation model.** Claude Code and OpenCode write to disk and rely on
   checkpoints to undo. Your `ToolExecutor` overlay (`tool-executor.ts:87-88`) means the working
   tree is *never* dirtied until the user types `/apply`. That is a stronger safety story than
   anyone in the market, and it's already built.
2. **Risk-tiered approval with typed confirmation.** `risk-classifier.ts` splits shell commands on
   `&&`/`|`/`;` per-segment (`splitShellSegments`, line 82) so a dangerous command can't hide behind
   a harmless one. Claude Code's permission system doesn't do per-segment analysis. This is good work.
3. **Accumulate-then-apply batching.** Changes pile up across many turns and get reviewed as one
   coherent diff. Nobody else does this.
4. **Self-healing loop with real verification.** `orchestrator.ts:338-375` temp-writes staged files,
   runs `tsc --noEmit` + `bun test`, and feeds failures back. The *shape* is right (see P1-3 for the
   performance problem).
5. **Symbol-level retrieval.** `semantic-retrieval.ts` indexes individual functions/classes, not just
   files. Most agents only do file-level.

Lead with these four in your README. They are not "me too" features.

---

## Part 1 — How the competition is built

### Claude Code
Layered architecture where each layer changes what the model can *see* or *do*:
- **Memory**: `CLAUDE.md` files, hierarchical (user → project → directory)
- **Hooks**: deterministic scripts at ~25 lifecycle points (`PreToolUse`, `PostToolUse`, `Stop`, …)
- **Skills**: folder-based instruction packs (`SKILL.md` + scripts), loaded on demand
- **Subagents**: isolated context windows, own prompt + tool allowlist
- **MCP**: external tool connectors
- **Permission modes**: plan / accept-edits / bypass, plus checkpointing and sandboxing
- **Compaction**: automatic history summarization at a context threshold

### OpenCode (sst) — ~162k stars, the one to study most
- **Client-server split.** Agent logic runs as a local HTTP/SSE server; TUI (Go), desktop, VS Code
  extension, and web all connect as clients. This is the single most important architectural
  decision they made — it's why they have four frontends and you have two hard-coded ones.
- **75+ providers** including local Ollama
- **LSP integration** — real compiler diagnostics fed to the model, not regex guesses
- **Session persistence** in SQLite via Drizzle → resume any conversation
- **Plugin system** (`@opencode-ai/plugin`) with Zod schemas
- **Config**: `.opencode/opencode.jsonc`, project-level, mergeable
- **Dual agent**: build (full access) / plan (read-only), Tab to switch

### OpenClaw
- Self-hosted **gateway** connecting chat apps (Discord, Slack, Telegram, WhatsApp, Signal, iMessage…)
  to coding agent backends
- Runs Claude Code / Codex / OpenCode as **managed background sessions** with worktree isolation,
  plan approval, merge/PR follow-through
- 100+ preconfigured skill bundles, native iOS/Android apps with remote approvals

**Read of the market:** OpenCode owns *architecture*, Claude Code owns *extensibility*, OpenClaw owns
*reach*. Your opening is **safety + cost transparency**, which nobody owns.

---

## Part 2 — P0: Bugs that will lose you contributors on day one

These are correctness and credibility issues. Fix before you publish the repo.

### P0-1 — `OPENROUTER_MODEL` is documented but never selects a model

`ai/ai.config.ts:50` hard-codes `let modelId = "openrouter/auto"`. The branch at line 53 is therefore
*always* taken, and line 71's `return provider(modelId)` is unreachable dead code.

Meanwhile `orchestrator.ts:316` reads `process.env.OPENROUTER_MODEL` to pick a **pricing row**. So a
user who sets `OPENROUTER_MODEL=deepseek/deepseek-v4-flash` (exactly as your `.env.example:11-12`
instructs) gets auto-routed to some other model but is billed against DeepSeek's rate card. Every
cost number you display to them is wrong.

**Fix:** read the env var in `getAgentModel`, fall back to auto-routing only when it's unset, and
return the resolved model id alongside the model so cost tracking uses the *actual* model.

### P0-2 — `maxSteps: 40` does nothing

`orchestrator.ts:237` passes `maxSteps: 40` to `streamText`. You're on `ai@^6` (`package.json:22`),
where that option was replaced by `stopWhen`. The `(streamText as any)` cast at line 232 silences the
type error that would have caught this. Your own plan mode gets it right
(`modes/plan/orchestrator.ts:133` uses `stopWhen: stepCountIs(30)`).

Result: agent mode has **no step ceiling**. A confused model can loop until it hits your budget cap.

**Fix:** `stopWhen: stepCountIs(40)`, and delete the `as any` cast so the compiler protects you.

### P0-3 — "Approve and apply all" bypasses typed confirmation

`approval.ts:203-207`: choosing "Approve and apply all" marks every pending action approved,
including groups where `requiresTypedConfirmation === true`. The entire `rm -rf` / `git push --force`
guard rail in `risk-classifier.ts:34-54` is one menu selection away from being skipped.

**Fix:** if any group requires typed confirmation, either exclude it from bulk-approve and force
individual review, or demand the typed `yes` once before the bulk apply proceeds.

### P0-4 — tree-sitter is `require`d but is not a dependency

`semantic-retrieval.ts:55` calls `require("tree-sitter")`, and lines 56-63 require eight grammar
packages. **None of them appear in `package.json`.** The `try/catch` at line 64 swallows the failure,
so every user silently falls through to `extractSkeletonRegex`. The AST path — the more accurate
half of your retrieval system — has never run for anyone.

**Fix:** move them to `optionalDependencies` (so install doesn't hard-fail where native builds don't
work) and log once at startup which path is active. Users deserve to know they're on the regex
fallback.

### P0-5 — Debug logging in hot paths

- `semantic-retrieval.ts:650` — `console.log("TF-IDF is starting working !")` sits inside
  `computeLocalSimilarity`, which runs once per file **and** once per symbol on every search. On a
  moderate repo that's thousands of lines of spam per prompt, and the I/O is itself a measurable
  slowdown.
- `tool-executor.ts:448-449, 471, 476, 486, 489, 492` — `🔍 [Debug]` lines print on every apply.
- `orchestrator.ts:394, 413, 427, 429` — same.
- `index.ts:20` and `ai/index.ts:4` both print `"App initiated"`, the second as an *import side
  effect*.

**Fix:** a `DEBUG=abhiclaw:*` gated logger. Ship silent by default.

### P0-6 — A 7 MB binary index is committed to git

`git ls-files` shows `agent-index.db` (7,053,312 bytes) and `agent-tasks.sqlite-shm` tracked.
`.gitignore` covers `*.sqlite` but not `*.db`, `-shm`, or `-wal`. Every contributor clones 7 MB of
your local embeddings, and every run produces a dirty diff.

**Fix:** add `*.db`, `*.db-shm`, `*.db-wal`, `*.sqlite-shm`, `*.sqlite-wal` to `.gitignore`,
`git rm --cached` both files, and relocate the index out of the workspace root (see P1-6).

### P0-7 — Two whole subsystems are orphaned

`actor-engine/` (queue, workers, atomic `UPDATE … RETURNING` claim) and `ai/sqlite-router.ts`
(capability-scored model registry) are imported **only** by `testing-scripts/`. Nothing in `modes/`
touches them. The atomic claim logic in `queue.ts:57-105` is genuinely good and is exactly what a
subagent scheduler needs.

**Decide and act:** either wire `actor-engine` into a real subagent feature (P2-1) or move both to a
`experimental/` directory with a README. Right now a new contributor reads `actor-engine/` and
assumes parallel agents work.

### P0-8 — Windows spawn reliability

`utils/checker.ts:13` calls `spawnSync("bunx", […])` and line 20 `spawnSync("bun", […])`, neither
with `shell: true`. On Windows these resolve to `.cmd` shims and will throw `ENOENT` under Node
semantics. Given you develop on Windows this may work under Bun's runtime today, but it will break
for Node users and in CI.

Also `tui/runWakeup.ts:29-30`: `exec("start " + url)` on win32 needs `start "" "<url>"` — a URL with
`&` in it breaks the current form.

---

## Part 3 — P1: Architecture changes that decide whether this scales

### P1-1 — Split the core from the frontends (highest-leverage change in this document)

Today `runAgentMode` (`orchestrator.ts:472`) *is* the application: it owns the chat loop, slash
command parsing, terminal `console.log` output, GUI state pushes, approval orchestration, and cost
accounting, all in one 350-line function. Adding a third frontend means a third set of `if
(guiServer)` branches — there are already ~12 of them.

This is precisely the problem OpenCode solved with its client-server split, and it's why they support
TUI + desktop + VS Code + web off one core.

**Target shape:**

```
core/          session, agent loop, tools, staging, approval decisions
               emits typed events: text-delta, tool-call, staged-change,
               approval-required, cost-update
server/        HTTP + SSE, exposes core over a stable local API
clients/       cli/  web/  (later: vscode/, tui/)
```

Rules: core never calls `console.log` and never imports chalk; every frontend is a pure consumer of
the event stream. Approval becomes a *request/response over the event bus*, not a function that
happens to know whether a `GuiServer` exists.

This single refactor unlocks: VS Code extension, remote/server mode, headless CI mode, a scriptable
SDK, and OpenClaw-style chat-app gateways — none of which are reachable from the current shape.

### P1-2 — Rewrite context management; it is your biggest cost and latency sink

`ai/memory.ts` has four compounding problems:

1. **Summarizes on every single turn** once history exceeds 8 messages (line 22, line 112). That's a
   full extra LLM round-trip *per turn*, serialized before the real request. Directly visible as lag.
2. **Hard-truncates to the last 4 messages** (line 91, line 176). Anything older survives only as a
   ≤150-word scratchpad. On a 15-turn task the model has effectively forgotten turns 1-11.
3. **Kills prompt caching.** The system prompt is rebuilt every turn from a fresh scratchpad + freshly
   read file contents (line 78-88). No two requests share a prefix, so no provider-side cache ever
   hits. Industry reporting puts agentic token overhead at 10-100× a chat window, and the fix is
   almost entirely prefix stability.
4. **`doGenerate` and `doStream` are near-identical 80-line copies.** Any fix has to be made twice.

**Target:**
- Compact at a **threshold** (~70-80% of context window), not every turn.
- Keep a stable prefix: `[system rules] → [repo map] → [pinned files]` — all cacheable — then
  volatile turn content.
- Use provider prompt caching (`cache_control` breakpoints) on that prefix.
- Preserve *structured* state across compaction (files touched, decisions, open questions), not one
  free-text blob.
- Extract the shared logic into one function; make `doGenerate`/`doStream` thin wrappers.

Expect a large cost reduction and a very noticeable latency drop from this alone.

### P1-3 — Make verification incremental

`runProjectChecks` (`utils/checker.ts`) runs a **full** `tsc --noEmit` and the **entire** `bun test`
suite. `orchestrator.ts:341-350` invokes it after every self-healing attempt, up to
`maxSelfHealingAttempts: 3` (`types.ts:74`). On a mid-size TypeScript repo that's 20-60 s per attempt
— potentially three minutes of the user staring at a blank terminal.

**Target:**
- Persistent `tsc --watch --incremental` process, or an LSP client (P2-2), for sub-second diagnostics.
- Scope tests to files related to the diff instead of the whole suite.
- Make the check command configurable (`checks.typecheck`, `checks.test`, `checks.lint`) so
  non-Bun/non-TS projects work at all. Right now a Python user gets `bun test` run against their repo.
- Stream check progress to the UI. Silence reads as a hang.

### P1-4 — Fix the retrieval cold start

`semanticSearch` (`semantic-retrieval.ts:856-920`) loops files **sequentially**, `await`ing one
embedding API call per file (line 877) and one per symbol (line 900), each with an 8 s timeout
(line 693). A 500-file repo with ~2000 symbols is ~2500 serialized HTTPS round-trips. First run on a
real project is effectively unusable, with no progress indicator.

**Target:**
- Batch embeddings (the endpoint accepts arrays) — 100 inputs per call.
- Bound concurrency (~5-10 in flight).
- Show a progress bar; index in the background and let the first prompt use TF-IDF meanwhile.
- Persist a schema version so the index survives upgrades instead of silently going stale.
- Consider `sqlite-vec` for real ANN search rather than loading every vector into JS and scanning.

### P1-5 — Rethink what goes into the prompt every turn

Per turn, `executeSingleTask` assembles: full contents of up to 3 semantic files
(`orchestrator.ts:142-150`), matched symbol bodies (line 152), a 2-deep import-skeleton traversal
(line 154, `traverseImports`), **and** a repo map of the entire project (line 160,
`generateRepoMap`). All of it regenerated per turn, all of it unconditional.

Two consequences: the prompt is large before the user's question is even added, and because it
changes every turn, none of it caches.

**Target:** compute the repo map **once** per session and cache it. Let the model *pull* file contents
via tools rather than pushing 3 full files it may not need. Add a token budget per context category
and report the split in `/tokens` — "repo map 4.2k, files 11k, history 3k" is genuinely useful and
nobody else shows it.

### P1-6 — Introduce a real config system

Everything is hard-coded in `defaultAgentConfig()` (`types.ts:52-75`) or read ad-hoc from
`process.env`. There is no way to change the model, budget, exclude patterns, or check commands
without editing source.

Worse: `.agents/rules/always-document.md` exists in this repo and **no code reads it**. You built the
convention and never wired it up.

**Target:**
- `abhiclaw.jsonc` — project-level, with `~/.abhiclaw/config.jsonc` as user-level, merged.
- JSON Schema published so editors autocomplete it.
- `ABHICLAW_*` env overrides for CI.
- Read `AGENTS.md` / `CLAUDE.md` / `.agents/rules/*.md` as project instructions and inject them into
  the stable prompt prefix. This also buys you instant compatibility with repos already set up for
  Claude Code and OpenCode — a genuinely cheap adoption win.
- Move `agent-index.db` to `.abhiclaw/index.db` and gitignore the directory.

---

## Part 4 — P2: Feature parity gaps

### P2-1 — Subagents / parallel execution
Claude Code and OpenCode both isolate verbose subtasks in their own context window. You have the
scheduler already (`actor-engine/queue.ts` atomic claim) — it just isn't connected. A `dispatch_agent`
tool that spawns a bounded child with its own context and a restricted tool allowlist, returning only
a summary, would keep the main thread clean. This is P0-7's resolution.

### P2-2 — LSP integration
OpenCode's headline differentiator. Real diagnostics, go-to-definition, find-references, and
rename-symbol beat every regex in `repo-map.ts` and `semantic-retrieval.ts`. Start with one language
server, feed diagnostics into the self-healing loop, and it also fixes P1-3's speed problem.

### P2-3 — MCP support
Claude Code, OpenCode, and OpenClaw all support it; the ecosystem is large and growing. Without it
you are asking users to give up every MCP server they already run. Client-side support (stdio + SSE
transports) is a contained piece of work with a large payoff.

### P2-4 — Session persistence and resume
Sessions live in memory and die with the process (`orchestrator.ts:489-492`). `/clear` wipes history
irrecoverably. OpenCode persists to SQLite; Claude Code has `--continue` / `--resume`. You already
run SQLite in two places — persist messages, tool calls, staged mutations, and cost, then add
`abhiclaw --resume`.

### P2-5 — Hooks
Claude Code fires user scripts at ~25 lifecycle points. Your `ActionTracker` already sees every event
— exposing `PreToolUse` / `PostToolUse` / `PreApply` / `PostApply` / `Stop` hooks is mostly plumbing,
and it's what lets teams enforce their own policies (auto-format, secret redaction, blocked paths)
without patching your source.

### P2-6 — Skills
You have `list_skills` / `read_skill` (`agent-tools.ts:91-105`) reading from `~/.cursor/skills-cursor`
and `~/.claude/skills` — but the model must *choose* to call them and nothing describes what's
available. Claude Code injects skill *names + descriptions* into the prompt so the model knows what
exists, then loads the body on demand. That's a small change to a feature you've already half-built.

### P2-7 — Better file tools
Current tools waste a lot of tokens:
- `modify_file` (`agent-tools.ts:24-31`) demands **complete new file contents**. For a 3-line change
  in a 500-line file the model emits 500 lines. `edit_file` exists and is better — deprecate
  `modify_file` or restrict it to small files.
- `read_file` has no offset/limit. One 5000-line file can blow the context window.
- Reads return no line numbers, so the model can't cite locations precisely.
- `search_files` (`tool-executor.ts:280`) is a hand-rolled JS walk with substring-only content
  matching. Shell out to ripgrep when present — orders of magnitude faster, with real regex.
- No `list_directory` with depth control, no glob tool.

### P2-8 — Shell that can actually be used
`execute_shell` only *queues* a command for post-approval execution (`tool-executor.ts:374`), and
output is `stdio: "inherit"` (line 514) so the model never sees it. That means no background dev
server, no log tailing, and no read-eval loop where the agent runs a command and reacts to output.
Add: capture stdout/stderr back to the model, background processes with an ID, and a timeout.

### P2-9 — Provider abstraction
`getAgentModel` (`ai/ai.config.ts:48`) only ever constructs OpenRouter, with two model ids hard-coded
in `allowed_models` (lines 60-63). OpenCode supports 75+ providers including local Ollama; OpenClaw is
explicitly model-agnostic. **Ollama support especially matters for open source** — many people trying
your project will not want to pay for tokens to evaluate it. The AI SDK already abstracts this; you
mostly need config plumbing (P1-6) and a provider registry.

---

## Part 5 — P3: Where you can actually win

Parity gets you considered; these get you chosen.

1. **Cost transparency as a first-class feature.** You already track per-turn tokens and cost
   (`orchestrator.ts:310-324`). Nobody else surfaces this well, and cost anxiety is one of the
   loudest complaints in the market. Ship: per-turn cost in the UI, a context-composition breakdown,
   a session budget with warnings, and a `--dry-run` that estimates before spending.
2. **"Explain the diff before I apply it."** You have the full staged diff at approval time. Have the
   model narrate *why* each hunk exists, in plain language, at review time. Uniquely enabled by your
   staging model.
3. **Safety as the brand.** Staged-by-default + risk tiers + typed confirmation + rewind is a
   coherent story: *the agent that cannot wreck your repo*. Lean into it — add a sandbox mode, a
   path allowlist, and a secret-redaction hook.
4. **Sub-second local mode.** With TF-IDF retrieval and a local Ollama model, the whole loop can run
   offline and free. That is a compelling "try it in 60 seconds with zero API keys" onboarding.
5. **Multi-root / monorepo awareness.** `codebasePath` is a single `process.cwd()` (`types.ts:53`).
   Monorepo support is a real, common, under-served pain point.

---

## Part 6 — Open-source setup & DX checklist

The research is unambiguous here: the winning pattern is *one command, zero config, works
immediately*. `npx forgecode@latest`, Codex's standalone installer, single-binary distributions with
no runtime deps. Meanwhile:

**Current state of your install story**
- `README.md` is the unmodified `bun init` boilerplate — 15 lines, ends with "This project was
  created using `bun init`".
- `package.json` is `"private": true` → cannot be published to npm at all.
- `bin` is `"Abhiclaw-build": "./index.ts"` — a `.ts` file with a Bun shebang. No build step, no
  Node compatibility, and the name doesn't match the CLI name (`Abhiclaw`, `index.ts:8`).
- `@types/bun`, `@types/node`, `@types/marked-terminal` are in `dependencies`, not `devDependencies`.
- `LICENSE` exists but is untracked and unreferenced in `package.json`.
- No CI, no `CONTRIBUTING.md`, no issue templates, no `bun run` scripts of any kind.
- First run silently indexes the entire repo with sequential network calls (P1-4) and prints
  `TF-IDF is starting working !` thousands of times (P0-5).

**Target**

*Install*
- [ ] `npx abhiclaw` works with no prior install
- [ ] `bunx abhiclaw` works
- [ ] Standalone binaries via `bun build --compile` for macOS/Linux/Windows on every release
- [ ] Remove `private: true`; add `license`, `repository`, `homepage`, `keywords`
- [ ] Move `@types/*` to `devDependencies`; move tree-sitter to `optionalDependencies`
- [ ] Add scripts: `dev`, `build`, `test`, `typecheck`, `lint`

*First run*
- [ ] `abhiclaw init` — interactive: pick provider, paste/OAuth a key, write `abhiclaw.jsonc`
- [ ] Detect a missing `OPENROUTER_API_KEY` and say so clearly instead of failing deep in a fetch
- [ ] Offer a zero-key path (Ollama, or TF-IDF + a free model) so people can evaluate for free
- [ ] Show indexing progress; make it interruptible and resumable
- [ ] Target: **under 60 seconds** from `npx` to first useful answer

*Server / self-host*
- [ ] `abhiclaw serve --port 8000 --host 0.0.0.0` (needs P1-1)
- [ ] Auth on the web UI — `gui-server.ts` currently binds with no authentication whatsoever. Do not
      let anyone expose that to a network as-is.
- [ ] Dockerfile + `docker-compose.yml`
- [ ] Health endpoint, structured logs, graceful shutdown
- [ ] Document the memory/CPU footprint of indexing

*Docs*
- [ ] Rewrite `README.md`: what it is, a 30-second demo GIF, install, quickstart, the four
      differentiators from Part 0, comparison table, links
- [ ] `CONTRIBUTING.md` + architecture overview (your `documentation/` folder is a great start —
      `GUIDE_ADDING_FEATURES.md` and the per-feature docs are better than most projects have)
- [ ] Troubleshooting page: Windows notes, native-build failures, missing keys, proxies
- [ ] Config reference generated from the JSON Schema

*Quality*
- [ ] CI on Linux + macOS + Windows: typecheck, test, build
- [ ] Your `testing-scripts/` are runnable scripts, not assertions — convert to real `bun test` cases
- [ ] Consistent naming: repo is `openclaw` (a different, existing project), CLI is `Abhiclaw`,
      commits say `abhiclaw:`, package is `openclaw`. **Pick one name.** Colliding with OpenClaw —
      which is a well-known project in exactly this space — will cost you discoverability and
      goodwill.

---

## Part 7 — Suggested sequencing

**Milestone 1 — Credibility (do before making the repo public)**
P0-1 through P0-8. Rewrite the README. Fix packaging. Add CI. Rename.
*Outcome: a stranger can install it and it does what the docs say.*

**Milestone 2 — Speed (the "feels fast" release)**
P1-2 (context/caching), P1-3 (incremental checks), P1-4 (batched indexing), P1-5 (prompt budget),
P1-6 (config + `AGENTS.md`).
*Outcome: 3-5× less latency and cost per turn — the difference between a demo and a daily driver.*

**Milestone 3 — Architecture**
P1-1 (core/server/client split), P2-4 (session persistence), P2-9 (providers + Ollama).
*Outcome: multiple frontends, resumable sessions, no vendor lock-in.*

**Milestone 4 — Ecosystem**
P2-3 (MCP), P2-5 (hooks), P2-6 (skills), P2-1 (subagents), P2-2 (LSP).
*Outcome: parity with Claude Code and OpenCode on extensibility.*

**Milestone 5 — Differentiation**
All of Part 5. Market on safety and cost transparency.

**If you only do three things:** fix P0-1/P0-2/P0-3 (they're correctness bugs users will hit),
rewrite `ai/memory.ts` per P1-2 (biggest speed and cost win available), and do P1-1 (everything else
gets easier afterward).

---

## Sources

- [sst/opencode — DeepWiki architecture](https://deepwiki.com/sst/opencode)
- [OpenCode Agent System](https://deepwiki.com/sst/opencode/3.2-agent-system)
- [OpenCode Developer Guide 2026](https://www.developersdigest.tech/blog/opencode-developer-guide-2026)
- [OpenCode Review: Architecture Deep Dive](https://codexpedite.com/opencode-review-the-open-source-ai-agent-that-challenges-claude-code-and-cursor/)
- [OpenClaw GitHub](https://github.com/openclaw/openclaw)
- [OpenClaw Docs](https://docs.openclaw.ai/)
- [What is OpenClaw — DigitalOcean](https://www.digitalocean.com/resources/articles/what-is-openclaw)
- [OpenClaw vs Claude Code](https://www.eigent.ai/blog/openclaw-vs-claude-code)
- [Inside Claude Code: Architecture Behind Tools, Memory, Hooks, MCP](https://www.penligent.ai/hackinglabs/inside-claude-code-the-architecture-behind-tools-memory-hooks-and-mcp/)
- [Claude Code Hooks, Subagents & Skills Guide 2026](https://ofox.ai/blog/claude-code-hooks-subagents-skills-complete-guide-2026/)
- [Claude Code Features Reference 2026](https://hidekazu-konishi.com/entry/claude_code_features_settings_reference_2026.html)
- [70% of Your AI Coding Agent's Tokens Are Wasted](https://medium.com/@mainak.c/70-of-your-ai-coding-agents-tokens-are-wasted-here-s-how-to-fix-it-b6761b5013cd)
- [Context Is a Budget — Reducing Token Usage](https://foojay.io/today/context-is-a-budget-eight-levers-and-three-workflow-patterns/)
- [Why AI Coding Costs Are Spiraling — Futurum](https://futurumgroup.com/insights/why-ai-coding-costs-are-spiraling-context-not-usage-is-the-real-culprit/)
- [Context Rot in AI Coding Agents](https://www.mindstudio.ai/blog/context-rot-ai-coding-agents-how-to-prevent)
- [awesome-cli-coding-agents](https://github.com/bradAGI/awesome-cli-coding-agents)
- [Best Open Source CLI Coding Agents 2026](https://pinggy.io/blog/best_open_source_cli_coding_agents/)
