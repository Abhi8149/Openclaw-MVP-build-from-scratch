import { execSync, execFileSync } from "node:child_process";

export interface Checkpoint {
    hash: string;
    shortHash: string;
    goal: string;
    timestamp: Date;
}

// Every checkpoint commit is created by commitApprovedChanges() with this
// prefix, so listCheckpoints() can tell "a turn the agent completed" apart
// from any other commit that happens to exist in the repo's history.
const CHECKPOINT_PREFIX = "abhiclaw: ";

// Commit hashes we act on always come from our own `git log` output, but we
// validate the shape anyway before ever passing one to a reset — belt and
// braces against a malformed or tampered value reaching the filesystem.
const HASH_RE = /^[0-9a-f]{4,40}$/i;

export class GitHelper {
    static isGitRepo(cwd?: string): boolean {
        try {
            execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore", cwd });
            return true;
        } catch {
            return false;
        }
    }

    static hasUncommittedChanges(cwd?: string): boolean {
        try {
            const out = execSync("git status --porcelain", { encoding: "utf8", cwd });
            return out.trim().length > 0;
        } catch {
            return false;
        }
    }

    static commitApprovedChanges(message: string, cwd?: string): void {
        try {
            execFileSync("git", ["add", "-A"], { cwd });
            // execFileSync passes the message as a single argv entry with no
            // shell involved, so quotes/`$()`/`;` in a free-text goal can't
            // break out of the commit message into another command.
            execFileSync("git", ["commit", "-m", `${CHECKPOINT_PREFIX}${message}`], { cwd });
        } catch (e) {
            console.error("Git commit failed:", e);
        }
    }

    static rollback(cwd?: string): void {
        try {
            execSync("git reset --hard HEAD", { cwd });
            console.log("Successfully rolled back all local changes.");
        } catch (e) {
            console.error("Git rollback failed:", e);
        }
    }

    // Lists commits created by commitApprovedChanges (i.e. every point the
    // agent's staged changes were approved and applied), newest first.
    static listCheckpoints(limit = 20, cwd?: string): Checkpoint[] {
        try {
            // A brand-new repo with zero commits is a normal state, not a
            // failure — `git log` errors out on it, so check for it up
            // front instead of logging a scary git error for something the
            // caller should just see as "no checkpoints yet".
            execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd, stdio: "ignore" });
        } catch {
            return [];
        }
        try {
            const out = execFileSync(
                "git",
                [
                    "log",
                    "--grep=" + CHECKPOINT_PREFIX,
                    "-n",
                    String(Math.max(1, limit)),
                    "--pretty=format:%H%x1f%h%x1f%ct%x1f%s",
                ],
                { cwd, encoding: "utf8" },
            ).replace(/\r\n/g, "\n");
            if (!out.trim()) return [];

            const checkpoints: Checkpoint[] = [];
            for (const line of out.split("\n")) {
                const [hash, shortHash, ctSeconds, subject] = line.split("\x1f");
                if (!hash || !shortHash || !ctSeconds || subject === undefined) continue;
                if (!subject.startsWith(CHECKPOINT_PREFIX)) continue;
                checkpoints.push({
                    hash,
                    shortHash,
                    goal: subject.slice(CHECKPOINT_PREFIX.length),
                    timestamp: new Date(Number(ctSeconds) * 1000),
                });
            }
            return checkpoints;
        } catch (e) {
            console.error("Failed to list checkpoints:", e);
            return [];
        }
    }

    // Resolves the parent of a commit, e.g. so "undo checkpoint X" can reset
    // to the state right *before* X's changes instead of X's own state.
    // Returns null if the hash is a root commit with no parent (nothing to
    // undo to).
    static resolveParentHash(hash: string, cwd?: string): string | null {
        if (!HASH_RE.test(hash)) return null;
        try {
            return execFileSync("git", ["rev-parse", "--verify", "--quiet", `${hash}^`], {
                cwd,
                encoding: "utf8",
            }).trim();
        } catch {
            return null;
        }
    }

    // Hard-resets the branch pointer and working tree to a specific
    // commit. Destructive: any commits made after it, and any currently
    // uncommitted changes, are removed from the working tree immediately
    // (still recoverable via `git reflog` for git's default gc window, but
    // not from within this tool).
    static rewindToCheckpoint(hash: string, cwd?: string): { success: boolean; error?: string } {
        if (!HASH_RE.test(hash)) {
            return { success: false, error: `Refusing to reset to an invalid commit hash: ${hash}` };
        }
        try {
            execFileSync("git", ["cat-file", "-e", hash], { cwd, stdio: "ignore" });
        } catch {
            return { success: false, error: `Commit not found: ${hash}` };
        }
        try {
            execFileSync("git", ["reset", "--hard", hash], { cwd, stdio: "ignore" });
            return { success: true };
        } catch (e) {
            return { success: false, error: String(e) };
        }
    }
}
