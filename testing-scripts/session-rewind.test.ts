import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { GitHelper } from "../utils/git";

function makeRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rewind-test-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: dir });
    return dir;
}

function writeFile(dir: string, content: string) {
    fs.writeFileSync(path.join(dir, "sample.txt"), content, "utf8");
}

function readFile(dir: string): string {
    return fs.readFileSync(path.join(dir, "sample.txt"), "utf8");
}

describe("GitHelper checkpoints", () => {
    test("listCheckpoints only returns commits made through commitApprovedChanges, newest first", () => {
        const dir = makeRepo();
        try {
            writeFile(dir, "v1");
            GitHelper.commitApprovedChanges("first goal", dir);

            writeFile(dir, "v2");
            GitHelper.commitApprovedChanges("second goal", dir);

            // A commit made outside this tool (e.g. the user editing by hand)
            // must never show up as a checkpoint.
            writeFile(dir, "v3 manual edit");
            execFileSync("git", ["add", "-A"], { cwd: dir });
            execFileSync("git", ["commit", "-m", "manual: not a checkpoint"], { cwd: dir });

            const checkpoints = GitHelper.listCheckpoints(20, dir);
            expect(checkpoints.length).toBe(2);
            expect(checkpoints[0]!.goal).toBe("second goal");
            expect(checkpoints[1]!.goal).toBe("first goal");
            expect(checkpoints[0]!.hash).not.toBe(checkpoints[1]!.hash);
            expect(checkpoints[0]!.shortHash.length).toBeGreaterThan(0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test("commitApprovedChanges stores shell metacharacters in the message literally, without executing them", () => {
        const dir = makeRepo();
        try {
            writeFile(dir, "content");
            const dangerousGoal = 'do "the thing" and $(echo pwned) and `echo also-pwned`; rm -rf .';
            GitHelper.commitApprovedChanges(dangerousGoal, dir);

            // If this had been shell-interpolated, "sample.txt" would be gone
            // (from `rm -rf .`) or the repo would contain injected output.
            expect(fs.existsSync(path.join(dir, "sample.txt"))).toBe(true);

            const checkpoints = GitHelper.listCheckpoints(20, dir);
            expect(checkpoints.length).toBe(1);
            expect(checkpoints[0]!.goal).toBe(dangerousGoal);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test("rewindToCheckpoint restores the working tree to that checkpoint's content", () => {
        const dir = makeRepo();
        try {
            writeFile(dir, "v1");
            GitHelper.commitApprovedChanges("first goal", dir);
            const [firstCheckpoint] = GitHelper.listCheckpoints(20, dir);

            writeFile(dir, "v2");
            GitHelper.commitApprovedChanges("second goal", dir);

            expect(readFile(dir)).toBe("v2");

            const result = GitHelper.rewindToCheckpoint(firstCheckpoint!.hash, dir);
            expect(result.success).toBe(true);
            expect(readFile(dir)).toBe("v1");

            // The rewind itself must not leave a dangling second checkpoint
            // still reachable from HEAD.
            const checkpointsAfter = GitHelper.listCheckpoints(20, dir);
            expect(checkpointsAfter.length).toBe(1);
            expect(checkpointsAfter[0]!.goal).toBe("first goal");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test("rewindToCheckpoint rejects a hash that doesn't look like a real commit hash", () => {
        const dir = makeRepo();
        try {
            writeFile(dir, "v1");
            GitHelper.commitApprovedChanges("first goal", dir);

            const result = GitHelper.rewindToCheckpoint("; rm -rf .", dir);
            expect(result.success).toBe(false);
            expect(result.error).toMatch(/invalid commit hash/i);

            // Nothing should have been touched.
            expect(readFile(dir)).toBe("v1");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test("rewindToCheckpoint reports a clean failure for a well-formed but non-existent hash", () => {
        const dir = makeRepo();
        try {
            writeFile(dir, "v1");
            GitHelper.commitApprovedChanges("first goal", dir);

            const result = GitHelper.rewindToCheckpoint("deadbeef", dir);
            expect(result.success).toBe(false);
            expect(result.error).toMatch(/not found/i);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test("listCheckpoints returns an empty array for a repo with no commits yet", () => {
        const dir = makeRepo();
        try {
            expect(GitHelper.listCheckpoints(20, dir)).toEqual([]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test("resolveParentHash returns the previous commit's hash", () => {
        const dir = makeRepo();
        try {
            writeFile(dir, "v1");
            GitHelper.commitApprovedChanges("first goal", dir);
            const [first] = GitHelper.listCheckpoints(20, dir);

            writeFile(dir, "v2");
            GitHelper.commitApprovedChanges("second goal", dir);
            const [second] = GitHelper.listCheckpoints(20, dir);

            const parentOfSecond = GitHelper.resolveParentHash(second!.hash, dir);
            expect(parentOfSecond).toBe(first!.hash);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test("resolveParentHash returns null for the very first commit in the repo", () => {
        const dir = makeRepo();
        try {
            writeFile(dir, "v1");
            GitHelper.commitApprovedChanges("first goal", dir);
            const [first] = GitHelper.listCheckpoints(20, dir);

            expect(GitHelper.resolveParentHash(first!.hash, dir)).toBeNull();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test("resolveParentHash returns null for an invalid hash instead of throwing", () => {
        const dir = makeRepo();
        try {
            writeFile(dir, "v1");
            GitHelper.commitApprovedChanges("first goal", dir);

            expect(GitHelper.resolveParentHash("; rm -rf .", dir)).toBeNull();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test("undoing a checkpoint (reset to its parent) removes what that turn added — reproduces the reported bug", () => {
        // Mirrors the real scenario: turn 1 does nothing to this file, turn 2
        // creates a new file (like "Fullfledgereadme.md"). Picking turn 2 to
        // undo must make that file disappear again, not leave it in place.
        const dir = makeRepo();
        try {
            writeFile(dir, "unrelated content");
            GitHelper.commitApprovedChanges("unrelated turn", dir);

            fs.writeFileSync(path.join(dir, "Fullfledgereadme.md"), "# readme\n", "utf8");
            GitHelper.commitApprovedChanges(
                "I want a readme file named Fullfledgereadme.md",
                dir,
            );

            expect(fs.existsSync(path.join(dir, "Fullfledgereadme.md"))).toBe(true);

            const [readmeCheckpoint] = GitHelper.listCheckpoints(20, dir);
            expect(readmeCheckpoint!.goal).toBe("I want a readme file named Fullfledgereadme.md");

            const parentHash = GitHelper.resolveParentHash(readmeCheckpoint!.hash, dir);
            expect(parentHash).not.toBeNull();

            const result = GitHelper.rewindToCheckpoint(parentHash!, dir);
            expect(result.success).toBe(true);

            expect(fs.existsSync(path.join(dir, "Fullfledgereadme.md"))).toBe(false);

            const checkpointsAfter = GitHelper.listCheckpoints(20, dir);
            expect(checkpointsAfter.length).toBe(1);
            expect(checkpointsAfter[0]!.goal).toBe("unrelated turn");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 20000);
});
