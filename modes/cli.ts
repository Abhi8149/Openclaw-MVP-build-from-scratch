import chalk from "chalk";
import { select, isCancel } from "@clack/prompts"
import { runAgentMode } from "./agents/orchestrator";
import { runAskMode } from "./ask/orchestrator";
import { runPlanMode } from "./plan/orchestrator";
import { runRewindMenu } from "./agents/rewind";

export async function runCliMode() {
    while (true) {
        const mode = await select({
            message: "Choose CLI sub-mode",
            options: [
                { value: "agent", label: "Agent mode" },
                { value: "plan", label: "Planmode" },
                { value: "ask", label: "Ask mode" },
                { value: "rewind", label: "Rewind to a checkpoint" },
                { value: "back", label: "<- Back to main menu" },
            ],
        });

        if (isCancel(mode) || mode === "back") return;

        if (mode === "agent") {
            await runAgentMode();
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
}