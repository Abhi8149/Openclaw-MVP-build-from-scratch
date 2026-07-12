import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
    classifyFileMutation,
    classifyShellCommand,
    maxRiskTier,
} from "../modes/agents/risk-classifier";
import { ToolExecutor } from "../modes/agents/tool-executor";
import { ActionTracker } from "../modes/agents/action-tracker";
import { defaultAgentConfig } from "../modes/agents/types";

function makeExecutor(files: Record<string, string> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "risk-tier-"));
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, "utf8");
    }
    const config = defaultAgentConfig();
    config.codebasePath = dir;
    const tracker = new ActionTracker();
    const executor = new ToolExecutor(tracker, config);
    return { dir, executor, tracker };
}

describe("classifyShellCommand", () => {
    test("read-only commands are low risk", () => {
        expect(classifyShellCommand("git status").tier).toBe("low");
        expect(classifyShellCommand("ls -la").tier).toBe("low");
        expect(classifyShellCommand("bun test").tier).toBe("low");
    });

    test("unrecognized commands default to high risk without typed confirmation", () => {
        const result = classifyShellCommand("bun run some-custom-script.ts");
        expect(result.tier).toBe("high");
        expect(result.requiresTypedConfirmation).toBe(false);
    });

    test("known-destructive commands are high risk and require typed confirmation", () => {
        const rm = classifyShellCommand("rm -rf node_modules");
        expect(rm.tier).toBe("high");
        expect(rm.requiresTypedConfirmation).toBe(true);

        const forcePush = classifyShellCommand("git push origin main --force");
        expect(forcePush.tier).toBe("high");
        expect(forcePush.requiresTypedConfirmation).toBe(true);
    });

    test("a dangerous command cannot hide behind a safe one in a chain", () => {
        const result = classifyShellCommand("git status && rm -rf dist");
        expect(result.tier).toBe("high");
        expect(result.requiresTypedConfirmation).toBe(true);
    });
});

describe("classifyFileMutation", () => {
    test("deleting a file is always high risk", () => {
        const result = classifyFileMutation("file_delete", "src/foo.ts", "content", undefined);
        expect(result.tier).toBe("high");
    });

    test("creating a new file is low risk", () => {
        const result = classifyFileMutation("file_create", "src/foo.ts", undefined, "content");
        expect(result.tier).toBe("low");
    });

    test("creating an empty folder is low risk", () => {
        const result = classifyFileMutation("folder_create", "src/newdir", undefined, undefined);
        expect(result.tier).toBe("low");
    });

    test("a tiny edit to a sensitive file (package.json) is still high risk", () => {
        const before = '{ "name": "app", "version": "1.0.0" }';
        const after = '{ "name": "app", "version": "1.0.1" }';
        const result = classifyFileMutation("file_modify", "package.json", before, after);
        expect(result.tier).toBe("high");
    });

    test("a small edit to a normal file is low risk", () => {
        const before = "const x = 1;\nconst y = 2;\n";
        const after = "const x = 10;\nconst y = 2;\n";
        const result = classifyFileMutation("file_modify", "src/foo.ts", before, after);
        expect(result.tier).toBe("low");
    });

    test("a large edit to a normal file is high risk", () => {
        const before = Array.from({ length: 5 }, (_, i) => `line ${i}`).join("\n");
        const after = Array.from({ length: 60 }, (_, i) => `new line ${i}`).join("\n");
        const result = classifyFileMutation("file_modify", "src/foo.ts", before, after);
        expect(result.tier).toBe("high");
    });
});

describe("maxRiskTier", () => {
    test("picks the highest tier among a mixed set", () => {
        expect(maxRiskTier(["safe", "low", "high", "low"])).toBe("high");
        expect(maxRiskTier(["safe", "low"])).toBe("low");
        expect(maxRiskTier([])).toBe("safe");
    });
});

describe("ToolExecutor tags staged actions with a risk tier", () => {
    test("create_file staging is tagged low risk", () => {
        const { dir, executor, tracker } = makeExecutor();
        try {
            executor.createFile("new.ts", "export const x = 1;\n");
            const action = tracker.getActions().find((a) => a.type === "file_create")!;
            expect(action.riskTier).toBe("low");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test("delete_file staging is tagged high risk", () => {
        const { dir, executor, tracker } = makeExecutor({ "old.ts": "export const x = 1;\n" });
        try {
            executor.deleteFile("old.ts");
            const action = tracker.getActions().find((a) => a.type === "file_delete")!;
            expect(action.riskTier).toBe("high");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test("queue_shell staging with a destructive command is tagged high risk and needs typed confirmation", () => {
        const { dir, executor, tracker } = makeExecutor();
        try {
            executor.queueShell("rm -rf build");
            const action = tracker.getActions().find((a) => a.type === "tool_execute")!;
            expect(action.riskTier).toBe("high");
            expect(action.requiresTypedConfirmation).toBe(true);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test("edit_file staging a small change is tagged low risk", () => {
        const { dir, executor, tracker } = makeExecutor({ "sample.ts": "const a = 1;\n" });
        try {
            executor.editFile("sample.ts", [{ search: "const a = 1;", replace: "const a = 2;" }]);
            const action = tracker.getActions().find((a) => a.type === "file_modify")!;
            expect(action.riskTier).toBe("low");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
