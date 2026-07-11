import { execSync } from "node:child_process";

export class GitHelper {
    static isGitRepo(): boolean {
        try {
            execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
            return true;
        } catch {
            return false;
        }
    }

    static hasUncommittedChanges(): boolean {
        try {
            const out = execSync("git status --porcelain", { encoding: "utf8" });
            return out.trim().length > 0;
        } catch {
            return false;
        }
    }

    static commitApprovedChanges(message: string): void {
        try {
            execSync("git add -A");
            execSync(`git commit -m "abhiclaw: ${message}"`);
        } catch (e) {
            console.error("Git commit failed:", e);
        }
    }

    static rollback(): void {
        try {
            execSync("git reset --hard HEAD");
            console.log("Successfully rolled back all local changes.");
        } catch (e) {
            console.error("Git rollback failed:", e);
        }
    }
}