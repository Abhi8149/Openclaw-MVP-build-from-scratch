import { select, isCancel, text } from "@clack/prompts";
import chalk from "chalk";
import { GitHelper } from "../../utils/git";

const MAX_LISTED = 20;
const GOAL_PREVIEW_LEN = 70;

export async function runRewindMenu(): Promise<void> {
    console.log(chalk.bold("\n Rewind to a checkpoint\n"));

    if (!GitHelper.isGitRepo()) {
        console.log(
            chalk.yellow(
                "This folder isn't a git repository, so there's no checkpoint history to rewind to.\n",
            ),
        );
        return;
    }

    const checkpoints = GitHelper.listCheckpoints(MAX_LISTED);
    if (checkpoints.length === 0) {
        console.log(
            chalk.dim(
                "No checkpoints found yet. A checkpoint is created automatically every time the agent's changes are approved and applied.\n",
            ),
        );
        return;
    }

    const choice = await select({
        message: "Pick a turn to undo (this also undoes every turn after it)",
        options: [
            ...checkpoints.map((c) => ({
                value: c.hash,
                label:
                    c.goal.length > GOAL_PREVIEW_LEN
                        ? c.goal.slice(0, GOAL_PREVIEW_LEN - 3) + "..."
                        : c.goal,
                hint: `${c.shortHash} · ${c.timestamp.toLocaleString()}`,
            })),
            { value: "cancel", label: "<- Cancel" },
        ],
    });

    if (isCancel(choice) || choice === "cancel") return;

    const target = checkpoints.find((c) => c.hash === choice);
    if (!target) return;

    // "Undo this turn" means resetting to its parent commit, not the
    // checkpoint itself — the checkpoint commit's tree already contains
    // that turn's own changes, so resetting to it would leave them in place.
    const parentHash = GitHelper.resolveParentHash(target.hash);
    if (parentHash === null) {
        console.log(
            chalk.red(
                "\nThis is the very first checkpoint in this repo's history — there's nothing before it to rewind to.\n",
            ),
        );
        return;
    }

    const hasUncommitted = GitHelper.hasUncommittedChanges();

    console.log(chalk.yellow(`\n⚠ This will undo "${target.goal}" and every turn after it.`));
    console.log(
        chalk.yellow(
            "  Those commits will be removed from the branch history (recoverable via `git reflog`",
        ),
    );
    console.log(chalk.yellow("  for a while, but not from this tool)."));
    if (hasUncommitted) {
        console.log(
            chalk.red("  You also have uncommitted changes right now — those will be discarded too."),
        );
    }

    const typed = await text({
        message: 'Type "yes" to confirm this rewind — anything else cancels it:',
    });

    if (isCancel(typed) || typed.trim().toLowerCase() !== "yes") {
        console.log(chalk.dim("\nRewind cancelled.\n"));
        return;
    }

    const result = GitHelper.rewindToCheckpoint(parentHash);
    if (result.success) {
        console.log(chalk.green(`\n✓ Undid "${target.goal}" and everything after it.\n`));
    } else {
        console.log(chalk.red(`\nRewind failed: ${result.error}\n`));
    }
}
