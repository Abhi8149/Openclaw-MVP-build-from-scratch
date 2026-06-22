import chalk from "chalk";
import { select, isCancel } from "@clack/prompts"
import { runAgentMode } from "./agents/orchestrator";
import { runAskMode } from "./ask/orchestrator";

export async function runCliMode() {
    while (true) {
        const mode = await select({
            message: "Choose CLI sub-mode",
            options: [
                { value: "agent", label: "Agent mode" },
                { value: "plan", label: "Planmode" },
                { value: "ask", label: "Ask mode" },
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
            console.log("Planning mode starting")
        }
        if (mode !== "agent"&& mode !== "plan" && mode !== "ask") {
            console.log(chalk.yellow("\nThat mode is not implemented yet.\n"));
        }
    }
}