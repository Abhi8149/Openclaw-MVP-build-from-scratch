# Advanced Product Enhancements: Web Companion GUI, Cost Cap, & Self-Healing Loops

This documentation details the implementation and user workflow of the advanced feature set added to AbhiClaw, aimed at outperforming other coding agents in ease-of-use, cost-effectiveness, and reliability.

---

## 1. Visual Web Companion Mode (GUI)

### Core Concept
To make CLIs accessible to non-technical users and visually intuitive for developers, AbhiClaw can now host a **Visual Web Companion Dashboard** on a local port. Instead of reading raw Git diffs or JSON updates inside a crowded terminal, the dashboard provides a modern web interface.

### Workflow & User Experience
1. **Startup**: Run the CLI with the `--gui` flag:
   ```bash
   bun index.ts wakeup --gui
   ```
2. **Dashboard Open**: The CLI prints a link: `🖥️  Visual Web Companion active at: http://127.0.0.1:8000`. Opening this in any browser displays the premium dashboard.
3. **Execution Stream**: As the AI agent selects tools and edits files, the logs are streamed in real-time to the browser via **Server-Sent Events (SSE)**.
4. **Interactive Approval/Rejection**: 
   - When the agent finishes staging all mutations (files modified, created, or shell commands), it changes state to `Awaiting Approval`.
   - The right pane displays all staged changes in structured, color-coded Git diffs.
   - The visual buttons `Approve & Apply` and `Reject & Abort` become active.
   - Clicking `Approve` tells the local HTTP server to resolve the orchestrator's lock. The changes are written to disk, auto-committed, and the agent completes. Clicking `Reject` aborts and discards staged changes.

---

## 2. LLM Cost Cap & Token Guardrails

### Core Concept
AI models can enter infinite correction loops, leading to unexpected API costs. To guarantee safe limits, we added cost-tracking guardrails.

### Workflow
1. **Configure Budget**: Specify a dollar budget limit using the `--budget` flag:
   ```bash
   bun index.ts wakeup --budget 0.25
   ```
   *(Defaults to $1.00 USD if not specified).*
2. **Continuous Check**: After each LLM API request, the token usage is multiplied by the model's prompt and completion rates.
3. **Automatic Abort**: If the cumulative session cost exceeds the limit:
   - The agent loop immediately halts.
   - All staged changes in the overlay are cleared (no files are broken on disk).
   - An error message is displayed: `❌ Budget exceeded: Spent $X.XXXXXX which exceeds limit of $Y.YY`.
   - The GUI server streams the cost failure and closes.

---

## 3. AST-like Code Snippets (Repository Map Extension)

### Core Concept
Instead of reading large source files and exhausting context windows, the repository map now leverages a **brace-matching parser** to locate start/end lines for all class and function blocks.

### Workflow
1. When the agent requests the codebase map (`get_repo_map`), the tool scans the directory structure.
2. For each `.ts` or `.js` file, it isolates class names and function keywords.
3. It counts brace pairings `{` and `}` starting at the definition line.
4. It outputs clean metadata:
   ```
   - utils/git.ts
       • export class GitHelper (lines 20-136)
       • static isGitRepo (lines 21-28)
       • static hasUncommittedChanges (lines 30-37)
   ```
5. The agent can use this map to pinpoint exactly what lines to load via target reads rather than requesting whole files, reducing token costs by up to 80%.

---

## 4. Self-Healing Compiler Loops

### Core Concept
Staged modifications are compiled and tested inside a temp overlay before any files are permanently saved.

### Workflow
1. Staged edits are temporarily written.
2. The compiler check validates Typescript compilation (`tsc --noEmit`) and runs the unit tests (`bun test`).
3. If errors are caught:
   - The error output is packaged.
   - The agent is prompted: `Iteration X failed checks. Please fix these issues: <error logs>`.
   - The agent refactors the problematic code segments and retries up to the `maxSelfHealingAttempts` (default: 3) limit.
