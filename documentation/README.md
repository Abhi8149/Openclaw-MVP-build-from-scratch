# Documentation

One `.md` file per feature, named after the feature (e.g. `fuzzy-edit-matching.md`), matching
the corresponding test file in `testing-scripts/`.

Each doc answers four questions in plain, non-jargon language:

- **What** was built
- **Why** it was needed — the actual problem/complaint that motivated it
- **How** it works — the real mechanism, not just a restatement of "what"
- **Workflow** — the step-by-step of what happens at runtime when this feature is used

## Index

- [fuzzy-edit-matching.md](./fuzzy-edit-matching.md) — resilient search/replace matching for the `edit_file` tool
- [risk-tiered-approval.md](./risk-tiered-approval.md) — classifies staged actions by risk and adjusts the approval flow per tier
- [session-rewind.md](./session-rewind.md) — browse and hard-reset to any past auto-commit checkpoint from a CLI menu
- [competitive-analysis.md](./competitive-analysis.md) — audit against Claude Code / OpenCode / OpenClaw, plus a prioritized improvement roadmap
