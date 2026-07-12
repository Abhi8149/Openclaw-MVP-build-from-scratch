# OpenClaw (AbhiClaw)

> An AI-powered, human-in-the-loop coding agent that runs in your terminal.

**OpenClaw** (branded **AbhiClaw** in the CLI) is a TypeScript agent built on the
[Vercel AI SDK](https://sdk.vercel.ai/) and the [OpenRouter](https://openrouter.ai/) model
gateway. It ships three complementary workflows — an autonomous **Agent**, a stepwise **Plan**
builder, and a read-only **Ask** mode — all wrapped in a safety model that stages every mutation,
classifies each change by risk, asks for approval before anything touches your disk, and records
git "checkpoints" you can rewind to.

It runs on the [Bun](https://bun.com) runtime and uses `@clack/prompts` for an interactive
terminal UI, `marked`/`marked-terminal` for rendering markdown, `figlet` for the splash banner,
and the `diff` library for patch rendering.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Features](#features)
3. [Architecture & Design](#architecture--design)
   - [High-Level Flow](#high-level-flow)
   - [Directory Layout](#directory-layout)
   - [Core Subsystems](#core-subsystems)
   - [Staging & Approval Model](#staging--approval-model)
   - [Risk-Tiered Classification](#risk-tiered-classification)
   - [Self-Healing Loop](#self-healing-loop)
   - [Git Checkpoints & Session Rewind](#git-checkpoints--session-rewind)
   - [Fuzzy Edit Matching](#fuzzy-edit-matching)
4. [Modes in Detail](#modes-in-detail)
   - [Agent Mode](#agent-mode)
   - [Plan Mode](#plan-mode)
   - [Ask Mode](#ask-mode)
   - [Rewind](#rewind)
5. [Tools Available to the Agent](#tools-available-to-the-agent)
6. [Configuration & Environment Variables](#configuration--environment-variables)
7. [Testing](#testing)
8. [Security Considerations](#security-considerations)
9. [Known Limitations](#known-limitations)
10. [Tech Stack](#tech-stack)

---

## Quick Start

```bash
# 1. Install dependencies
bun install

# 2. Set your API keys (see Configuration)
export OPENROUTER_API_KEY="sk-or-..."
export OPENROUTER_MODEL="anthropic/claude-3.5-sonnet"   # any OpenRouter model id

# 3. Launch the agent
bun run index.ts wakeup
```

`bun run index.ts wakeup` prints the banner and drops you into the main menu where you pick
**CLI** (the full set of sub-modes) or **Telegram** (stubbed/empty today). From the CLI menu you
can choose **Agent mode**, **Planmode**, **Ask mode**, or **Rewind to a checkpoint**.

> The project was scaffolded with `bun init`. `index.ts` is also registered as the
> `Abhiclaw-build` bin in `package.json`, and `bin` parsing is handled by [`commander`](https://github.com/tj/commander.js).

---

## Features

| # | Feature | What it does |
|---|---------|--------------|
| 1 | **Three interaction modes** | Autonomous coding (**Agent**), research-then-execute (**Plan**), and a read-only Q&A (**Ask**) mode, plus a **Rewind** menu. |
| 2 | **Targeted `edit_file` with fuzzy matching** | Makes small, surgical edits via search/replace blocks instead of rewriting whole files — and tolerates indentation and internal-whitespace differences the model introduces from memory. |
| 3 | **Staged mutations + human approval** | Nothing is written to disk until you approve it. Every create/modify/delete/folder/shell action is staged, then reviewed in a diff-aware prompt. |
| 4 | **Risk-tiered approval** | Each staged action is auto-classified `safe` / `low` / `high`. A "smart" option auto-approves low-risk work but still stops you on high-risk changes. Dangerous shell commands require typing `yes`. |
| 5 | **Git-backed auto-commit & rollback** | Approved changes auto-commit as `abhiclaw: <goal>` checkpoints, so a bad turn is always recoverable via git. |
| 6 | **Session Rewind** | A CLI menu that lists every agent checkpoint (goal, hash, time) and hard-resets the tree back to any one of them. |
| 7 | **Self-healing test & build loop** | The agent runs up to 3 attempts; after each, it type-checks (`tsc --noEmit`) and runs the test suite, feeding failures back to the model until checks pass. |
| 8 | **Repository mapping** | A `get_repo_map` tool returns a condensed file/function layout so the model finds the right file without reading everything. |
| 9 | **Token usage & cost monitor** | Per-session input/output token counts and an estimated dollar cost, computed from a model pricing table. |
| 10 | **Workspace sandboxing** | All paths are resolved and checked against the workspace root and an exclude list; `allow*` config flags switch whole tool families on/off. |
| 11 | **Diff rendering in the approval UI** | Unified diffs (via the `diff` library) are rendered inline as terminal markdown before you accept a change. |
| 12 | **Skills support** | `list_skills` / `read_skill` surface `SKILL.md` files from Cursor/Claude skill directories and a configurable `SKILLS_DIRS` list. |
| 13 | **Web research tools** | Plan and Ask modes can search, crawl, and fetch URLs via Firecrawl when `FIRECRAWL_API_KEY` is set. |
| 14 | **Terminal markdown + banner** | Agent prose is rendered with `marked`/`marked-terminal`; the launcher shows a `figlet` splash. |

---

## Architecture & Design

OpenClaw is deliberately layered: a thin **entry/UI shell** drives one of several **mode
orchestrators**, each of which assembles an agent from a shared **tool executor**, an **action
tracker**, a **risk classifier**, and an **approval flow**. Filesystem effects are never applied
directly — they are *staged* into an in-memory overlay and only flushed after the user approves.

### High-Level Flow

```
index.ts  (commander)
   └─ wakeup ─► tui/runWakeup.ts  (figlet banner + CLI/Telegram/Exit)
                   └─ CLI ─► modes/cli.ts  (sub-mode menu)
                                 ├─ Agent  ─► modes/agents/orchestrator.ts
                                 ├─ Plan   ─► modes/plan/orchestrator.ts
                                 ├─ Ask    ─► modes/ask/orchestrator.ts
                                 └─ Rewind ─► modes/agents/rewind.ts
```

Every mode that can mutate code follows the same lifecycle:

```
prompt → ToolLoopAgent (tools call ToolExecutor) → actions staged in overlay
   → (optional self-heal: temp-write + runProjectChecks)
      → runApprovalFlow  → applyApprovedFromTracker  → GitHelper.commitApprovedChanges
```

### Directory Layout

```
.
├── index.ts                  # Entry point (commander "wakeup")
├── ai/                       # Model wiring + pricing
│   ├── index.ts
│   └── ai.config.ts          # getAgentModel(), MODEL_PRICING
├── modes/
│   ├── cli.ts                # Top-level sub-mode menu
│   ├── agents/               # The autonomous agent + its safety machinery
│   │   ├── orchestrator.ts    # Agent mode loop, self-heal, cost stats, commit
│   │   ├── tool-executor.ts   # Staging engine + every file/shell operation
│   │   ├── agent-tools.ts     # AI SDK tool definitions for agent mode
│   │   ├── action-tracker.ts  # Append-only log of all actions
│   │   ├── approval.ts        # Grouping, risk badges, interactive review
│   │   ├── risk-classifier.ts # safe/low/high classification logic
│   │   ├── diff-view.ts       # Before/after → unified patch
│   │   ├── rewind.ts          # Rewind-to-checkpoint menu
│   │   └── types.ts           # ActionLog, AgentConfig, RiskTier
│   ├── plan/                 # Plan mode (research → select → execute)
│   │   ├── orchestrator.ts
│   │   ├── planner.ts         # JSON-schema plan generation
│   │   ├── selection.ts       # Pretty-print + multiselect steps
│   │   ├── types.ts
│   │   └── web-tool.ts        # Firecrawl web_search/crawl + fetch_url
│   └── ask/                  # Read-only Q&A mode
│       └── orchestrator.ts
├── tui/
│   ├── runWakeup.ts          # Banner + mode selection
│   └── terminal-md.ts        # Markdown → terminal renderer
├── utils/
│   ├── git.ts                # GitHelper: checkpoints, rewind, security-hardened commit
│   ├── checker.ts            # runProjectChecks (tsc + bun test)
│   └── repo-map.ts           # generateRepoMap
├── documentation/            # One .md per feature (the "what/why/how/workflow" docs)
├── testing-scripts/          # One *.test.ts per feature (Bun test runner)
└── package.json
```

### Core Subsystems

#### 1. `ToolExecutor` — the staging engine (`modes/agents/tool-executor.ts`)

This is the heart of the system. Instead of mutating the filesystem directly, every write
operation is staged into an in-memory `overlay: Map<string, string>` plus a `deleted: Set<string>`.
Read operations consult the overlay first (`getEffectiveText`) so the agent sees its own pending
edits as if they were already on disk.

Key responsibilities:

- **Path safety** — `resolveSafe()` blocks any path that escapes the workspace root; `excluded()`
  consults `excludePatterns` (e.g. `node_modules`, `.git`, `.env*`). `assertNotExcluded()` throws
  before any read/mutation on a blocked path.
- **Operations** — `readFile`, `createFile`, `modifyFile`, `deleteFile`, `createFolder`,
  `listFiles`, `searchFiles` (glob + optional content filter), `analyzeCodebase`, `queueShell`,
  `editFile`, `listSkills`, `readSkill`.
- **`editFile`** — the fuzzy-matching search/replace engine (see [Fuzzy Edit Matching](#fuzzy-edit-matching)).
- **`tempWriteStaged()` / `clearStaging()`** — backs up the real files, writes the overlay to disk,
  and returns a restore closure. Used by the self-healing loop to run checks against the *proposed*
  state without committing to it.
- **`applyApprovedFromTracker()`** — the only place real writes (`fs.writeFileSync`, `fs.mkdirSync`,
  `fs.rmSync`) and real shell runs (`spawnSync(..., { shell: true })`) happen, and only for actions
  marked `approved`. It collapses multiple edits on the same path to the last one and applies them
  in timestamp order.
- **Risk tagging** — every mutating call invokes the risk classifier and stores `riskTier`,
  `riskReason`, and `requiresTypedConfirmation` on the `ActionLog`.

#### 2. `ActionTracker` — the action log (`modes/agents/action-tracker.ts`)

A simple append-only list of `ActionLog` records (`log`, `getActions`, `getPendingMutations`,
`updateStatus`). It is the single source of truth the approval flow and the executor's apply step
read from. Each entry carries type, path, before/after details, status, and the risk fields.

#### 3. Risk classifier (`modes/agents/risk-classifier.ts`)

Pure classification functions with no I/O:

- `classifyFileMutation(type, path, before, after)` → tier + reason
- `classifyShellCommand(command)` → tier + reason (+ `requiresTypedConfirmation`)
- `maxRiskTier(tiers)` and a `RISK_RANK` ordering (`safe < low < high`)

Rules (see [Risk-Tiered Classification](#risk-tiered-classification)).

#### 4. Approval flow (`modes/agents/approval.ts`)

Turns the staged actions into reviewable groups and drives the interactive prompts
(`@clack/prompts`). Builds `ReviewGroup`s (grouped by file path; each shell command its own group),
computes each group's risk as the highest tier among its actions, and renders a colored
`HIGH RISK` / `low risk` / `safe` badge with a one-line reason.

#### 5. Diff view (`modes/agents/diff-view.ts`)

`composeBeforeAfter()` collapses a group's actions into a single before/after pair; `formatPatch()`
produces a unified diff with 3 lines of context via `diff`'s `createTwoFilesPatch`, rendered as
terminal markdown in the approval UI.

#### 6. Git helper (`utils/git.ts`)

`GitHelper` wraps git for safety/checkpoints. `commitApprovedChanges` uses **`execFileSync`** (no
shell) so a goal containing quotes, backticks, `$()`, or `;` cannot break out into another command.
`listCheckpoints` parses `git log` with a unit-separator field delimiter and only returns commits
prefixed `abhiclaw: `. `rewindToCheckpoint` validates the hash shape, confirms it exists
(`git cat-file -e`), then `git reset --hard`.

#### 7. Checker (`utils/checker.ts`)

`runProjectChecks(cwd)` runs `bunx tsc --noEmit` then `bun test` (ignoring "No tests found!"),
returning `{ passed, errorOutput }`. This is both the self-healing loop's oracle and what
`bun test` itself exercises for this repo's feature tests.

#### 8. Repo map (`utils/repo-map.ts`)

`generateRepoMap` recursively scans `.ts`/`.js` files, skipping `excludePatterns`, and extracts
top-level `class`/`function`/`export const` declarations with a regex — a compact map the agent
reads before deciding which file to open.

#### 9. AI config (`ai/ai.config.ts`)

`getAgentModel()` builds an OpenRouter provider from `OPENROUTER_API_KEY` and returns the model
named by `OPENROUTER_MODEL`. `MODEL_PRICING` maps model ids to `{ input, output }` USD-per-million
rates, used for the cost monitor.

#### 10. Terminal markdown & banner (`tui/`)

`renderTerminalMarkdown` configures `marked` + `marked-terminal` (width clamped to the terminal)
and is used wherever the agent returns prose. `runWakeup` renders the "AbhiClaw" `figlet` banner
with a shadow effect and the CLI/Telegram/Exit menu.

### Staging & Approval Model

The defining design decision is **staging before applying**:

1. The agent calls tools; `ToolExecutor` records each mutation intent in the overlay + `ActionTracker`.
2. Reads see staged edits immediately (`getEffectiveText`), so the agent reasons about a coherent
   proposed state rather than stale disk contents.
3. When the run ends, `runApprovalFlow` groups and classifies the pending mutations.
4. Only after approval does `applyApprovedFromTracker` write to the real filesystem / run shell
   commands — and then `GitHelper.commitApprovedChanges` snapshots the result as a checkpoint.

This gives you a genuine human-in-the-loop: you can **Accept / Show diff / Reject** per group,
**Approve and apply all**, **Auto-approve low-risk, review high-risk individually**, or **Cancel**
(which rejects everything and clears staging).

### Risk-Tiered Classification

Classification happens automatically at staging time — the agent and user are never involved.

**File/folder tiers** (`classifyFileMutation`):

- `file_delete` → **high** (destructive, only git-recoverable).
- `folder_create` → **low** (no destructive effect).
- Any path matching a **sensitive pattern** → **high**, regardless of diff size:
  `.env*`, `package.json`, lockfiles (`bun.lock`, `package-lock.json`, `yarn.lock`,
  `pnpm-lock.yaml`), `tsconfig*.json`, `.github/workflows/`, Dockerfiles, `.git/`.
- `file_create` → **low** (nothing overwritten).
- `file_modify` / `edit_file` → counts changed lines with `diff`'s `diffLines`; **> 40 lines → high**,
  else **low**.

**Shell tiers** (`classifyShellCommand`):

- The command is split on `&&`, `||`, `;`, `|` into segments so a dangerous command can't hide
  behind a safe one it's chained with.
- Any segment matching a **dangerous pattern** (`rm -rf`, `git push --force`, `git reset --hard`,
  `sudo`, `curl|wget ... | sh`, drive format, `drop table/database`, `dd if=`, `git clean -f`,
  `chmod 777`, `shutdown`, …) → **high** + `requiresTypedConfirmation: true`.
- If **every** segment matches a small read-only allowlist (`ls`, `git status/diff/log`, `pwd`,
  version checks, `bun test`, `tsc --noEmit`, …) → **low**.
- Anything else → **high** (without typed confirmation). Shell can do anything, so the safe list is
  intentionally tiny and everything unrecognized is treated as risky rather than guessed.

In the approval UI, a group whose highest tier is `high` and that flags `requiresTypedConfirmation`
forces the user to type `yes` before an Accept is honored — a single mis-click cannot approve
`rm -rf` or a force-push.

### Self-Healing Loop

In **Agent mode**, after each generation the orchestrator does up to `maxAttempts = 3` iterations:

```
agent.generate(prompt)
   → tempWriteStaged()            # write overlay to disk (with backups)
   → runProjectChecks(cwd)        # tsc --noEmit + bun test
   → (finally) restore closure    # put originals back
   ├─ passed  → render answer, break
   └─ failed  → feedback = errorOutput; re-prompt model to fix
```

The model never sees the failing code "committed"; it only sees the diagnostics, and the real
filesystem is restored before any approval step. If all attempts fail, the last error feedback is
shown and the run proceeds to the normal approval flow.

### Git Checkpoints & Session Rewind

Every successful apply in Agent (and Plan) mode calls `GitHelper.commitApprovedChanges(goal)`,
creating a commit prefixed `abhiclaw: <goal>`. Those commits are the project's undo history.

**Session Rewind** (`modes/agents/rewind.ts`) lists the most recent 20 checkpoints (goal, short
hash, timestamp) and, once one is chosen, shows exactly what will be lost (later commits + current
uncommitted changes) and requires typing `yes` before `git reset --hard <hash>`. Discarded commits
remain reachable via `git reflog` for git's normal GC window — but this tool exposes no recovery,
so the confirmation treats it as irreversible from the user's perspective.

> **Security note:** the original `commitApprovedChanges` interpolated the free-text goal into a
> shell string (`git commit -m "abhiclaw: ${message}"` via `execSync`), which allowed shell
> injection. It was rewritten to use `execFileSync` with the message as a real argv entry, so
> quotes/backticks/`$()` in a goal are stored literally, not executed. Tests in
> `testing-scripts/session-rewind.test.ts` assert this.

### Fuzzy Edit Matching

The `edit_file` tool accepts an array of `{ search, replace }` blocks. `ToolExecutor.editFile`
applies each against the current (overlay) content using a three-level cascade:

1. **Exact substring match** — the original fast path; if exactly one occurrence, replace and done.
   More than one → throw `Ambiguous match` (never guess).
2. **Indentation-tolerant** — slide the search block over the file line-by-line comparing *trimmed*
   lines; if a unique window matches, re-indent the replacement to the file's real indentation via
   `reindentReplacement` (it shifts every line by the same delta, preserving nested depth) and splice
   it in.
3. **Whitespace-tolerant** — retry the window search but collapse internal runs of spaces/tabs to a
   single space (`collapseWhitespace`) before comparing, catching reformatted internal spacing.

If none of the three finds exactly one match, it throws a clear error naming every strategy tried.
This closes the gap between "works in the demo" and "works when a real model sends slightly-off
whitespace," which is the most common cause of search/replace edit failures.

---

## Modes in Detail

### Agent Mode

File: `modes/agents/orchestrator.ts`. The autonomous coding loop.

- Prompts for a goal, builds a `ToolLoopAgent` (`stepCountIs(40)`) wired to `createAgentTool(executor)`
  with the instruction *"All mutations are staged until approval."*
- Runs the **self-healing loop** (≤3 attempts) described above.
- Prints **session statistics** (input/output tokens + estimated cost) using `MODEL_PRICING`.
- Runs `runApprovalFlow`; on approval, applies changes and auto-commits a checkpoint.

### Plan Mode

Files: `modes/plan/*`. Research-first, user-gated execution.

1. `generatePlan(goal)` runs a **read-only** agent (`readOnlyTools` + optional `createWebTools`) that
   returns a JSON plan (1–15 steps with title/description/hints/complexity) via
   `extractJsonMiddleware` + `Output.object`.
2. `printPlan` shows a research summary and numbered steps with complexity colors; `selectSteps`
   uses a `multiselect` so you pick exactly which steps to run (all selected by default).
3. Each chosen step is executed by its own `ToolLoopAgent` (`stepCountIs(30)`) using the *full*
   `createAgentTool` set, then the whole batch goes through the normal approval + apply + commit flow.

### Ask Mode

File: `modes/ask/orchestrator.ts`. Read-only Q&A.

- Starts from `defaultAgentConfig` but disables `allowShellExecution`, `allowFileModification`, and
  `allowFolderCreation` (only `allowFileCreation` stays on, so it can save its answer as a `.md`).
- Tools: `createAskTools` (read-only set) + `createWebTools` (web research).
- Renders the answer as markdown; optionally saves it (via staged `createFile` + approval) to a
  `.md` file in the current directory.

### Rewind

File: `modes/agents/rewind.ts`. Accessible from the CLI sub-mode menu. Lists `abhiclaw:` checkpoints
and hard-resets to the chosen one after a typed `yes` confirmation. No-ops with a clear message if
the folder isn't a git repo or no checkpoints exist yet.

---

## Tools Available to the Agent

| Tool | Mode(s) | Description |
|------|---------|-------------|
| `read_file` | Agent, Plan (read-only), Ask | Read a text file (size-limited, exclude-checked). |
| `list_files` | Agent, Plan (read-only), Ask | List a directory (optionally recursive). |
| `search_files` | Agent, Plan (read-only), Ask | Glob + optional content substring search. |
| `analyze_codebase` | Agent, Plan (read-only), Ask | Count files/directories under a path. |
| `create_file` | Agent, Ask | Stage a new file. |
| `modify_file` | Agent | Stage a full-file replacement. |
| `delete_file` | Agent | Stage a file deletion. |
| `create_folder` | Agent | Stage a directory tree. |
| `edit_file` | Agent | Targeted search/replace edits (fuzzy-matched). |
| `execute_shell` | Agent | Queue a shell command (risk-classified, approved later). |
| `get_repo_map` | Agent | Condensed file/function map of the project. |
| `list_skills` | Agent, Plan (read-only), Ask | List `SKILL.md` paths under skill roots. |
| `read_skill` | Agent, Plan (read-only), Ask | Read a `SKILL.md` (path-validated to skill roots). |
| `web_search` | Plan, Ask | Firecrawl web search (needs `FIRECRAWL_API_KEY`). |
| `web_crawl` | Plan, Ask | Firecrawl URL → markdown scrape. |
| `fetch_url` | Plan, Ask | Plain `fetch` of a URL. |

> Tool definitions are deliberately duplicated per mode (`agent-tools.ts`, `ask/orchestrator.ts`
> `createAskTools`, `plan/planner.ts` `readOnlyTools`) so each mode exposes exactly the capability
> surface it should — e.g. Plan's planner gets read-only + web, Ask gets read-only + web, while the
> Agent gets the full mutating set.

---

## Configuration & Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `OPENROUTER_API_KEY` | Yes | API key for the OpenRouter model gateway. |
| `OPENROUTER_MODEL` | No (defaults to `"free"`) | Model id, e.g. `anthropic/claude-3.5-sonnet`. Also the key used to look up `MODEL_PRICING`. |
| `FIRECRAWL_API_KEY` | No | Enables `web_search`/`web_crawl` in Plan & Ask modes. Without it, web tools are omitted. |
| `SKILLS_DIRS` | No | Semicolon-separated extra roots scanned by `list_skills`/`read_skill` (in addition to `~/.cursor/skills-cursor` and `~/.claude/skills`). |

Runtime behavior is also controlled by `AgentConfig` (`modes/agents/types.ts`): `codebasePath`
(defaults to `process.cwd()`), `maxFileSizeToRead` (1 MB), `excludePatterns`, and the
`allowShellExecution` / `allowFileModification` / `allowFileCreation` / `allowFolderCreation` flags.

---

## Testing

Feature tests live in `testing-scripts/` (one `*.test.ts` per feature, mirroring
`documentation/`). They use Bun's built-in runner and must:

- use a fresh `os.tmpdir()` directory for fixtures,
- clean it up in a `finally` block,
- cover the normal case, the edge case the feature fixes, and a failure path.

```bash
bun test
```

Files:

- `fuzzy-edit-matching.test.ts` — exact / indentation-tolerant / whitespace-tolerant matches, plus
  clear errors for missing and ambiguous blocks.
- `risk-tiered-approval.test.ts` — file/shell classification, dangerous-chain detection, and that
  `ToolExecutor` tags staged actions with the right tier + `requiresTypedConfirmation`.
- `session-rewind.test.ts` — checkpoint listing/filtering, shell-injection-safe commit, rewind
  restore, and invalid/missing-hash rejection.

> Because the self-healing check loop (`utils/checker.ts`) runs `bun test`, a broken feature test
> also blocks the agent's own generation loop — the same gate protects the tool and its users.

The `documentation/` folder holds one plain-language `.md` per feature answering **What / Why / How
/ Workflow**, which is the canonical reference for each capability above.

---

## Security Considerations

- **Staged-by-default**: writes and shell runs never reach the filesystem until explicitly approved.
- **Workspace sandboxing**: `resolveSafe` rejects any path escaping the root; `excluded` blocks
  sensitive-ish locations from reads/mutations.
- **Shell-command safety**: risky shell commands are flagged `high`; a known-dangerous subset
  requires typing `yes`; everything unrecognized defaults to `high`.
- **No shell interpolation in git**: `commitApprovedChanges` passes the goal as an `execFileSync`
  argv entry, eliminating command injection via the commit message.
- **Rewind confirmation**: `git reset --hard` requires a typed `yes` and warns about lost commits
  and uncommitted changes.
- **`read_skill` path validation**: only paths under configured skill roots are readable.
- **Sensitive-file protection**: edits to `.env*`, `package.json`, lockfiles, `tsconfig*.json`, CI
  workflows, and Dockerfiles are always `high` risk regardless of size.

---

## Known Limitations

- The large-diff threshold (40 lines) and the dangerous/safe shell pattern lists are fixed constants
  in `risk-classifier.ts`, not user-configurable.
- The safe-shell allowlist is deliberately small; many benign commands still default to `high`.
- Checkpoints are just git commits filtered by the `abhiclaw:` prefix — renaming/squashing them, or
  a non-git folder, leaves nothing to rewind to.
- `rewindToCheckpoint` always does a **hard** reset; there is no "soft" option preserving later
  commits as a branch.
- The Rewind list is capped at the 20 most recent checkpoints.
- `repository map` uses a regex for symbol extraction (no real parser), so it may miss some
  declarations.
- The **Telegram** mode in the wakeup menu is currently an empty stub.
- `edit_file` matching is whitespace/indentation-tolerant but not semantically aware — genuinely
  ambiguous or absent blocks still fail loudly rather than guessing.

---

## Tech Stack

| Concern | Library |
|---------|---------|
| Runtime | [Bun](https://bun.com) |
| Language | TypeScript (strict, `tsconfig.json`) |
| Agent loop / tools | [`ai`](https://sdk.vercel.ai/) (Vercel AI SDK, `ToolLoopAgent`, `tool`, `stepCountIs`) |
| Model gateway | [`@openrouter/ai-sdk-provider`](https://openrouter.ai/) |
| CLI framework | [`commander`](https://github.com/tj/commander.js) |
| Interactive prompts | [`@clack/prompts`](https://github.com/natemoo-re/clack) |
| Terminal color | [`chalk`](https://github.com/chalk/chalk) |
| Banner | [`figlet`](https://github.com/patorjk/figlet.js) |
| Markdown rendering | [`marked`](https://github.com/markedjs/marked) + [`marked-terminal`](https://github.com/markedjs/marked-terminal) |
| Diffs | [`diff`](https://github.com/kpdecker/jsdiff) |
| Web research | [`@mendable/firecrawl-js`](https://www.firecrawl.dev/) |
| Schema validation | [`zod`](https://zod.dev/) (via `ai`) |

---

*OpenClaw — staged, risk-aware, self-healing coding assistance in your terminal.*
