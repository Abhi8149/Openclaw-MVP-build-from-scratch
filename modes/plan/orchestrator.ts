import chalk from "chalk";
import { confirm, isCancel, text } from "@clack/prompts";
import { ToolLoopAgent, stepCountIs } from "ai";
import { getAgentModel } from "../../ai/ai.config.ts";
import { ActionTracker } from "../agents/action-tracker.ts";
import { ToolExecutor } from "../agents/tool-executor.ts";
import { createAgentTool } from "../agents/agent-tools";
import { defaultAgentConfig } from "../agents/types";
import { runApprovalFlow } from "../agents/approval.ts";
import { renderTerminalMarkdown } from "../../tui/terminal-md.ts";
import { generatePlan } from "./planner.ts";
import type { Planstep } from "./types.ts";
import { createWebTools } from "./web-tool";
import { GitHelper } from "../../utils/git";
import { printPlan, selectSteps } from "./selection.ts";

function stepPrompt(goal: string, step: Planstep): string {
    return [`Goal: ${goal}`, `Step: ${step.title}`, step.description].join('\n');
}

/**
 * Plan Mode — Continuous Planning Loop with Accumulated Staging
 * 
 * Previously this function handled a single plan-and-execute cycle and returned.
 * Now it enters a while(true) loop where the user can define multiple goals,
 * each generating and executing plans. Staged changes accumulate across all
 * plan executions until the user types /apply.
 * 
 * Commands:
 * - /apply  → triggers bulk approval for ALL accumulated staged changes
 * - /exit   → leaves Plan mode (warns about pending changes)
 */
export async function runPlanMode(): Promise<void> {
    console.log(chalk.bold("\n🧭 Plan Mode — Continuous Planning\n"));
    console.log(chalk.dim("  Commands: /apply (commit staged changes) | /exit (leave)\n"));

    /**
     * Shared Tracker & Executor — Persist Across All Plan Executions
     * 
     * Changes from Plan 1 + Plan 2 accumulate in the same tracker.
     * The user applies them all at once with /apply.
     */
    const config = defaultAgentConfig();
    const tracker = new ActionTracker();
    const executor = new ToolExecutor(tracker, config);

    let isFirstPrompt = true;

    while (true) {
        // Get the user's goal
        const goalInput = await text({
            message: isFirstPrompt ? "What is your goal?" : "💬 Next goal?",
            placeholder: isFirstPrompt ? undefined : " Next planning goal, /apply, or /exit...",
        });

        if (isCancel(goalInput) || !goalInput) break;

        const goal = goalInput.trim();
        if (!goal) continue;

        // Slash command: /apply — bulk approval for all accumulated changes
        if (goal.toLowerCase() === "/apply") {
            const pendingCount = tracker.getPendingMutations().length;
            if (pendingCount === 0) {
                console.log(chalk.dim("\nNo staged changes to apply.\n"));
                continue;
            }
            console.log(chalk.cyan(`\n📦 Applying ${pendingCount} accumulated staged change(s)...\n`));
            
            const ok = await runApprovalFlow(tracker);
            if (!ok) {
                executor.clearStaging();
                continue;
            }
            const { errors } = executor.applyApprovedFromTracker();
            if (errors.length) {
                console.log(chalk.red('\nSome operations reported errors:\n'));
                for (const e of errors) console.log(chalk.red(`  • ${e}`));
            } else {
                console.log(chalk.green('\n✓ All staged changes applied successfully.\n'));
                if (GitHelper.isGitRepo()) {
                    GitHelper.commitApprovedChanges("Applied accumulated plan changes");
                    console.log(chalk.dim("Staged files auto-committed to git history."));
                }
            }
            executor.clearStaging();
            continue;
        }

        // Slash command: /exit — leave plan mode
        if (goal.toLowerCase() === "/exit") {
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

        isFirstPrompt = false;

        // Generate and execute the plan
        const plan = await generatePlan(goal);
        printPlan(plan);

        const selected = await selectSteps(plan);
        if (selected.length === 0) continue;

        const proceed = await confirm({
            message: `Execute ${selected.length} step(s)`,
            initialValue: true,
        });

        if (isCancel(proceed) || !proceed) continue;

        const tools = {
            ...createAgentTool(executor),
            ...createWebTools(tracker)
        };

        for (const step of selected) {
            console.log(chalk.bold(`\n🔧 ${step.title}\n`));

            const agent = new ToolLoopAgent({
                model: getAgentModel(),
                stopWhen: stepCountIs(30),
                tools
            });

            const r = await agent.generate({ prompt: stepPrompt(plan.goal, step) });
            if (r.text) console.log(renderTerminalMarkdown(r.text));
        }

        // Show non-blocking summary of accumulated changes
        const pendingCount = tracker.getPendingMutations().length;
        if (pendingCount > 0) {
            console.log(chalk.cyan(`\n📦 ${pendingCount} staged change(s) accumulated. Type ${chalk.bold("/apply")} to commit them.\n`));
        }
    }

    console.log(chalk.dim("\n👋 Left Plan Mode.\n"));
}