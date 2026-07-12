# Testing Scripts

One test file per feature, named after the feature (e.g. `fuzzy-edit-matching.test.ts`).

Written with Bun's built-in test runner (`bun:test`), so they:
- run with `bun test`
- are automatically picked up by the self-healing check loop in `utils/checker.ts` (which also runs `bun test`), so a broken feature blocks the agent's own generation loop too.

## Convention for every new feature

1. File name: `<feature-slug>.test.ts` (kebab-case, matches the doc in `documentation/`).
2. Use a fresh temp directory (`os.tmpdir()`) for any filesystem fixtures — never read or write real project files.
3. Clean up the temp directory in a `finally` block so a failed assertion doesn't leak it.
4. Cover at minimum:
   - the normal/expected case
   - the specific edge case(s) the feature was built to fix
   - the failure path (it should fail loudly and clearly, not silently do the wrong thing)
