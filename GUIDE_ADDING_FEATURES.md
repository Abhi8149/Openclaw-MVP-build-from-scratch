# Step-by-Step Guide: Upgrading AbhiClaw to Claude Code / Aider Capabilities

Welcome! This guide will walk you through implementing next-generation agent features in your **AbhiClaw** codebase. By adding these features, you will make AbhiClaw much faster, cheaper to run, safer, and self-healing.

---

## Table of Contents
1. [Feature 1: Search-and-Replace Blocks (Efficient Editing)](#feature-1-search-and-replace-blocks-efficient-editing)
2. [Feature 2: Git-Backed Auto-Commit & Rollback (Safety)](#feature-2-git-backed-auto-commit--rollback-safety)
3. [Feature 3: Self-Healing Test & Build Loop (Autonomy)](#feature-3-self-healing-test--build-loop-autonomy)
4. [Feature 4: Repository Mapping (Token Optimization)](#feature-4-repository-mapping-token-optimization)
5. [Feature 5: Token Usage & Cost Monitor (Analytics)](#feature-5-token-usage--cost-monitor-analytics)

---

## Feature 1: Search-and-Replace Blocks (Efficient Editing)

### Why we need it:
Right now, AbhiClaw uses the `modify_file` tool, which forces the AI model to output the **entire contents** of a file even if it only needs to change a single word. 
* If a file has 400 lines (approx. 3,000 tokens), modifying one line takes **3,000 output tokens**.
* Output tokens are slow to generate and represent 80-90% of your API cost.
* By using **Search-and-Replace Blocks**, the model only needs to output the specific line it wants to change (e.g., 50 tokens), saving you up to 95% in costs and making the agent 10x faster.

### How it works under the hood:
Instead of sending the whole new file content, the AI outputs a list of "edits" consisting of a `search` block (code to find) and a `replace` block (code to put in its place). 

### How to implement it:

#### Step A: Update the tools definition
Open your [modes/agents/agent-tools.ts](file:///c:/Users/abhinav/OneDrive/Desktop/openclaw/modes/agents/agent-tools.ts).
1. Add a new tool called `edit_file`.
2. Define the schema to accept an array of search/replace objects.

*Example tool configuration:*
```typescript
edit_file: tool({
    description: "Make targeted edits to a file using search and replace blocks.",
    inputSchema: z.object({
        path: z.string().describe("Relative path of the file"),
        edits: z.array(z.object({
            search: z.string().describe("The exact block of code to find (must match exactly including spacing)"),
            replace: z.string().describe("The block of code to replace it with")
        })).min(1)
    }),
    execute: async ({ path: p, edits }) => executor.editFile(p, edits)
})
```

#### Step B: Add the `editFile` method to the executor
Open your [modes/agents/tool-executor.ts](file:///c:/Users/abhinav/OneDrive/Desktop/openclaw/modes/agents/tool-executor.ts). Add the following method:

```typescript
editFile(rel: string, edits: Array<{ search: string; replace: string }>): string {
    if (!this.config.tools.allowFileModification) {
        throw new Error("File modification disabled");
    }
    this.assertNotExcluded(rel, "edit_file");

    const key = this.norm(rel);
    const originalContent = this.getEffectiveText(rel);
    if (originalContent === undefined) {
        throw new Error(`edit_file: file not found: ${rel}`);
    }

    let currentContent = originalContent;

    // Apply each search-and-replace block one by one
    for (const edit of edits) {
        const searchStr = edit.search;
        const replaceStr = edit.replace;

        if (!currentContent.includes(searchStr)) {
            throw new Error(`Could not find search block in ${rel}:\n${searchStr}`);
        }

        // Verify there is only one match to avoid editing the wrong place
        const occurrences = currentContent.split(searchStr).length - 1;
        if (occurrences > 1) {
            throw new Error(`Ambiguous match: search block appears multiple times in ${rel}`);
        }

        currentContent = currentContent.replace(searchStr, replaceStr);
    }

    // Stage the modification using the existing overlay map
    this.overlay.set(key, currentContent);
    
    // Log the action to the tracker so diffs can be generated
    this.tracker.log({
        type: "file_modify",
        path: key,
        details: { before: originalContent, after: currentContent },
        status: "pending",
    });

    return `Staged targeted edits for: ${key}`;
}
```

---

## Feature 2: Git-Backed Auto-Commit & Rollback (Safety)

### Why we need it:
If an AI agent edits multiple files and introduces bugs that break your project, you have to manually undo the changes. 
Claude Code and Aider prevent this by integrating with Git:
1. Every time a task starts, they check if git is clean.
2. Once the user approves a set of changes, the changes are automatically committed to git with a clear description (e.g. `abhiclaw: fixed return bug`).
3. If anything goes wrong, you can run a single command to discard the changes.

### How to implement it:

#### Step A: Create a Git Utility helper
Create a new file: `utils/git.ts` in your codebase:

```typescript
import { execSync } from "node:child_process";

export class GitHelper {
    static isGitRepo(): boolean {
        try {
            execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
            return true;
        } catch {
            return false;
        }
    }

    static hasUncommittedChanges(): boolean {
        try {
            const out = execSync("git status --porcelain", { encoding: "utf8" });
            return out.trim().length > 0;
        } catch {
            return false;
        }
    }

    static commitApprovedChanges(message: string): void {
        try {
            execSync("git add -A");
            execSync(`git commit -m "abhiclaw: ${message}"`);
        } catch (e) {
            console.error("Git commit failed:", e);
        }
    }

    static rollback(): void {
        try {
            execSync("git reset --hard HEAD");
            console.log("Successfully rolled back all local changes.");
        } catch (e) {
            console.error("Git rollback failed:", e);
        }
    }
}
```

#### Step B: Integrate it into your Orchestrator
Open [modes/agents/orchestrator.ts](file:///c:/Users/abhinav/OneDrive/Desktop/openclaw/modes/agents/orchestrator.ts). Update the final approval execution block:

```typescript
    const ok = await runApprovalFlow(tracker);
    if (!ok) return executor.clearStaging();

    const { errors } = executor.applyApprovedFromTracker();

    if (errors.length) {
        console.log(chalk.red("\nSome operations reported errors:\n"));
        for (const e of errors) console.log(chalk.red(`  • ${e}`));
    } else {
        console.log(chalk.green('\n✓ Applied.\n'));
        
        // AUTO-COMMIT approved changes if inside Git repository
        if (GitHelper.isGitRepo()) {
            GitHelper.commitApprovedChanges(goal.trim());
            console.log(chalk.dim("Staged files auto-committed to git history."));
        }
    }
```

---

## Feature 3: Self-Healing Test & Build Loop (Autonomy)

### Why we need it:
A coding agent frequently makes small errors like:
* Missing imports.
* Syntax mistakes.
* Breaking existing test suites.

With a **Self-Healing Loop**, instead of failing and asking you to fix it, AbhiClaw will automatically run compilation/test checks in the background. If they fail, it reads the error log, gives it back to the AI model, and tells it to try again until it compiles cleanly.

### How it works:
```
  ┌────────────────────────────────────────────────────────┐
  │                                                        │
  ▼                                                        │
Agent Writes Code ──► Run compiler/linter/test commands    │
                          │                                │
                          ├──► If Fails ──► Feed errors ───┘
                          │
                          └──► If Passes ──► Present to User
```

### How to implement it:

#### Step A: Add a compilation and test runner utility
Create a check function inside `utils/checker.ts`:

```typescript
import { spawnSync } from "node:child_process";

export interface DiagnosticResult {
    passed: boolean;
    errorOutput?: string;
}

export function runProjectChecks(cwd: string): DiagnosticResult {
    // 1. Run TypeScript typecheck (if tsconfig exists)
    const tsc = spawnSync("bunx", ["tsc", "--noEmit"], { cwd, encoding: "utf8" });
    if (tsc.status !== 0) {
        return { passed: false, errorOutput: `TypeScript Errors:\n${tsc.stdout || tsc.stderr}` };
    }

    // 2. Run Test suite (if test command is available in package.json)
    const test = spawnSync("bun", ["test"], { cwd, encoding: "utf8" });
    if (test.status !== 0) {
        return { passed: false, errorOutput: `Test Suite Failures:\n${test.stdout || test.stderr}` };
    }

    return { passed: true };
}
```

#### Step B: Integrate the self-healing loop in your Agent Orchestrator
Open [modes/agents/orchestrator.ts](file:///c:/Users/abhinav/OneDrive/Desktop/openclaw/modes/agents/orchestrator.ts). Modify the generation loop:

```typescript
    // Inside runAgentMode
    let attempts = 0;
    const maxAttempts = 3;
    let feedback = "";

    while (attempts < maxAttempts) {
        attempts++;
        const prompt = feedback 
            ? `Your previous changes caused errors. Please fix these issues:\n${feedback}\n\nOriginal Goal: ${goal}`
            : goal.trim();

        const result = await agent.generate({
            prompt,
            onStepFinish: ({ toolCalls }) => { /* ... logging ... */ }
        });

        // Run checks on staged files (by applying temporarily to a memory stream or running test commands)
        const check = runProjectChecks(config.codebasePath);
        if (check.passed) {
            if (result.text?.trim()) console.log(renderTerminalMarkdown(result.text));
            break; // Success!
        } else {
            console.log(chalk.yellow(`\n⚠️ Iteration ${attempts} failed checks. Let's fix it...\n`));
            feedback = check.errorOutput || "Unknown compilation error";
        }
    }
```

---

## Feature 4: Repository Mapping (Token Optimization)

### Why we need it:
To build context, the AI needs to know what files and functions exist. 
* Sending all files will exceed model token limits and cost dollars per query.
* A **Repository Map** scans the folders, extracts the file structure, and creates a condensed layout of classes, methods, and functions.
* When the agent runs, it reads this map first to identify which file it needs to read.

### How to implement it:

#### Step A: Create a Repository Mapper helper
Create `utils/repo-map.ts` to scan files and list structure:

```typescript
import fs from "node:fs";
import path from "node:path";

export function generateRepoMap(dir: string, excludes: string[]): string {
    const lines: string[] = [];

    function scan(currentDir: string) {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });

        for (const entry of entries) {
            const relPath = path.relative(dir, path.join(currentDir, entry.name));
            if (excludes.some(ex => relPath.includes(ex))) continue;

            if (entry.isDirectory()) {
                scan(path.join(currentDir, entry.name));
            } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) {
                lines.push(`- ${relPath}`);
                // Extract functions & classes using regex for simplicity
                const code = fs.readFileSync(path.join(currentDir, entry.name), "utf8");
                const matches = code.match(/(class \w+|function \w+|export const \w+\s*=)/g);
                if (matches) {
                    matches.forEach(m => lines.push(`    • ${m.trim()}`));
                }
            }
        }
    }

    scan(dir);
    return lines.join("\n");
}
```

#### Step B: Add a `get_repo_map` tool to your agent
Open [modes/agents/agent-tools.ts](file:///c:/Users/abhinav/OneDrive/Desktop/openclaw/modes/agents/agent-tools.ts) and register the tool:

```typescript
get_repo_map: tool({
    description: "Get a map of all files and top-level exported functions in the project.",
    inputSchema: z.object({}),
    execute: async () => generateRepoMap(executor.config.codebasePath, executor.config.excludePatterns)
})
```

---

## Feature 5: Token Usage & Cost Monitor (Analytics)

### Why we need it:
AI developers often complain about unexpected API costs when building complex projects. Claude Code displays exactly how many tokens were read and written, along with the monetary cost.

### How to implement it:

#### Step A: Track model prices
Define pricing structures in [ai/ai.config.ts](file:///c:/Users/abhinav/OneDrive/Desktop/openclaw/ai/ai.config.ts):

```typescript
// Price per 1 Million tokens
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
    "meta-llama/llama-3.2-3b-instruct:free": { input: 0.0, output: 0.0 },
    "nvidia/nemotron-3-ultra-550b-a55b:free": { input: 0.0, output: 0.0 },
    "tencent/hy3:free": { input: 0.0, output: 0.0 },
    "poolside/laguna-m.1:free": { input: 0.0, output: 0.0 },
    "cohere/north-mini-code:free": { input: 0.0, output: 0.0 },
};
```

#### Step B: Read and display usage metrics after execution
Open [modes/agents/orchestrator.ts](file:///c:/Users/abhinav/OneDrive/Desktop/openclaw/modes/agents/orchestrator.ts). Display usage details:

```typescript
    const result = await agent.generate({ prompt: goal.trim() });
    
    // Extract metadata
    const usage = result.usage;
    if (usage) {
        const inputTokens = usage.promptTokens;
        const outputTokens = usage.completionTokens;
        
        // Calculate cost
        const modelName = process.env.OPENROUTER_MODEL || "free";
        const rate = MODEL_PRICING[modelName] || { input: 0, output: 0 };
        const cost = ((inputTokens * rate.input) + (outputTokens * rate.output)) / 1_000_000;

        console.log(chalk.dim(`\n📊 [Session Statistics]`));
        console.log(chalk.dim(`   Tokens: ${inputTokens} input | ${outputTokens} output`));
        console.log(chalk.dim(`   Estimated Cost: $${cost.toFixed(6)}`));
    }
```

---

## What to Do Next

1. Run **`bun index.ts wakeup`** and test each modification as you write it.
2. Implement **Feature 1** first since it provides the highest speedups and cost savings immediately.
3. Make sure to run `bun install` if you install any new packages (like `tree-sitter` for the repo mapping).

Good luck upgrading AbhiClaw!
