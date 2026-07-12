# Risk-Tiered Approval

## What was built

Before this change, every staged change — a one-line comment fix, a brand-new file, and
`rm -rf node_modules` — went through the exact same approval prompt: `Accept / Show diff /
Reject`, one group at a time, with no signal about which one actually deserved careful attention.

Now every staged action (file create/modify/delete, folder create, shell command) is
automatically classified into one of three risk tiers the moment it's staged:

- **safe** — read-only actions (`read_file`, `list_files`, etc.). These already ran immediately
  without approval before this change, and still do — they're tagged for consistency, not
  gated.
- **low** — reversible, small-blast-radius mutations: a new file, an empty folder, or a small
  edit to a normal file.
- **high** — destructive or hard-to-predict: deleting a file, editing a sensitive file
  (`package.json`, `.env*`, lockfiles, `tsconfig*.json`, CI workflows, Dockerfiles), a large edit,
  or a shell command.

The approval screen now shows a colored risk badge next to every group (`HIGH RISK` / `low
risk` / `safe`) plus a one-line reason, and offers a new menu option — **"Auto-approve low-risk,
review high-risk individually"** — that skips the prompt entirely for low-risk groups and still
stops for a full Accept/Diff/Reject review on every high-risk one. The original "Approve all" and
"Review one by one" options are unchanged and still available.

On top of that, a small set of unambiguously dangerous shell command patterns (`rm -rf`, `git push
--force`, `git reset --hard`, `sudo`, `curl | sh`, formatting a drive, dropping a database, etc.)
require **typing the word "yes"** before an Accept is honored — a single accidental keypress or
mis-click on a menu can no longer approve one of these.

## Why it was needed

Two opposite, equally common complaints show up around agentic coding tools:

1. **Approval fatigue** — reviewing every single change with the same level of scrutiny becomes
   exhausting within days, so people start clicking "Approve all" without reading anything, which
   defeats the entire point of having a human in the loop.
2. **Fear of enabling auto-approve** — the opposite group refuses to turn on any auto-approval,
   because the only choice on offer is all-or-nothing: either review everything, or risk a
   destructive command running unattended.

Risk tiering is the only design that answers both at once: trivial, reversible changes stop
requiring a decision, while genuinely dangerous ones get *more* friction than before (the typed
confirmation), not less.

Concretely, before this change:
- `queueShell()` in `modes/agents/tool-executor.ts` staged every shell command identically — the
  approval UI just showed `Shell <command>` with zero signal about what it actually does.
- `runApprovalFlow()` in `modes/agents/approval.ts` grouped by file path and offered the same
  three options no matter what was inside — a one-line typo fix and a full-file delete looked
  identical.
- `AgentConfig.tools` in `modes/agents/types.ts` only had blunt, session-wide booleans
  (`allowShellExecution`, `allowFileModification`, ...) — no per-action risk awareness existed
  anywhere in the codebase.

## How it works

**`modes/agents/risk-classifier.ts`** (new file) holds all the classification logic:

- `classifyFileMutation(type, path, before, after)` — decides the tier for file/folder actions:
  - `file_delete` → always `high`.
  - `folder_create` → always `low`.
  - Any path matching a sensitive-file pattern (`.env*`, `package.json`, lockfiles,
    `tsconfig*.json`, `.github/workflows/`, Dockerfiles, `.git/`) → always `high`, regardless of
    how small the change is.
  - `file_create` → `low`.
  - `file_modify` (including `edit_file`) → counts actual changed lines using the `diff` package's
    `diffLines()` (the same diffing engine already used to render diffs in the approval UI); more
    than 40 changed lines → `high`, otherwise `low`.
- `classifyShellCommand(command)` — decides the tier for shell commands:
  - Splits the command on `&&`, `||`, `;`, and `|` into segments, so a dangerous command can't
    hide behind a harmless one it's chained together with (`git status && rm -rf dist` is still
    caught).
  - If any segment matches a known-dangerous pattern (destructive deletes, force pushes, `sudo`,
    piping a download straight into a shell, formatting a drive, dropping a database, ...) →
    `high`, plus `requiresTypedConfirmation: true`.
  - If every segment matches a known-safe, read-only allowlist (`git status`, `ls`, `pwd`,
    version checks, `bun test`, `tsc --noEmit`, ...) → `low`.
  - Anything else → `high` by default, without typed confirmation. Shell commands can do
    essentially anything, so the safe list is deliberately small and everything unrecognized is
    treated as risky rather than guessed at.
- `maxRiskTier(tiers)` — picks the highest tier out of a list, used when a group bundles multiple
  actions on the same path.

**`modes/agents/tool-executor.ts`** calls the relevant classifier function at every place an
action gets staged (`createFile`, `modifyFile`, `deleteFile`, `createFolder`, `editFile`,
`queueShell`) and attaches the result (`riskTier`, `riskReason`, `requiresTypedConfirmation`) to
the `ActionLog` entry via `ActionTracker.log()`.

**`modes/agents/approval.ts`** reads those fields back out when building review groups, picks the
group's overall risk as the highest tier among its actions, renders a badge + reason for every
group, adds the new "smart" menu option, and adds the typed-confirmation step before honoring an
Accept on anything flagged `requiresTypedConfirmation`.

## Workflow

1. The agent calls a mutating tool (e.g. `edit_file`, `execute_shell`, `delete_file`).
2. `ToolExecutor` stages the change as before, but now also classifies it and stores the tier +
   reason on the action log entry — this happens automatically, with no agent or user involvement.
3. When the run finishes (or the agent asks for a checkpoint), `runApprovalFlow()` groups the
   pending actions by file path (shell commands get their own group each) and computes each
   group's overall risk tier.
4. The user is asked how to apply changes:
   - **Approve and apply all** — unchanged, applies everything without review.
   - **Auto-approve low-risk, review high-risk individually** *(new)* — every `low`/`safe` group
     is approved automatically with a one-line log message; every `high` group still goes through
     the full Accept/Diff/Reject prompt, badge and reason shown up front.
   - **Review one by one** — unchanged behavior, but every group now shows its risk badge and
     reason before the prompt.
   - **Cancel** — unchanged, rejects everything.
5. Whenever the user picks Accept on a group flagged `requiresTypedConfirmation`, they're asked to
   type "yes" before the approval is recorded. Cancelling, typing anything else, or dismissing the
   prompt leaves that action pending and re-shows the menu for it instead of silently rejecting or
   accepting it.
6. Approved actions are applied exactly as before (`applyApprovedFromTracker()` is untouched).

## Where the code lives

- Classifier: `modes/agents/risk-classifier.ts`
- Staging call sites: `modes/agents/tool-executor.ts`
- Approval UI: `modes/agents/approval.ts`
- Data model: `modes/agents/types.ts` (`RiskTier`, and the new fields on `ActionLog`)
- Tests: `testing-scripts/risk-tiered-approval.test.ts`

## Known limitations

- The large-diff threshold (40 changed lines) and the dangerous/safe shell pattern lists are
  fixed constants in `risk-classifier.ts`, not user-configurable yet.
- The safe-shell allowlist is intentionally small and conservative — most real-world commands
  that aren't obviously destructive will still default to `high` risk rather than being guessed
  as safe. That's a deliberate trade-off (favoring "ask when unsure" over "guess and be wrong"),
  not an oversight.
