# Session Rewind (checkpoints)

## What was built

A new "Rewind to a checkpoint" option in the main CLI menu that lets you undo the agent's last N
turns and go back to exactly how the codebase looked at an earlier point — no manual `git`
commands required.

It works because of something that was already happening but never surfaced to the user: every
time the agent's staged changes are approved and applied, `orchestrator.ts` auto-commits them
with a message like `abhiclaw: <your goal>`. Those commits were already sitting in the repo's
history; this feature just gives you a menu to browse them and jump back to one.

## Why it was needed

[[risk-tiered-approval]] made it easier to approve low-risk changes without reviewing every one
individually. That's good for reducing approval fatigue, but it also means it's easier for a
change you didn't really want to slip through unnoticed — so the natural next question is "okay,
how do I undo it if that happens?"

Before this feature, the honest answer was "know git well enough to find the right commit and
reset to it yourself." The commits were there, but:
- There was no way to *see* them as a list of "things the agent did," only as raw `git log` output
  mixed in with any other commits in the repo.
- `utils/git.ts` had a `rollback()` method that already existed, but it only undoes *uncommitted*
  changes (`git reset --hard HEAD`) — it can't undo something that was already committed, which is
  exactly the case that matters once auto-commit is involved. It was also never called from
  anywhere in the app.

Separately, while extending `utils/git.ts` for this feature, a real security issue turned up:
`commitApprovedChanges()` built its `git commit` command by pasting your free-text goal directly
into a shell string (`` `git commit -m "abhiclaw: ${message}"` ``, run via `execSync`, which always
goes through a shell). A goal containing a double quote, `` ` ``, `$()`, or `;` could break out of
the intended string and run arbitrary shell commands. Since this file was already being rewritten
for checkpoints, that was fixed at the same time by switching to `execFileSync`, which passes the
message as a real argument instead of text glued into a command line — no shell parsing involved,
so there's nothing to break out of.

## How it works

**`utils/git.ts`** gained two new static methods on `GitHelper`:

- `listCheckpoints(limit, cwd?)` — runs `git log` with a machine-parseable format (fields
  separated by the ASCII unit-separator character, so goal text containing normal punctuation
  can't be confused with a field boundary), keeps only commits whose message starts with
  `abhiclaw: ` (i.e. commits this tool made, not the user's own manual commits), and returns them
  newest-first as `{ hash, shortHash, goal, timestamp }`.
- `rewindToCheckpoint(hash, cwd?)` — validates the hash looks like a real git hash
  (`/^[0-9a-f]{4,40}$/i`), confirms the commit actually exists (`git cat-file -e`), then runs
  `git reset --hard <hash>`. This moves the branch pointer and the working tree files back to
  exactly that commit.

Every `GitHelper` method now accepts an optional `cwd` parameter (defaulting to the process's
current directory, matching the old behavior exactly) so the test suite can point it at a
disposable temp repo instead of the real project.

**`modes/agents/rewind.ts`** (new) is the interactive flow: lists checkpoints in a menu, and once
one is picked, shows an explicit warning about what will be lost (any commits after that point,
plus any uncommitted changes sitting in the working tree right now) before asking you to type the
word "yes" — the same typed-confirmation pattern used for dangerous shell commands in
[[risk-tiered-approval]], because a hard reset is exactly that kind of irreversible-from-here
action.

**`modes/cli.ts`** adds "Rewind to a checkpoint" as a top-level menu option, alongside Agent /
Plan / Ask mode.

## Workflow

1. You run the agent normally; each time its changes are approved and applied, a checkpoint
   commit (`abhiclaw: <goal>`) is created automatically — nothing new to do here.
2. From the main CLI menu, choose **Rewind to a checkpoint**.
3. If the folder isn't a git repo, or no checkpoints exist yet, you're told that directly and
   nothing else happens.
4. Otherwise you see a list of up to the 20 most recent checkpoints, each showing the goal text,
   short hash, and timestamp. Pick one, or cancel.
5. You're shown exactly what rewinding will discard (later commits, and any uncommitted changes),
   then asked to type "yes" to confirm.
6. On confirmation, the working tree and branch are hard-reset to that checkpoint. The result
   (success or a clear error) is printed immediately.

Nothing is permanently destroyed by this — git keeps discarded commits reachable through
`git reflog` for its normal garbage-collection window — but this tool doesn't expose a way to
redo/recover them, so the confirmation step treats it as irreversible from the user's point of
view.

## Where the code lives

- Checkpoint listing/reset + the injection fix: `utils/git.ts`
- Interactive menu: `modes/agents/rewind.ts`
- Menu wiring: `modes/cli.ts`
- Checkpoint creation (unchanged, just what this feature reads): `modes/agents/orchestrator.ts`
- Tests: `testing-scripts/session-rewind.test.ts`

## Known limitations

- Checkpoints are just git commits filtered by message prefix — if you rename/squash them, or the
  folder isn't a git repo at all, there's nothing to rewind to.
- `rewindToCheckpoint` always does a hard reset to the chosen commit; there's no "soft" option that
  preserves later commits as a new branch. If you might want those changes back, note the current
  commit hash (`git log`) before confirming.
- The checkpoint list is capped at the 20 most recent by default; older ones still exist in git
  history but aren't surfaced by this menu.
