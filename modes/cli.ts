import chalk from "chalk";
import { select, isCancel } from "@clack/prompts"

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
            console.log("Agent is now running");
        }
        if (mode === "ask") {
            console.log("Asking mode starting")
        }
        if (mode === "plan") {
            console.log("Planning mode starting")
        }
        if (mode !== "agent"&& mode !== "plan" && mode !== "ask") {
            console.log(chalk.yellow("\nThat mode is not implemented yet.\n"));
        }
    }
}