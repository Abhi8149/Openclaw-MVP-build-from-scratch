import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateRepoMap } from "../utils/repo-map";
import { GuiServer } from "../modes/agents/gui-server";

function createTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "advanced-test-"));
}

describe("Advanced Product Features", () => {
    test("generateRepoMap extracts classes and functions with brace-matching line boundaries", () => {
        const dir = createTempDir();
        try {
            const fileContent = [
                "// Some comments",
                "export class DemoCalculator {",
                "    add(a: number, b: number) {",
                "        return a + b;",
                "    }",
                "}",
                "",
                "function helperFn() {",
                "    console.log('helper');",
                "}"
            ].join("\n");
            
            fs.writeFileSync(path.join(dir, "calc.ts"), fileContent, "utf8");
            
            const map = generateRepoMap(dir, []);
            expect(map).toContain("calc.ts");
            expect(map).toContain("export class DemoCalculator (lines 2-6)");
            expect(map).toContain("function helperFn (lines 8-10)");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test("GuiServer starts and resolves waitForUserApproval upon rest approvals", async () => {
        const gui = new GuiServer();
        const url = await gui.start(8081);
        expect(url).toBe("http://127.0.0.1:8081");

        try {
            // Start approval wait in background
            const approvalPromise = gui.waitForUserApproval();

            // Simulate user clicking "Approve" from browser
            const res = await fetch("http://127.0.0.1:8081/api/approve", { method: "POST" });
            expect(res.status).toBe(200);
            const json = await res.json();
            expect(json.success).toBe(true);

            // Verify the orchestrator's promise resolves to true
            const approved = await approvalPromise;
            expect(approved).toBe(true);
        } finally {
            gui.stop();
        }
    });

    test("GuiServer resolves waitForUserApproval to false upon rest rejection", async () => {
        const gui = new GuiServer();
        await gui.start(8082);

        try {
            const approvalPromise = gui.waitForUserApproval();

            const res = await fetch("http://127.0.0.1:8082/api/reject", { method: "POST" });
            expect(res.status).toBe(200);

            const approved = await approvalPromise;
            expect(approved).toBe(false);
        } finally {
            gui.stop();
        }
    });

    test("GuiServer resolves waitForGoal when prompt is submitted via API", async () => {
        const gui = new GuiServer();
        await gui.start(8083);

        try {
            const goalPromise = gui.waitForGoal();

            const res = await fetch("http://127.0.0.1:8083/api/prompt", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ prompt: "Refactor main loop" }),
            });
            expect(res.status).toBe(200);

            const goal = await goalPromise;
            expect(goal).toBe("Refactor main loop");
        } finally {
            gui.stop();
        }
    });
});
