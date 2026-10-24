# OpenClaw — the "AbhiClaw" Desktop Coding Agent

> A terminal-native, browser-visible AI coding agent that **stages every mutation before it touches your repo**, reviews risk before it runs, self-heals before it commits, and keeps LLM token costs flat with GraphRAG retrieval + rolling memory.

OpenClaw is a from-scratch, TypeScript/Bun implementation of a desktop AI coding agent. It combines the things users actually want from Claude Code / Codex / OpenCode — continuous multi-task chat, semantic code retrieval, web research, browser control, and skills — with a **safety-first staged-approval model** and a **live Web Companion dashboard** that makes an agent's work visible and reviewable by non-terminal users.

---

## Table of Contents

- [Why this agent is different](#why-this-agent-is-different)
- [Quick Start](#quick-start)
- [Features](#features)
- [Modes](#modes)
- [Slash Commands](#slash-commands)
- [Agent Tools](#agent-tools)
- [How It Works (Architecture)](#how-it-works-architecture)
- [Safety & Approval Model](#safety--approval-model)
- [Cost Control](#cost-control)
- [Configuration & Environment Variables](#configuration--environment-variables)
- [Web Companion GUI](#web-companion-gui)
- [Project Structure](#project-structure)
- [Testing](#testing)
- [Documentation](#documentation)
- [Competitive Landscape & Roadmap](#competitive-landscape--roadmap)
- [License](#license)

---

## Why this agent is different

| Problem in other agents | How OpenClaw answers it |
|---|---|
| **Approval fatigue** — every change needs the same yes/no | **Risk-tiered approvals**: low-risk changes auto-approve, high-risk changes (`rm -rf`, `.env`, force-push, big diffs) get a red badge + reason + **typed "yes" confirmation** |
| **Context window blowup / token waste** on big repos | **GraphRAG intent retrieval** loads only the top 3 semantically related files + a **Skeletal Map** of every symbol's line numbers + imported-file skeletons — not the whole tree |
| **Unbounded history** that keeps re-sending old tool calls | **Rolling state memory** summarizes old turns into a compact "scratchpad" so context stays flat |
| **Surprise API bills** from infinite correction loops | **Hard `--budget` cap** + per-session token/cost dashboard, abort before damage |
| **Agents write broken code directly to disk** | Every mutation is staged in an **in-memory overlay**; the project is compiled (`tsc --noEmit`) and tested (`bun test`) in a **temporary shadow write** before you ever `/apply` — with up to 3 **self-healing** retries |
| **Agents are invisible to non-CLI users** | `--gui` hosts a **local Web Companion**: live SSE streaming, color-coded diffs, one-click Approve/Reject, a **vis.js dependency graph** of your repo, and click-to-pin files into context |
| **Dangerous shell commands hidden in chains** | Shell commands are split on `&& \|\| ; \|` and each segment is classified — `git status && rm -rf dist` is still caught |
| **Forgetting what it changed** | `git` checkpoints every applied change, and `/rewind` lets you time-travel the repo to any earlier checkpoint |

---

## Quick Start

Requires [Bun](https://bun.sh) 1.x and an [OpenRouter](https://openrouter.ai) API key.

```bash
# 1. Install dependencies
bun install

# 2. Configure your API key (required)
#    Windows (PowerShell):
#      $env:OPENROUTER_API_KEY = "sk-or-..."
#    macOS/Linux:
#      export OPENROUTER_API_KEY="sk-or-..."
#    (or add OPENROUTER_API_KEY=... to a .env file)

# 3. Launch
bun run index.ts wakeup
```

The launcher presents a menu: **CLI**, **Web UI**, or **Telegram** (experimental).

### Launch flags

```bash
bun run index.ts wakeup --gui          # Start agent mode with the Web Companion dashboard
bun run index.ts wakeup --budget 0.25  # Hard dollar cap on LLM spend for the session
```

`--budget` defaults to **$1.00** if not supplied. When the cumulative API cost exceeds the cap, the agent loop halts, staged changes are cleared (nothing is written to disk), and the GUI shows the failure.

---

## Features

- **Continuous Agent Mode** — one chat session, many tasks; changes accumulate until you type `/apply`.
- **Risk-tiered staged approvals** — `safe` / `low` / `high` tiers with reasons, plus typed confirmation for unambiguously destructive commands.
- **Self-healing loop** — staged changes are temporarily written, then validated with `tsc --noEmit` + `bun test`; failures are fed back to the model to fix (default 3 attempts).
- **GraphRAG intent retrieval** — vectorized goal → top-3 semantic files (OpenRouter embeddings), with a **local TF-IDF fallback** when the API key is missing/offline.
- **Rolling state memory** — background LLM summarization rolls old turns into a bulleted scratchpad; the model only ever sees map + related files + scratchpad + last 2 turns.
- **Fuzzy edit matching** — `edit_file` search blocks match exactly, then indentation-tolerantly, then whitespace-tolerantly, and report ambiguity instead of guessing.
- **Web Companion GUI** — SSE live streaming, token/cost meters, staged diff review, Approve/Reject, codebase dependency graph, file pinning.
- **Browser automation** — Playwright-driven navigation, snapshot, click, fill, keypress, screenshots using your system Chrome/Edge with a persistent profile.
- **Web research** — Brave Search and/or Firecrawl-powered `search_web` + `scrape_page`.
- **Skills support** — reads `SKILL.md` files from Cursor/Claude skill roots (and `SKILLS_DIRS`).
- **Git checkpoints & rewind** — applied changes are committed automatically; `/rewind` restores any checkpoint.
- **Cost & token transparency** — `/tokens`, GUI budget meter, per-message cost labels.
- **File pinning** — `/add <path>` pins files into context for all future prompts; double-click a graph node in the GUI to pin too.
- **Exclusion policy** — `.env*`, `*.log`, and configured paths are unreadable/unwritable by the agent.

---

## Modes

### 🤖 Agent Mode (default)
Continuous chat with code changes. Tasks run, mutations stage in memory, and a non-blocking summary shows the accumulated count. Type `/apply` to review & commit everything at once.

### 🗺️ Plan Mode
Goal → generated step plan → selected steps executed with read-only tools plus web research.

### ❓ Ask Mode
Strictly read-only Q&A over your codebase (plus web search/scrape). Answers can optionally be saved to a `.md` file.

### ⏪ Rewind
Time-travel the repo: pick a git checkpoint and restore the workspace to that state.

### 🖥️ Web UI
Same agent loop, browser-hosted dashboard (see [Web Companion GUI](#web-companion-gui)).

---

## Slash Commands

Available inside Agent Mode:

| Command | Action |
|---|---|
| `/apply` | Review + approve + apply all staged changes (auto-commits in git repos) |
| `/add <path>` | Pin a file into the LLM context for all future prompts |
| `/drop <path>` | Un-pin a file |
| `/diff` | Show all staged changes as a color-coded unified diff |
| `/undo` | Roll back the staged changes from the most recent task |
| `/rewind` | Open the git checkpoint rewind menu |
| `/tokens` | Show session token usage and estimated cost |
| `/clear` | Clear terminal, GUI chat, and scratchpad memory |
| `/help` | List commands |
| `/exit` | Leave Agent Mode (warns about unapplied staged changes) |

---

## Agent Tools

The agent has a flat tool pool (Vercel AI SDK + Zod schemas):

| Category | Tools |
|---|---|
| **Read / Explore** | `read_file`, `list_files`, `search_files`, `analyze_codebase`, `get_repo_map` |
| **Mutate (staged)** | `create_file`, `modify_file`, `delete_file`, `create_folder`, `edit_file` (fuzzy search/replace) |
| **Shell** | `execute_shell` (queued, risk-classified, approval-gated) |
| **Web** | `search_web` (Brave/Firecrawl), `scrape_page` (Firecrawl) |
| **Browser** | `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_press_key`, `browser_screenshot` |
| **Skills** | `list_skills`, `read_skill` |

All mutating tools write to an **in-memory overlay** and log a `pending` action to the tracker with a risk tier — nothing touches disk until approval.

---

## How It Works (Architecture)

```
You type a goal
      │
      ▼
┌─────────────────────────────┐
│ 1. GraphRAG semantic search  │  top-3 related files (embeddings or TF-IDF)
└─────────────────────────────┘
      │
      ▼
┌─────────────────────────────┐
│ 2. Context assembly          │  Skeletal Map + related files + pinned files
│                             │  + staged files + imported skeletons
└─────────────────────────────┘
      │
      ▼
┌─────────────────────────────┐
│ 3. Rolling memory wrapper    │  old turns → bulleted scratchpad (flat context)
└─────────────────────────────┘
      │
      ▼
┌─────────────────────────────┐
│ 4. streamText tool loop      │  real-time text → terminal + GUI (SSE)
│    (max 40 steps)            │  tool calls → staged overlay + tracker
└─────────────────────────────┘
      │
      ▼
┌─────────────────────────────┐
│ 5. Self-healing check        │  temp-write staged → tsc --noEmit + bun test
│    (up to 3 attempts)        │  failure → feedback → retry
└─────────────────────────────┘
      │
      ▼
┌─────────────────────────────┐
│ 6. /apply approval flow      │  risk-tiered groups → approve/reject (CLI or GUI)
└─────────────────────────────┘
      │
      ▼
   write to disk + git auto-commit
```

Key components:

- **`modes/agents/tool-executor.ts`** — the staging engine. An overlay `Map<path, content>` plus a `deleted` set let every read tool see uncommitted staged files seamlessly. `applyApprovedFromTracker()` writes approved actions to disk in dependency-safe order.
- **`modes/agents/action-tracker.ts`** — append-only action log with per-action risk metadata.
- **`modes/agents/risk-classifier.ts`** — deterministic risk classification for file mutations and shell commands (see [Safety & Approval Model](#safety--approval-model)).
- **`modes/agents/approval.ts`** — groups pending actions by path, renders badges/reasons, offers smart approval flows, and enforces typed "yes" for destructive commands.
- **`utils/semantic-retrieval.ts`** — SQLite-backed code index (`agent-index.db`): skeletons, embeddings, tokens; used by `semanticSearch()`.
- **`utils/repo-map.ts`** — brace-matching parser producing the line-numbered Skeletal Map.
- **`utils/graph-scanner.ts`** — import-graph scanner powering the GUI's dependency graph.
- **`ai/memory.ts`** — `wrapModelWithRollingMemory()` proxy that summarizes conversation turns into a scratchpad.
- **`modes/agents/gui-server.ts`** — zero-dependency HTTP + SSE server serving the embedded dashboard.
- **`services/browser-service.ts`** — Playwright singleton (persistent profile, system Chrome/Edge channel, anti-automation flags).
- **`utils/git.ts`** — checkpoint commits + rewind restore.
- **`utils/checker.ts`** — `runProjectChecks()` (tsc + bun test) used by the self-healing loop.

Experimental sub-systems (not wired into the main loop yet):

- **`actor-engine/`** — SQLite-backed task queue with atomic `UPDATE ... RETURNING` claims and verifier/tester role states, designed for parallel multi-agent pipelines (`testing-scripts/test-parallel-agents.ts`, `test-sqlite-queue.ts`).
- **`ai/sqlite-router.ts`** — model-registry routing that picks the cheapest capable model for a task category from SQLite.

---

## Safety & Approval Model

Every staged action is classified the moment it is created:

- **`safe`** — read-only actions (`read_file`, `list_files`, ...); run immediately.
- **`low`** — reversible, small blast radius (new file, empty folder, small edit).
- **`high`** — file deletion, sensitive paths (`package.json`, `.env*`, lockfiles, `tsconfig*.json`, CI workflows, Dockerfiles), edits over 40 changed lines, and shell commands not on the safe allowlist.

Shell commands get extra scrutiny: they are split into segments on `&&`, `||`, `;`, and `|`, and any segment matching a destructive pattern (`rm -rf`, `git push --force`, `git reset --hard`, `sudo`, `curl | sh`, DB drops, disk format, ...) requires **typing the word "yes"** before approval is honored.

The approval menu offers:

1. **Approve and apply all**
2. **Auto-approve low-risk, review high-risk individually** *(recommended)*
3. **Review one by one**
4. **Cancel**

After approval, applied changes are **auto-committed** to git when inside a repository, so `/rewind` can always take you back.

---

## Cost Control

- `--budget <dollars>` caps cumulative LLM spend per session (default `$1.00`).
- Every streamed response records input/output tokens and per-message cost in the GUI.
- `/tokens` prints session totals and estimated spend.
- Rolling memory + Skeletal Map + GraphRAG retrieval keep context small, which is the biggest lever on cost.

Pricing rows live in `ai/index.ts` (`MODEL_PRICING`), keyed by the model name in `OPENROUTER_MODEL`.

---

## Configuration & Environment Variables

| Variable | Purpose | Required |
|---|---|---|
| `OPENROUTER_API_KEY` | LLM + embedding API access via OpenRouter | ✅ |
| `OPENROUTER_MODEL` | Picks the pricing row used for cost display (routing itself is dynamic: goal-based cost/quality tradeoff on OpenRouter's auto-router) | optional |
| `BRAVE_SEARCH_API_KEY` | Enables `search_web` via Brave Search | optional |
| `FIRECRAWL_API_KEY` | Enables `scrape_page` and Firecrawl-powered search fallback | optional |
| `SKILLS_DIRS` | Extra directories (semicolon-separated) scanned for `SKILL.md` files | optional |

Excluded paths (`.env*`, `*.log`, `node_modules`, etc.) are enforced inside `ToolExecutor.excluded()` — the agent cannot read or write them.

---

## Web Companion GUI

```bash
bun run index.ts wakeup --gui
```

Open `http://127.0.0.1:8000` in any browser:

- **Live streaming** — agent text and tool calls stream in real time over Server-Sent Events.
- **Staged diffs** — color-coded unified diffs with risk badges and reasons; **Approve & Apply** / **Reject** buttons.
- **Codebase graph** — interactive vis.js dependency graph; GraphRAG-matched files are green, pinned files indigo; double-click any node to pin/unpin it into agent context.
- **Cost meters** — live token counts and budget usage in the header.

---

## Project Structure

```
actor-engine/            Experimental SQLite task queue (atomic claims, verifier/tester)
ai/                      Model selection, rolling memory, SQLite model router
documentation/           Deep-dive docs (features, GraphRAG, approvals, rewind, etc.)
modes/
  agents/                Agent loop, tools, approvals, risk classifier, GUI server, rewind
  ask/                   Read-only Q&A mode
  cli.ts                 CLI mode router
  plan/                  Plan mode (planner, selection, web tools)
services/                Playwright browser service
testing-scripts/         bun:test suites + manual test scripts
tui/                     Wakeup launcher, terminal markdown renderer
utils/                   Git helper, repo map, graph scanner, semantic retrieval, checker
index.ts                 Entry point
```

---

## Testing

```bash
bun test
```

Or run individual suites:

```bash
bun test testing-scripts/semantic-and-memory.test.ts
bun test testing-scripts/risk-tiered-approval.test.ts
bun test testing-scripts/fuzzy-edit-matching.test.ts
bun test testing-scripts/advanced-features.test.ts
bun test testing-scripts/session-rewind.test.ts
bun test testing-scripts/dependency-graph.test.ts
bun test testing-scripts/test-sqlite-queue.ts
bun test testing-scripts/test-sqlite-router.ts
```

---

## Documentation

Deep-dive docs live in [`documentation/`](documentation/):

- [`advanced-features.md`](documentation/advanced-features.md) — Web Companion GUI, cost cap, AST-like repo map, self-healing loops
- [`GraphRAG-RollingMemory.md`](documentation/GraphRAG-RollingMemory.md) — intent-driven retrieval + rolling state memory
- [`risk-tiered-approval.md`](documentation/risk-tiered-approval.md) — the safety model
- [`session-rewind.md`](documentation/session-rewind.md) — git checkpoints & time travel
- [`codebase-graph.md`](documentation/codebase-graph.md) — dependency graph scanner
- [`competitive-analysis.md`](documentation/competitive-analysis.md) — full product-gap analysis & improvement roadmap

---

## Competitive Landscape & Roadmap

The 2026 market is dominated by **Claude Code** (best single-agent reasoning), **OpenAI Codex** (cheapest/time per task), **Cursor** (IDE + cloud agents), and **OpenCode** (leading open-source, model-agnostic harness). The industry's most-cited pain points right now are:

1. **Decision/approval fatigue** — AI writes more code than humans can meaningfully review.
2. **Token & cost waste from context engineering** — context quality, not usage, drives spiraling costs.
3. **Verification is the bottleneck** — agents that self-test and self-heal win.
4. **Extensibility** — MCP, skills, subagents, hooks are the expected extension surface.

OpenClaw already addresses #1 (risk-tiered approvals), #2 (GraphRAG + rolling memory + Skeletal Map), and #3 (shadow-compile + self-healing). The highest-leverage next moves, ranked:

1. **MCP client support** — let users attach any MCP server (databases, browsers, Jira, etc.) to the tool pool. This is table stakes in 2026.
2. **LSP diagnostics integration** — feed real-time type errors from the language server into the self-healing loop instead of (or before) a full `tsc` run.
3. **Subagents / parallel workers** — the `actor-engine` queue is the seed; wire it up with per-worker model choice, git worktrees, and a verifier/tester pipeline.
4. **Session persistence & resume** — serialize conversations/checkpoints to disk (SQLite already exists) so a crash or restart doesn't lose the scratchpad.
5. **Hooks** — pre/post tool-use lifecycle events (block, rewrite, annotate) for policy enforcement.
6. **Output styles & slash-command plugins** — make `/apply` etc. extensible.
7. **Eval harness** — a `Terminal-Bench`-style local benchmark of your own so regressions are caught before users do.
8. **Local embedding model** — swap OpenRouter embeddings for a local `bun`-native model so the whole pipeline can run offline.

See [`documentation/competitive-analysis.md`](documentation/competitive-analysis.md) for the full gap analysis.

---

## License

[MIT](LICENSE) © 2025 Abhinav.