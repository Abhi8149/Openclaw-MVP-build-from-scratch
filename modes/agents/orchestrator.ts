import { isCancel, text } from "@clack/prompts";
import chalk from "chalk";
import fs from "node:fs";
import { stepCountIs } from "ai";
import path from "node:path";
import { defaultAgentConfig } from "./types";
import { ActionTracker } from "./action-tracker";
import { ToolExecutor } from "./tool-executor";
import { createAgentTool } from "./agent-tools";
import { streamText } from "ai";
import { getAgentModel, MODEL_PRICING, wrapModelWithRollingMemory } from "../../ai";
import { renderTerminalMarkdown } from "../../tui/terminal-md";
import { runApprovalFlow, groupPending } from "./approval";
import { exec } from "node:child_process";
import { GitHelper } from "../../utils/git";
import { runProjectChecks } from "../../utils/checker";
import { GuiServer } from "./gui-server";
import { generateRepoMap } from "../../utils/repo-map";
import { semanticSearch, extractSkeleton, getLatestMatchedSymbols } from "../../utils/semantic-retrieval";
import { resolveImportPath } from "../../utils/graph-scanner";
import { runRewindMenu } from "./rewind";

/**
 * Execute a Single Agent Task (Inner Helper)
 * 
 * This is the core "run one task" logic extracted from the old runAgentMode.
 * It takes a goal string, runs the LLM agent with self-healing, and stages
 * any file mutations into the shared tracker/executor — but does NOT trigger
 * approval. The caller (the chat loop) decides when to approve.
 * 
 * Returns the total tokens used by this task for session-level cost tracking.
 */
/**
 * Recursively scans files in context for relative imports, resolving them and
 * extracting their AST skeletons up to a maximum recursion depth.
 */
export function traverseImports(
    initialFiles: string[],
    codebasePath: string,
    excludePatterns: string[],
    maxDepth = 2
): string {
    const visited = new Set<string>(initialFiles);
    const skeletons: string[] = [];
    const queue: Array<{ path: string; depth: number }> = initialFiles.map(p => ({ path: p, depth: 0 }));

    const importRegexes = [
        /from\s+["']([^"']+)["']/g,
        /import\s+["']([^"']+)["']/g,
        /(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g
    ];

    while (queue.length > 0) {
        const current = queue.shift()!;
        if (current.depth >= maxDepth) continue;

        const fullPath = path.join(codebasePath, current.path);
        let content = "";
        try {
            if (fs.existsSync(fullPath)) {
                content = fs.readFileSync(fullPath, "utf8");
            }
        } catch {
            continue;
        }

        const imports = new Set<string>();
        for (const regex of importRegexes) {
            regex.lastIndex = 0;
            let match;
            while ((match = regex.exec(content)) !== null) {
                const specifier = match[1];
                if (specifier) {
                    imports.add(specifier);
                }
            }
        }

        for (const specifier of imports) {
            const resolved = resolveImportPath(current.path, specifier, codebasePath);
            if (resolved && !visited.has(resolved)) {
                const isExcluded = excludePatterns.some((p) => {
                    if (p.includes("*")) {
                        const regex = new RegExp("^" + p.replace(/\*/g, ".*") + "$");
                        return regex.test(path.basename(resolved));
                    }
                    return resolved.startsWith(p) || path.basename(resolved) === p;
                });

                if (!isExcluded) {
                    visited.add(resolved);
                    try {
                        const targetFullPath = path.join(codebasePath, resolved);
                        if (fs.existsSync(targetFullPath)) {
                            const targetContent = fs.readFileSync(targetFullPath, "utf8");
                            const skeleton = extractSkeleton(resolved, targetContent);
                            skeletons.push(`--- Imported File Skeleton: ${resolved} ---\n${skeleton}`);
                            queue.push({ path: resolved, depth: current.depth + 1 });
                        }
                    } catch {}
                }
            }
        }
    }

    return skeletons.join("\n\n");
}

async function executeSingleTask(
    goal: string,
    config: ReturnType<typeof defaultAgentConfig>,
    tracker: ActionTracker,
    executor: ToolExecutor,
    guiServer: GuiServer | null,
    options?: { gui?: boolean; budget?: number; guiServer?: GuiServer; pinnedFiles?: string[] },
): Promise<{ promptTokens: number; completionTokens: number }> {
    const tools = createAgentTool(executor);

    // GraphRAG: Find the top 3 semantically related files based on task intent
    const relatedFiles = await semanticSearch(goal.trim(), config.codebasePath, config.excludePatterns);
    
    if (guiServer) {
        guiServer.setGraphMatchedFiles(relatedFiles.map(f => f.path));
    }

    /**
     * Dynamic Semantic File Content Getter
     * 
     * Returns the full text of GraphRAG-matched files plus any files the user
     * manually pinned via the Web UI graph or CLI commands. Evaluated lazily on every LLM turn
     * so that newly-pinned files are picked up immediately.
     */
    const getSemanticFilesContent = () => {
        const pinned = Array.from(new Set([
            ...(options?.pinnedFiles || []),
            ...(guiServer ? guiServer.getPinnedFiles() : [])
        ]));
        const allFiles = Array.from(new Set([
            ...relatedFiles.map(f => f.path),
            ...pinned
        ]));
        
        const mainContent = allFiles.map(p => {
            try {
                const fullPath = path.join(config.codebasePath, p);
                if (fs.existsSync(fullPath)) {
                    return `--- File: ${p} ---\n${fs.readFileSync(fullPath, "utf8")}`;
                }
            } catch {}
            return "";
        }).filter(Boolean).join("\n\n");

        const matchedSymbols = getLatestMatchedSymbols();

        const importedSkeletons = traverseImports(allFiles, config.codebasePath, config.excludePatterns, 2);

        return [mainContent, matchedSymbols, importedSkeletons].filter(Boolean).join("\n\n");
    };

    // Skeletal Map: Get line-by-line class and function mappings
    const skeletalMap = generateRepoMap(config.codebasePath, config.excludePatterns);

    // Rolling State Memory: Wrap model to summarize history and keep context compact
    const rawModel = await getAgentModel(goal);
    const wrappedModel = wrapModelWithRollingMemory(rawModel, goal, skeletalMap, getSemanticFilesContent);

    /**
     * System Prompt — Operational Rules for the Agent
     * 
     * These instructions are injected as the system message for every streamText
     * call. They enforce efficiency rules that prevent the model from wasting
     * tokens on redundant tool calls or unnecessary exploration turns.
     */
    const systemInstructions = [
        `Workspace root: ${config.codebasePath}`,
        "All mutations are staged until the user explicitly types /apply.",
        "",
        "CORE OPERATIONAL RULES FOR MAXIMUM EFFICIENCY AND COST SAVINGS:",
        "1. DO NOT REPEAT TOOL CALLS: If you have already called a tool with the same arguments (such as read_file with a path, or list_files), DO NOT call it again. Use the output already in the message history.",
        "2. BE CONCISE AND DIRECT: Minimize tool execution. If you can answer a request using the Skeletal Map or cached files, do not read more files.",
        "3. PREFER SPECIFIC TOOLS: To understand project structure, prefer calling specific analysis tools instead of looping over files.",
        "4. TERMINATE IMMEDIATELY: As soon as you have gathered enough details to fulfill the goal or answer a question, stop executing tools and return the final text response. Do not execute any extra turns."
    ].join("\n");

    let attempts = 0;
    const maxAttempts = config.maxSelfHealingAttempts;
    let feedback = "";
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    while (attempts < maxAttempts) {
        attempts++;
        if (guiServer) {
            guiServer.updateState((s) => {
                s.attempts = attempts;
                s.logs.push(`\n[Attempt ${attempts}/${maxAttempts}] Executing turn...`);
            });
        }

        const prompt = feedback
            ? `Your previous changes caused errors. Please fix these issues:\n${feedback}\n\nOriginal Goal: ${goal}`
            : goal.trim();

        /**
         * Streaming Generation via streamText()
         * 
         * WHAT CHANGED: Previously we used `ToolLoopAgent.generate()` which blocks
         * until the entire response (including all tool calls) completes. The user
         * sees nothing for 10-30 seconds on complex tasks — dead silence.
         * 
         * NOW: We use `streamText()` from the Vercel AI SDK which returns an
         * async iterable `fullStream`. We iterate over it and:
         *   - `text-delta` chunks → write to terminal stdout immediately AND
         *     broadcast to Web UI via SSE for real-time rendering
         *   - `tool-call` chunks → log tool usage to terminal and GUI logs
         * 
         * The `maxSteps: 40` parameter gives us the same multi-turn tool loop
         * that ToolLoopAgent provided. The `onStepFinish` callback still fires
         * after each complete step for granular logging.
         * 
         * HOW IT WORKS:
         * 1. streamText() starts the LLM request and immediately returns a result
         *    object with a `.fullStream` async iterable.
         * 2. We `for await` over fullStream — each iteration yields one chunk.
         * 3. For `text-delta` chunks, we call `process.stdout.write()` (no newline)
         *    to render text character-by-character as it arrives.
         * 4. For the Web UI, we call `guiServer.broadcastStreamChunk()` which sends
         *    a dedicated SSE event that the browser appends to an in-progress bubble.
         * 5. After the stream completes, we call `result.usage` (a Promise) to get
         *    final token counts for cost tracking.
         * 6. The accumulated full text is used for the final formatted message.
         */
        const result = (streamText as any)({
            model: wrappedModel,
            system: systemInstructions,
            prompt,
            tools: tools as any,
            stopWhen: stepCountIs(40),
            onStepFinish: ({ toolCalls }: any) => {
                for (const tc of toolCalls) {
                    const args = tc.args || tc.input;
                    const preview = JSON.stringify(args).slice(0, 160);
                    const logMsg = `  ✓ ${tc.toolName} ${preview}${preview.length >= 160 ? "..." : ""}`;
                    console.log(
                        chalk.green("  ✓"),
                        chalk.bold(String(tc.toolName)),
                        chalk.dim(preview + (preview.length >= 160 ? "..." : "")),
                    );
                    if (guiServer) {
                        guiServer.updateState((s) => {
                            s.logs.push(logMsg);
                        });
                    }
                }
            }
        });

        /**
         * Real-Time Stream Consumption
         * 
         * We iterate the fullStream to render text chunks as they arrive.
         * `fullStream` emits different chunk types:
         *   - text-delta: a fragment of the LLM's text response
         *   - tool-call: the LLM is invoking a tool (already handled by onStepFinish)
         *   - tool-result: the result of a tool execution
         * 
         * We accumulate the full text ourselves so we can use it for:
         *   1. Self-healing check (does the generated code compile?)
         *   2. Final formatted message in the Web UI
         *   3. Terminal markdown rendering after stream completes
         */
        let fullText = "";
        let streamStartedForGui = false;

        // Notify the Web UI that a new streaming message is starting
        if (guiServer) {
            guiServer.broadcastStreamChunk("", true); // true = start new message
            streamStartedForGui = true;
        }

        for await (const chunk of result.fullStream) {
            if (chunk.type === "text-delta") {
                const textChunk = (chunk as any).text || "";
                // Write raw text to terminal immediately — no buffering
                process.stdout.write(textChunk);
                fullText += textChunk;

                // Send chunk to Web UI for real-time rendering
                if (guiServer) {
                    guiServer.broadcastStreamChunk(textChunk, false);
                }
            }
        }

        // Add a newline after the streamed output completes
        if (fullText.trim()) {
            process.stdout.write("\n");
        }

        // Finalize the Web UI streaming bubble with metadata
        if (guiServer && streamStartedForGui) {
            guiServer.finalizeStreamMessage();
        }

        /**
         * Token Usage & Cost Tracking
         * 
         * `result.usage` is a Promise that resolves once the stream is fully
         * consumed. We await it here to get the final token counts.
         */
        const usage = await result.usage;
        if (usage) {
            totalPromptTokens += usage.inputTokens ?? 0;
            totalCompletionTokens += usage.outputTokens ?? 0;
        }

        const modelName = process.env.OPENROUTER_MODEL || "free";
        const rate = MODEL_PRICING[modelName] || { input: 0, output: 0 };
        const currentCost = ((totalPromptTokens * rate.input) + (totalCompletionTokens * rate.output)) / 1_000_000;

        if (guiServer) {
            guiServer.updateState((s) => {
                s.budgetUsed = currentCost;
            });
        }

        if (currentCost > config.maxBudget) {
            const errMsg = `❌ Budget exceeded: Spent $${currentCost.toFixed(6)} which exceeds limit of $${config.maxBudget.toFixed(2)}`;
            console.log(chalk.red(`\n${errMsg}\n`));
            if (guiServer) {
                guiServer.updateState((s) => {
                    s.status = "failed";
                    s.logs.push(errMsg);
                });
            }
            break;
        }

        // Run checks on staged files temporarily applied to the disk
        let checkPassed = true;
        let checkError = "";
        if (executor.hasStagedMutations()) {
            const cleanup = executor.tempWriteStaged();
            try {
                const check = runProjectChecks(config.codebasePath);
                checkPassed = check.passed;
                checkError = check.errorOutput || "Unknown compilation error";
            } finally {
                cleanup();
            }
        }

        if (checkPassed) {
            // Stream already printed to terminal in real-time; add final
            // formatted message to the Web UI chat with cost metadata
            if (fullText.trim() && guiServer) {
                const turnInput = usage?.inputTokens ?? 0;
                const turnOutput = usage?.outputTokens ?? 0;
                const turnCost = ((turnInput * rate.input) + (turnOutput * rate.output)) / 1_000_000;
                guiServer.addAgentMessage(fullText, {
                    tokens: { input: turnInput, output: turnOutput },
                    cost: turnCost,
                });
            }
            break; // Success!
        } else {
            const failMsg = `⚠️ Iteration ${attempts} failed checks. Let's fix it...`;
            console.log(chalk.yellow(`\n${failMsg}\n`));
            feedback = checkError;
            if (guiServer) {
                guiServer.updateState((s) => {
                    s.logs.push(failMsg);
                    s.logs.push(feedback);
                });
            }
        }
    }

    return { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens };
}

/**
 * Apply All Accumulated Staged Changes (Helper)
 * 
 * Runs the full approval flow (terminal or GUI), applies approved mutations
 * to disk, auto-commits to git, and clears the staging area.
 * Called when the user types /apply.
 */
async function applyAccumulatedChanges(
    tracker: ActionTracker,
    executor: ToolExecutor,
    guiServer: GuiServer | null,
    options?: { guiServer?: GuiServer },
): Promise<void> {
    console.log(chalk.dim(`\n🔍 [Debug] applyAccumulatedChanges called. Pending mutations: ${tracker.getPendingMutations().length}`));
    let ok = false;

    if (guiServer) {
        const pending = tracker.getPendingMutations();
        const groups = groupPending(pending).map((g) => ({
            label: g.label,
            tier: g.tier,
            reason: g.reason,
            patch: g.patch,
        }));
        guiServer.updateState((s) => {
            s.stagedGroups = groups;
        });
        ok = await guiServer.waitForUserApproval();
    } else {
        ok = await runApprovalFlow(tracker);
    }

    console.log(chalk.dim(`🔍 [Debug] Approval result: ok=${ok}`));

    if (!ok) {
        console.log(chalk.yellow("\n❌ Staged changes rejected.\n"));
        if (guiServer) {
            guiServer.updateState((s) => {
                s.status = "idle";
                s.logs.push("❌ Staged changes rejected by user.");
            });
        }
        executor.clearStaging();
        return;
    }

    console.log(chalk.dim(`🔍 [Debug] Calling applyApprovedFromTracker...`));
    const { errors } = await executor.applyApprovedFromTracker();
    console.log(chalk.dim(`🔍 [Debug] applyApprovedFromTracker returned. Errors: ${errors.length}`));

    if (errors.length) {
        console.log(chalk.red("\nSome operations reported errors:\n"));
        for (const e of errors) console.log(chalk.red(`  • ${e}`));
        if (guiServer) {
            guiServer.updateState((s) => {
                s.status = "idle";
                for (const e of errors) s.logs.push(`❌ Error: ${e}`);
            });
        }
    } else {
        console.log(chalk.green('\n✓ All staged changes applied successfully.\n'));
        if (guiServer) {
            guiServer.updateState((s) => {
                s.status = "idle";
                s.logs.push("✓ Staged changes successfully approved and applied.");
            });
        }

        // AUTO-COMMIT approved changes if inside Git repository
        if (GitHelper.isGitRepo()) {
            GitHelper.commitApprovedChanges("Applied accumulated changes");
            console.log(chalk.dim("Staged files auto-committed to git history."));
        }
    }

    executor.clearStaging();
}

/**
 * Agent Mode — Continuous Chat Loop with Accumulated Staging
 * 
 * This is the main entry point for Agent Mode. It:
 * 1. Creates a SHARED tracker and executor that persist across all tasks
 * 2. Enters a while(true) chat loop where the user types instructions
 * 3. After each task, shows a non-blocking summary of accumulated changes
 * 4. Recognizes slash commands:
 *    - /apply  → triggers bulk approval for ALL accumulated staged changes
 *    - /exit   → leaves agent mode (with option to apply pending changes first)
 *    - /rewind → opens the git checkpoint rewind menu
 * 5. Staged changes pile up across tasks until the user explicitly applies them
 */
export async function runAgentMode(options?: { gui?: boolean; budget?: number; goal?: string; guiServer?: GuiServer }) {
    console.log(chalk.bold("\n🤖 Agent Mode — Continuous Chat\n"));
    console.log(chalk.dim("  Commands: /apply (commit staged changes) | /exit (leave) | /rewind (time travel)\n"));

    const config = defaultAgentConfig();
    if (options?.budget !== undefined) {
        config.maxBudget = options.budget;
    }

    /**
     * Shared Tracker & Executor — Created Once, Persist Across All Tasks
     * 
     * This is the key architectural change. Previously, a new tracker/executor
     * was created for each task, and approval was forced before the next task.
     * Now they persist, so mutations from Task 1 + Task 2 + Task 3 all
     * accumulate in the same tracker, and the user applies them all at once.
     */
    const tracker = new ActionTracker();
    const executor = new ToolExecutor(tracker, config);
    const pinnedFiles: string[] = [];
    const taskHistory: string[][] = [];

    let guiServer: GuiServer | null = null;
    if (options?.gui) {
        if (options.guiServer) {
            guiServer = options.guiServer;
        } else {
            guiServer = new GuiServer();
            const url = await guiServer.start(8000);
            console.log(chalk.green(`\n🖥️  Visual Web Companion active at: ${url}\n`));
        }
        guiServer.updateState((s) => {
            s.status = "idle";
            s.maxAttempts = config.maxSelfHealingAttempts;
            s.maxBudget = config.maxBudget;
            s.logs = [];
            s.stagedGroups = [];
            s.messages = [];
        });
    }

    // Session-level cost tracking across all tasks
    let sessionPromptTokens = 0;
    let sessionCompletionTokens = 0;

    /**
     * Continuous Chat Loop
     * 
     * This while(true) loop is the heart of the new UX. The user stays in
     * Agent Mode, typing instructions one after another. Changes accumulate
     * silently. The loop only exits when the user types /exit.
     */
    let isFirstPrompt = true;
    while (true) {
        // For Web UI mode with a pre-supplied goal, use that goal on the first iteration
        let userInput: string;

        if (isFirstPrompt && options?.goal) {
            userInput = options.goal;
        } else if (isFirstPrompt && !options?.gui) {
            // First prompt in terminal mode: use the original welcoming message
            const input = await text({
                message: "What would you like the agent to do?",
                placeholder: " Concrete task for this codebase...",
            });
            if (isCancel(input) || !input.trim()) break;
            userInput = input.trim();
        } else if (options?.gui && guiServer) {
            // Web UI mode: wait for the next prompt from the browser
            guiServer.updateState((s) => { s.status = "idle"; });
            userInput = await guiServer.waitForGoal();
        } else {
            // Subsequent prompts in terminal mode: show pending count and available commands
            const pendingCount = tracker.getPendingMutations().length;
            const pendingHint = pendingCount > 0
                ? chalk.yellow(` (${pendingCount} staged change${pendingCount !== 1 ? "s" : ""} pending)`)
                : "";

            const input = await text({
                message: `💬 What next?${pendingHint}`,
                placeholder: " Next instruction, /apply, /exit, or /rewind...",
            });
            if (isCancel(input)) break;
            userInput = (input ?? "").trim();
            if (!userInput) continue;
        }

        isFirstPrompt = false;

        // ── Slash Command: /apply ──
        // Triggers the approval flow for ALL accumulated staged changes
        if (userInput.toLowerCase() === "/apply") {
            const pendingCount = tracker.getPendingMutations().length;
            if (pendingCount === 0) {
                console.log(chalk.dim("\nNo staged changes to apply.\n"));
                continue;
            }
            console.log(chalk.cyan(`\n📦 Applying ${pendingCount} accumulated staged change(s)...\n`));
            await applyAccumulatedChanges(tracker, executor, guiServer, options);
            continue;
        }

        // ── Slash Command: /exit ──
        // Leaves agent mode. If there are pending changes, warns the user.
        if (userInput.toLowerCase() === "/exit") {
            const pendingCount = tracker.getPendingMutations().length;
            if (pendingCount > 0) {
                console.log(chalk.yellow(`\n⚠️  You have ${pendingCount} unapplied staged change(s).`));
                console.log(chalk.yellow("    They will be discarded. Type /apply first if you want to keep them.\n"));
                const confirmExit = await text({
                    message: 'Type "exit" to confirm, or anything else to go back:',
                });
                if (isCancel(confirmExit) || confirmExit.trim().toLowerCase() !== "exit") {
                    continue;
                }
                executor.clearStaging();
            }
            break;
        }

        // ── Slash Command: /rewind ──
        // Opens the git checkpoint rewind menu without leaving agent mode
        if (userInput.toLowerCase() === "/rewind") {
            await runRewindMenu();
            continue;
        }

        // ── Slash Command: /add ──
        if (userInput.toLowerCase() === "/add" || userInput.toLowerCase().startsWith("/add ")) {
            const parts = userInput.split(/\s+/);
            if (parts.length < 2) {
                if (pinnedFiles.length === 0) {
                    console.log(chalk.dim("\nNo files currently pinned to context. Use /add <path> to pin.\n"));
                } else {
                    console.log(chalk.bold("\n📌 Pinned Files:"));
                    pinnedFiles.forEach(f => console.log(`  • ${f}`));
                    console.log();
                }
                continue;
            }
            const fileRel = parts.slice(1).join(" ").trim();
            const fullPath = path.resolve(config.codebasePath, fileRel);
            if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                const normPath = path.relative(config.codebasePath, fullPath).replace(/\\/g, "/");
                if (!pinnedFiles.includes(normPath)) {
                    pinnedFiles.push(normPath);
                    if (guiServer) {
                        guiServer.updateState(s => {
                            if (!s.pinnedFiles.includes(normPath)) {
                                s.pinnedFiles.push(normPath);
                            }
                        });
                    }
                    console.log(chalk.green(`\n✓ Pinned ${normPath} to LLM context.\n`));
                } else {
                    console.log(chalk.yellow(`\n⚠️  ${normPath} is already pinned.\n`));
                }
            } else {
                console.log(chalk.red(`\n❌ File not found or not a valid file: ${fileRel}\n`));
            }
            continue;
        }

        // ── Slash Command: /drop ──
        if (userInput.toLowerCase() === "/drop" || userInput.toLowerCase().startsWith("/drop ")) {
            const parts = userInput.split(/\s+/);
            if (parts.length < 2) {
                console.log(chalk.yellow("\n⚠️  Please specify a file path to drop: /drop <path>\n"));
                continue;
            }
            const fileRel = parts.slice(1).join(" ").trim();
            const fullPath = path.resolve(config.codebasePath, fileRel);
            const normPath = path.relative(config.codebasePath, fullPath).replace(/\\/g, "/");
            const index = pinnedFiles.indexOf(normPath);
            if (index !== -1) {
                pinnedFiles.splice(index, 1);
                if (guiServer) {
                    guiServer.updateState(s => {
                        s.pinnedFiles = s.pinnedFiles.filter(p => p !== normPath);
                    });
                }
                console.log(chalk.green(`\n✓ Dropped ${normPath} from pinned context.\n`));
            } else {
                console.log(chalk.yellow(`\n⚠️  ${fileRel} was not pinned.\n`));
            }
            continue;
        }

        // ── Slash Command: /clear ──
        if (userInput.toLowerCase() === "/clear") {
            console.clear();
            process.stdout.write("\x1Bc");
            if (guiServer) {
                guiServer.updateState(s => {
                    s.messages = [];
                    s.logs = [];
                });
            }
            console.log(chalk.dim("\nConsole and chat history cleared.\n"));
            continue;
        }

        // ── Slash Command: /tokens ──
        if (userInput.toLowerCase() === "/tokens") {
            const modelName = process.env.OPENROUTER_MODEL || "free";
            const rate = MODEL_PRICING[modelName] || { input: 0, output: 0 };
            const cost = ((sessionPromptTokens * rate.input) + (sessionCompletionTokens * rate.output)) / 1_000_000;
            console.log(chalk.bold("\n📊 Token Usage & Cost (Current Session):"));
            console.log(`  Input Tokens:      ${sessionPromptTokens}`);
            console.log(`  Output Tokens:     ${sessionCompletionTokens}`);
            console.log(`  Total Tokens:      ${sessionPromptTokens + sessionCompletionTokens}`);
            console.log(`  Estimated Cost:    $${cost.toFixed(6)} (${modelName})\n`);
            continue;
        }

        // ── Slash Command: /diff ──
        if (userInput.toLowerCase() === "/diff") {
            const pending = tracker.getPendingMutations();
            if (pending.length === 0) {
                console.log(chalk.dim("\nNo staged changes.\n"));
            } else {
                console.log(chalk.bold("\n🔍 Current Staged Changes:"));
                const groups = groupPending(pending);
                for (const g of groups) {
                    console.log(`\n--- ${g.label} (${g.tier.toUpperCase()} risk: ${g.reason}) ---`);
                    if (g.patch) {
                        const lines = g.patch.split("\n");
                        for (const line of lines) {
                            if (line.startsWith("+")) {
                                console.log(chalk.green(line));
                            } else if (line.startsWith("-")) {
                                console.log(chalk.red(line));
                            } else if (line.startsWith("@")) {
                                console.log(chalk.cyan(line));
                            } else {
                                console.log(line);
                            }
                        }
                    } else {
                        console.log(chalk.dim("  (No code diff for this action)"));
                    }
                }
                console.log();
            }
            continue;
        }

        // ── Slash Command: /undo ──
        if (userInput.toLowerCase() === "/undo") {
            const lastActionIds = taskHistory.pop();
            if (!lastActionIds || lastActionIds.length === 0) {
                console.log(chalk.yellow("\n⚠️  No recent task changes to undo.\n"));
            } else {
                executor.rollbackActions(lastActionIds);
                console.log(chalk.green(`\n✓ Undid changes for the last task (${lastActionIds.length} actions rolled back).\n`));
                if (guiServer) {
                    const pending = tracker.getPendingMutations();
                    const groups = groupPending(pending).map((g) => ({
                        label: g.label,
                        tier: g.tier,
                        reason: g.reason,
                        patch: g.patch,
                    }));
                    guiServer.updateState((s) => {
                        s.stagedGroups = groups;
                    });
                }
            }
            continue;
        }

        // ── Slash Command: /help ──
        if (userInput.toLowerCase() === "/help") {
            console.log(chalk.bold("\n💡 Available Commands:"));
            console.log(`  ${chalk.cyan("/add <path>")}   - Pin a file to the context for all future prompts`);
            console.log(`  ${chalk.cyan("/drop <path>")}  - Remove a pinned file from the context`);
            console.log(`  ${chalk.cyan("/clear")}        - Clear the terminal screen and Web UI chat logs`);
            console.log(`  ${chalk.cyan("/tokens")}       - Show token usage and estimated cost for current session`);
            console.log(`  ${chalk.cyan("/diff")}         - View all currently staged changes as a unified diff`);
            console.log(`  ${chalk.cyan("/undo")}         - Discard staged changes from the most recent task`);
            console.log(`  ${chalk.cyan("/rewind")}       - Open the git checkpoint rewind menu to undo turns`);
            console.log(`  ${chalk.cyan("/apply")}        - Review, approve, and apply all staged changes`);
            console.log(`  ${chalk.cyan("/exit")}         - Exit agent mode`);
            console.log();
            continue;
        }

        // ── Regular Task Execution ──
        if (guiServer) {
            guiServer.updateState((s) => {
                s.goal = userInput;
                s.status = "running";
                s.logs.push(`\n── New Task: ${userInput.slice(0, 80)}${userInput.length > 80 ? "..." : ""} ──`);
            });
        }

        const actionsBefore = tracker.getActions().map(a => a.id);

        const { promptTokens, completionTokens } = await executeSingleTask(
            userInput, config, tracker, executor, guiServer, {
                ...options,
                pinnedFiles,
            }
        );

        const actionsAfter = tracker.getActions().map(a => a.id);
        const newActionIds = actionsAfter.filter(id => !actionsBefore.includes(id));
        if (newActionIds.length > 0) {
            taskHistory.push(newActionIds);
        }

        sessionPromptTokens += promptTokens;
        sessionCompletionTokens += completionTokens;

        // Show a non-blocking summary of accumulated staged changes
        const pendingCount = tracker.getPendingMutations().length;
        if (pendingCount > 0) {
            console.log(chalk.cyan(`\n📦 ${pendingCount} staged change(s) accumulated. Type ${chalk.bold("/apply")} to commit them.\n`));
        }

        // Update GUI with staged groups (non-blocking, just for display)
        if (guiServer) {
            const pending = tracker.getPendingMutations();
            const groups = groupPending(pending).map((g) => ({
                label: g.label,
                tier: g.tier,
                reason: g.reason,
                patch: g.patch,
            }));
            guiServer.updateState((s) => {
                s.stagedGroups = groups;
                s.status = "idle";
            });
        }
    }

    // Display session cost and token analytics when leaving agent mode
    if (sessionPromptTokens > 0 || sessionCompletionTokens > 0) {
        const modelName = process.env.OPENROUTER_MODEL || "free";
        const rate = MODEL_PRICING[modelName] || { input: 0, output: 0 };
        const cost = ((sessionPromptTokens * rate.input) + (sessionCompletionTokens * rate.output)) / 1_000_000;

        console.log(chalk.dim(`\n📊 [Session Statistics]`));
        console.log(chalk.dim(`   Tokens: ${sessionPromptTokens} input | ${sessionCompletionTokens} output`));
        console.log(chalk.dim(`   Estimated Cost: $${cost.toFixed(6)}`));
    }

    // Clean up GUI server if we created it ourselves
    if (guiServer && !options?.guiServer) {
        await new Promise((r) => setTimeout(r, 1000));
        guiServer.stop();
    }

    console.log(chalk.dim("\n👋 Left Agent Mode.\n"));
}