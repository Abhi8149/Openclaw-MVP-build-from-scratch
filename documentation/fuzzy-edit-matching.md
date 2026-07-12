# Fuzzy Edit Matching (`edit_file` resilience)

## What was built

The `edit_file` tool lets the AI make a targeted change to a file by giving a `search` block
(the exact code to find) and a `replace` block (what to put instead), instead of rewriting the
whole file. Previously, `editFile()` in `modes/agents/tool-executor.ts` only accepted the
`search` block if it matched the file **character-for-character**. If the AI's `search` text had
even one different space, tab, or line break compared to the real file, the edit failed outright
with `Could not find search block`.

That method has been upgraded to try three levels of matching, in order, before giving up:

1. **Exact match** — identical behavior to before. Fast, and used whenever the text matches perfectly.
2. **Indentation-tolerant match** — matches even if the whole block is indented differently
   (e.g. the AI copied the snippet without its surrounding indent level), then re-applies the
   *real* file's indentation to the replacement so nesting stays correct.
3. **Whitespace-tolerant match** — matches even if spacing *inside* a line changed (e.g. an
   extra space around an operator), by collapsing runs of spaces/tabs to a single space for
   comparison purposes only (the actual file content is not touched by this normalization).

If none of the three levels find exactly one match, the edit still fails with a clear error — it
never guesses when a match is ambiguous or missing.

## Why it was needed

This was the single most common real-world complaint about "search and replace" style AI code
editing (the same pattern used by tools like Aider): the AI regularly reformats code slightly
when it writes out a `search` block from memory — different indentation, an extra space, tabs vs.
spaces — even though it's clearly referring to the same code. An exact-match-only implementation
throws that away as a hard failure, forcing a retry (burning tokens and time) or a fallback to a
full-file rewrite (defeating the point of targeted edits).

Since this tool already had the exact-match version (see `GUIDE_ADDING_FEATURES.md`, Feature 1),
this change closes the gap between "works in the demo" and "works when a real model sends
slightly-off whitespace," which is what people actually run into.

## How it works

The core building blocks (top of `modes/agents/tool-executor.ts`):

- `leadingWhitespace(line)` — returns the leading spaces/tabs of a line.
- `collapseWhitespace(line)` — trims a line and collapses internal whitespace runs to one space,
  used only for *comparing* lines, never for writing output.
- `findLineWindowMatches(contentLines, searchLines, normalize)` — slides the search block over
  the file line-by-line, comparing every line pair with a given `normalize` function (either
  "trim only" or "collapse whitespace"), and returns every starting line index where **all**
  lines match. If it returns more than one index, that match level is ambiguous.
- `reindentReplacement(replaceLines, searchFirstLine, actualFirstLine)` — computes how many
  characters of indentation the real file's matched line has compared to the search block's
  first line, then applies that **same shift** to every line of the replacement (not just the
  first line), so nested lines keep their correct relative depth instead of all collapsing to one
  indentation level.

## Workflow

When the agent calls `edit_file` with one or more `{ search, replace }` pairs, for each pair:

1. Try an exact substring match on the current file content.
   - Exactly one occurrence → replace it directly, done.
   - More than one occurrence → throw "Ambiguous match" immediately (never silently pick one).
   - Zero occurrences → fall through to step 2.
2. Split both the file and the search block into lines. Look for a window of lines whose
   **trimmed** content matches the search block's trimmed lines.
   - Exactly one window found → re-indent the replacement to match the file's real indentation,
     splice it in, done.
3. If step 2 found nothing, retry the same line-window search but comparing
   **whitespace-collapsed** lines instead of just trimmed lines (catches internal spacing changes).
   - Exactly one window found → re-indent and splice in, done.
4. If no level found a unique match, throw an error naming every strategy that was tried, plus
   the original search text, so the failure is debuggable instead of cryptic.

Each `edit` in the `edits` array runs through this cascade in order, against the file content as
modified by any earlier edits in the same call — exactly like the original implementation, just
with a smarter matching step.

## Where the code lives

- Implementation: `modes/agents/tool-executor.ts` — helper functions near the top of the file,
  `editFile()` method near the bottom.
- Tests: `testing-scripts/fuzzy-edit-matching.test.ts` — run with `bun test`.
