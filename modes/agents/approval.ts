import { isCancel, select, text } from "@clack/prompts";
import chalk from "chalk";
import type { ActionTracker } from "./action-tracker";
import type { ActionLog, RiskTier } from "./types";
import { RISK_RANK } from "./risk-classifier";
import { composeBeforeAfter, formatPatch } from "./diff-view";
import { renderTerminalMarkdown } from "../../tui/terminal-md";

interface ReviewGroup {
    label: string;
    actionIds: string[];
    patch: string | null;
    tier: RiskTier;
    reason: string;
    requiresTypedConfirmation: boolean;
}

// A group can bundle several actions on the same path (e.g. a create
// followed by an edit). Its risk is the highest tier among them, and it
// requires typed confirmation if any single action in it does.
function pickGroupRisk(sorted: ActionLog[]): {
    tier: RiskTier;
    reason: string;
    requiresTypedConfirmation: boolean;
} {
    let best: ActionLog | undefined;
    for (const a of sorted) {
        const tier = a.riskTier ?? "high";
        const bestTier = best?.riskTier ?? "high";
        if (!best || RISK_RANK[tier] > RISK_RANK[bestTier]) best = a;
    }
    return {
        tier: best?.riskTier ?? "high",
        reason: best?.riskReason ?? "Unclassified action — defaulting to high risk",
        requiresTypedConfirmation: sorted.some((a) => a.requiresTypedConfirmation === true),
    };
}

function riskBadge(tier: RiskTier): string {
    if (tier === "high") return chalk.bgRed.white.bold(" HIGH RISK ");
    if (tier === "low") return chalk.bgGreen.black.bold(" low risk ");
    return chalk.bgBlue.white.bold(" safe ");
}

function groupPending(pending: ActionLog[]): ReviewGroup[] {
    const byPath = new Map<string, ActionLog[]>();
    const shells: ActionLog[] = [];

    for (const a of pending) {
        if (a.type === 'tool_execute') {
            shells.push(a);
            continue;
        }
        const key = a.path;
        if (!byPath.has(key)) byPath.set(key, []);
        byPath.get(key)!.push(a);
    }

    const groups: ReviewGroup[] = [];

    // arranges all the files in alphabetical order
    //[['style.css, [Action1, Action 2]], ['index.html],[Action1, Action2]]
    //compares array based upon its path and alphabetically orgnaizes it
    const pathEntries = [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b));

    for (const [p, acts] of pathEntries) {
        const sorted = acts.sort(
            (x, y) => x.timestamp.getTime() - y.timestamp.getTime(),
        );

        const ids = sorted.map((x) => x.id);
        const risk = pickGroupRisk(sorted);

        if (sorted.every((x) => x.type === "folder_create")) {
            groups.push({
                label: `Create folder: ${p}`,
                actionIds: ids,
                patch: null,
                ...risk,
            });
            continue;
        }

        const { before, after } = composeBeforeAfter(sorted);
        const patch = formatPatch(p, before, after);
        const kinds = [... new Set(sorted.map((x) => x.type))].join(", ");
        groups.push({
            label: ` ${p} (${kinds})`, actionIds: ids, patch,
            ...risk,
        })
    }

    for (const s of shells) {
        const risk = pickGroupRisk([s]);
        groups.push({
            label: `Shell ${s.details.command ?? "(no command"}`,
            actionIds: [s.id],
            patch: null,
            ...risk,
        });
    }


    return groups;
}

// Walks a single group through Accept / Show diff / Reject. High-risk groups
// that matched a known-dangerous pattern additionally require the user to
// type "yes" before an Accept is honored, so a single mis-click on a menu
// can't approve something like `rm -rf` or `git push --force`.
async function reviewGroupInteractively(
    g: ReviewGroup,
    tracker: ActionTracker,
    allPending: ActionLog[],
): Promise<"done" | "cancelled"> {
    while (true) {
        console.log(`\n${riskBadge(g.tier)} ${chalk.bold(g.label)}`);
        console.log(chalk.dim(`  ${g.reason}`));

        const opt = await select({
            message: "Choose an action",
            options: [
                { value: "accept", label: "Accept" },
                { value: "diff", label: "Show diff", hint: g.patch ? "" : "N/A" },
                { value: "reject", label: "Reject" },
            ],
        });

        if (isCancel(opt)) {
            for (const a of allPending) tracker.updateStatus(a.id, "rejected", false);
            return "cancelled";
        }

        if (opt === "diff") {
            if (g.patch) {
                console.log(
                    "\n" +
                    renderTerminalMarkdown("```diff\n" + g.patch + "\n```\n") +
                    "\n",
                );
            }
            continue;
        }

        if (opt === "accept" && g.requiresTypedConfirmation) {
            const typed = await text({
                message: `This matched a known-dangerous pattern. Type "yes" to confirm — anything else leaves it pending:`,
            });
            if (isCancel(typed) || typed.trim().toLowerCase() !== "yes") {
                console.log(chalk.yellow("  Not confirmed — choose again."));
                continue;
            }
        }

        for (const id of g.actionIds) {
            tracker.updateStatus(
                id,
                opt === "accept" ? "approved" : "rejected",
                opt === "accept",
            )
        }

        return "done";
    }
}

export async function runApprovalFlow(
    tracker: ActionTracker,
): Promise<boolean> {
    const pending = tracker.getPendingMutations();

    if (pending.length === 0) {
        console.log(
            chalk.dim("\nNo staged file, folder, or shell changes to review.\n"),
        );
        return false;
    }

    const groups = groupPending(pending);
    const lowCount = groups.filter((g) => g.tier !== "high").length;
    const highCount = groups.length - lowCount;

    const choice = await select({
        message: "Apply staged changes?",
        options: [
            { value: "all", label: "Approve and apply all" },
            {
                value: "smart",
                label: "Auto-approve low-risk, review high-risk individually",
                hint: `${lowCount} low-risk, ${highCount} high-risk`,
            },
            { value: "select", label: "Review one by one" },
            { value: "cancel", label: "Cancel" },
        ],
    });

    if (isCancel(choice) || choice === 'cancel') {
        for (const a of pending) tracker.updateStatus(a.id, "rejected", false);

        return false;
    }

    if (choice === "all") {
        for (const a of pending) tracker.updateStatus(a.id, "approved", true);

        return true;
    }

    if (choice === "smart") {
        for (const g of groups) {
            if (g.tier !== "high") {
                for (const id of g.actionIds) tracker.updateStatus(id, "approved", true);
                console.log(chalk.dim(`  ${riskBadge(g.tier)} auto-approved: ${g.label}`));
                continue;
            }
            const outcome = await reviewGroupInteractively(g, tracker, pending);
            if (outcome === "cancelled") return false;
        }

        return tracker.getActions().some((a) => a.status === "approved");
    }

    for (const g of groups) {
        const outcome = await reviewGroupInteractively(g, tracker, pending);
        if (outcome === "cancelled") return false;
    }

    return tracker.getActions().some((a)=>a.status==="approved");
}
