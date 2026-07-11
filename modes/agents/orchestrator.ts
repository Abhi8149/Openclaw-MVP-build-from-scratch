import { isCancel, text } from "@clack/prompts";
import chalk from "chalk";
import { defaultAgentConfig } from "./types";
import { ActionTracker } from "./action-tracker";
import { ToolExecutor } from "./tool-executor";
import { createAgentTool } from "./agent-tools";
import { stepCountIs, ToolLoopAgent } from "ai";
import { getAgentModel, MODEL_PRICING } from "../../ai";
import { renderTerminalMarkdown } from "../../tui/terminal-md";
import { runApprovalFlow } from "./approval";
import { exec } from "node:child_process";
import { GitHelper } from "../../utils/git";
import { runProjectChecks } from "../../utils/checker";


export async function runAgentMode() {
    console.log(chalk.bold("\n Agent Mode\n"));

    const goal = await text({
        message: "What would you like the agent to do?",
        placeholder: " Concrete task for this codebase...",
    });

    if (isCancel(goal) || !goal.trim()) return;

    const config = defaultAgentConfig();
    const tracker = new ActionTracker();
    const executor = new ToolExecutor(tracker, config);
    const tools = createAgentTool(executor);

    const agent = new ToolLoopAgent({
        model: getAgentModel(),
        stopWhen: stepCountIs(40),
        instructions: [
            `Workspace root: ${config.codebasePath}`,
            "All mutations are staged until approval",
        ].join("\n"),
        tools,
    });

    let attempts = 0;
    const maxAttempts = 3;
    let feedback = "";
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    while (attempts < maxAttempts) {
        attempts++;
        const prompt = feedback
            ? `Your previous changes caused errors. Please fix these issues:\n${feedback}\n\nOriginal Goal: ${goal}`
            : goal.trim();

        const result = await agent.generate({
            prompt,
            onStepFinish: ({ toolCalls }) => {
                for (const tc of toolCalls) {
                    const preview = JSON.stringify(tc.input).slice(0, 160);
                    console.log(
                        chalk.green("  ✓"),
                        chalk.bold(String(tc.toolName)),
                        chalk.dim(preview + (preview.length >= 160 ? "..." : "")),
                    )
                }
            }
        });

        if (result.usage) {
            totalPromptTokens += result.usage.inputTokens ?? 0;
            totalCompletionTokens += result.usage.outputTokens ?? 0;
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
            if (result.text?.trim()) console.log(renderTerminalMarkdown(result.text));
            break; // Success!
        } else {
            console.log(chalk.yellow(`\n⚠️ Iteration ${attempts} failed checks. Let's fix it...\n`));
            feedback = check.errorOutput || "Unknown compilation error";
        }
    }

    // Display session cost and token analytics
    if (totalPromptTokens > 0 || totalCompletionTokens > 0) {
        const modelName = process.env.OPENROUTER_MODEL || "free";
        const rate = MODEL_PRICING[modelName] || { input: 0, output: 0 };
        const cost = ((totalPromptTokens * rate.input) + (totalCompletionTokens * rate.output)) / 1_000_000;

        console.log(chalk.dim(`\n📊 [Session Statistics]`));
        console.log(chalk.dim(`   Tokens: ${totalPromptTokens} input | ${totalCompletionTokens} output`));
        console.log(chalk.dim(`   Estimated Cost: $${cost.toFixed(6)}`));
    }

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

    executor.clearStaging()
}