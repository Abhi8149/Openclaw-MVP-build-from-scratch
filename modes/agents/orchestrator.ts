import { isCancel, text } from "@clack/prompts";
import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import { defaultAgentConfig } from "./types";
import { ActionTracker } from "./action-tracker";
import { ToolExecutor } from "./tool-executor";
import { createAgentTool } from "./agent-tools";
import { stepCountIs, ToolLoopAgent } from "ai";
import { getAgentModel, MODEL_PRICING, wrapModelWithRollingMemory } from "../../ai";
import { renderTerminalMarkdown } from "../../tui/terminal-md";
import { runApprovalFlow, groupPending } from "./approval";
import { exec } from "node:child_process";
import { GitHelper } from "../../utils/git";
import { runProjectChecks } from "../../utils/checker";
import { GuiServer } from "./gui-server";
import { generateRepoMap } from "../../utils/repo-map";
import { semanticSearch } from "../../utils/semantic-retrieval";
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
async function executeSingleTask(
    goal: string,
    config: ReturnType<typeof defaultAgentConfig>,
    tracker: ActionTracker,
    executor: ToolExecutor,
    guiServer: GuiServer | null,
    options?: { gui?: boolean; budget?: number; guiServer?: GuiServer },
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
     * manually pinned via the Web UI graph. Evaluated lazily on every LLM turn
     * so that newly-pinned files are picked up immediately.
     */
    const getSemanticFilesContent = () => {
        const pinned = guiServer ? guiServer.getPinnedFiles() : [];
        const allFiles = Array.from(new Set([
            ...relatedFiles.map(f => f.path),
            ...pinned
        ]));
        
        return allFiles.map(p => {
            try {
                const fullPath = path.join(config.codebasePath, p);
                if (fs.existsSync(fullPath)) {
                    return `--- File: ${p} ---\n${fs.readFileSync(fullPath, "utf8")}`;
                }
            } catch {}
            return "";
        }).filter(Boolean).join("\n\n");
    };

    // Skeletal Map: Get line-by-line class and function mappings
    const skeletalMap = generateRepoMap(config.codebasePath, config.excludePatterns);

    // Rolling State Memory: Wrap model to summarize history and keep context compact
    const rawModel = getAgentModel(goal);
    const wrappedModel = wrapModelWithRollingMemory(rawModel, goal, skeletalMap, getSemanticFilesContent);

    /**
     * Tool Loop Agent Initialization
     * 
     * We initialize the ToolLoopAgent wrapping the model with rolling memory.
     * Crucially, we supply strict operational rules in the instructions to prevent the model
     * from executing redundant loops (like reading the same file repeatedly) and force it to
     * terminate as soon as it has gathered sufficient information to answer.
     */
    const agent = new ToolLoopAgent({
        model: wrappedModel,
        stopWhen: stepCountIs(40),
        instructions: [
            `Workspace root: ${config.codebasePath}`,
            "All mutations are staged until the user explicitly types /apply.",
            "",
            "CORE OPERATIONAL RULES FOR MAXIMUM EFFICIENCY AND COST SAVINGS:",
            "1. DO NOT REPEAT TOOL CALLS: If you have already called a tool with the same arguments (such as read_file with a path, or list_files), DO NOT call it again. Use the output already in the message history.",
            "2. BE CONCISE AND DIRECT: Minimize tool execution. If you can answer a request using the Skeletal Map or cached files, do not read more files.",
            "3. PREFER SPECIFIC TOOLS: To understand project structure, prefer calling specific analysis tools instead of looping over files.",
            "4. TERMINATE IMMEDIATELY: As soon as you have gathered enough details to fulfill the goal or answer a question, stop executing tools and return the final text response. Do not execute any extra turns."
        ].join("\n"),
        tools,
    });

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

        const result = await agent.generate({
            prompt,
            onStepFinish: ({ toolCalls }) => {
                for (const tc of toolCalls) {
                    const preview = JSON.stringify(tc.input).slice(0, 160);
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

        if (result.usage) {
            totalPromptTokens += result.usage.inputTokens ?? 0;
            totalCompletionTokens += result.usage.outputTokens ?? 0;
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
        const cleanup = executor.tempWriteStaged();
        let check;
        try {
            check = runProjectChecks(config.codebasePath);
        } finally {
            cleanup();
        }

        if (check.passed) {
            if (result.text?.trim()) {
                const md = renderTerminalMarkdown(result.text);
                console.log(md);
                if (guiServer) {
                    const turnInput = result.usage?.inputTokens ?? 0;
                    const turnOutput = result.usage?.outputTokens ?? 0;
                    const modelName = process.env.OPENROUTER_MODEL || "free";
                    const rate = MODEL_PRICING[modelName] || { input: 0, output: 0 };
                    const turnCost = ((turnInput * rate.input) + (turnOutput * rate.output)) / 1_000_000;
                    guiServer.addAgentMessage(result.text, {
                        tokens: { input: turnInput, output: turnOutput },
                        cost: turnCost,
                    });
                }
            }
            break; // Success!
        } else {
            const failMsg = `⚠️ Iteration ${attempts} failed checks. Let's fix it...`;
            console.log(chalk.yellow(`\n${failMsg}\n`));
            feedback = check.errorOutput || "Unknown compilation error";
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

    const { errors } = executor.applyApprovedFromTracker();

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

        // ── Regular Task Execution ──
        if (guiServer) {
            guiServer.updateState((s) => {
                s.goal = userInput;
                s.status = "running";
                s.logs.push(`\n── New Task: ${userInput.slice(0, 80)}${userInput.length > 80 ? "..." : ""} ──`);
            });
        }

        const { promptTokens, completionTokens } = await executeSingleTask(
            userInput, config, tracker, executor, guiServer, options
        );

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