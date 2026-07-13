import chalk from "chalk";
import { select, isCancel } from "@clack/prompts"
import { runAgentMode } from "./agents/orchestrator";
import { runAskMode } from "./ask/orchestrator";
import { runPlanMode } from "./plan/orchestrator";
import { runRewindMenu } from "./agents/rewind";

/**
 * CLI Mode Router — Select Once, Then Enter the Mode's Own Chat Loop
 * 
 * Previously this function contained a `while(true)` loop that re-prompted
 * "Choose CLI sub-mode" after every single task completion. This was jarring
 * and made the user feel like they were starting over every time.
 * 
 * Now mode selection happens ONCE. Each mode (agent, ask, plan) has its own
 * internal `while(true)` chat loop that keeps the user engaged until they
 * type `/exit`. When the mode function returns, we return here, and the
 * caller (runWakeup) can re-show the main menu if desired.
 */
export async function runCliMode(options?: { gui?: boolean; budget?: number }) {
    const mode = await select({
        message: "Choose CLI sub-mode",
        options: [
            { value: "agent", label: "Agent mode (continuous chat with code changes)" },
            { value: "plan", label: "Plan mode (goal → steps → execute)" },
            { value: "ask", label: "Ask mode (read-only Q&A)" },
            { value: "rewind", label: "Rewind to a checkpoint" },
            { value: "back", label: "<- Back to main menu" },
        ],
    });

    if (isCancel(mode) || mode === "back") return;

    if (mode === "agent") {
        await runAgentMode(options);
    }
    if (mode === "ask") {
        await runAskMode();
    }
    if (mode === "plan") {
        await runPlanMode();
    }
    if (mode === "rewind") {
        await runRewindMenu();
    }
    if (mode !== "agent" && mode !== "plan" && mode !== "ask" && mode !== "rewind") {
        console.log(chalk.yellow("\nThat mode is not implemented yet.\n"));
    }
}