import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateRepoMap } from "../utils/repo-map";
import { GuiServer } from "../modes/agents/gui-server";
import { calculateTradeoff } from "../ai/ai.config";
import { extractSymbols, semanticSearch, getLatestMatchedSymbols, closeDb } from "../utils/semantic-retrieval";
import { ActionTracker } from "../modes/agents/action-tracker";
import { defaultAgentConfig } from "../modes/agents/types";
import { ToolExecutor } from "../modes/agents/tool-executor";
import { traverseImports } from "../modes/agents/orchestrator";

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

    test("calculateTradeoff correctly estimates task cost-quality tradeoff values", () => {
        const simpleScore = calculateTradeoff("Add a comment in git.ts and update styling color");
        const complexScore = calculateTradeoff("Refactor database schema connection pooling and heal compiler issues");

        expect(simpleScore).toBeGreaterThan(5.0);
        expect(complexScore).toBeLessThan(5.0);
    });

    test("ToolExecutor executes staged shell commands asynchronously and captures exit codes", async () => {
        const tracker = new ActionTracker();
        const config = defaultAgentConfig();
        config.tools.allowShellExecution = true;
        const executor = new ToolExecutor(tracker, config);

        // Stage a successful shell command
        executor.queueShell("echo 'test async execution'");
        const actions = tracker.getActions();
        expect(actions.length).toBe(1);
        actions[0]!.status = "approved"; // Simulate user approval

        const result = await executor.applyApprovedFromTracker();
        expect(result.errors.length).toBe(0);

        // Stage a failing shell command
        executor.clearStaging();
        tracker.log({
            type: "tool_execute",
            path: "shell",
            details: { command: "nonexistent-command-xyz-12345", toolName: "execute_shell" },
            status: "approved",
            timestamp: new Date()
        });

        const failResult = await executor.applyApprovedFromTracker();
        expect(failResult.errors.length).toBeGreaterThan(0);
    });

    test("traverseImports recursively resolves local imports and retrieves their skeletons", () => {
        const dir = createTempDir();
        try {
            // Write three files forming a chain: entry.ts -> helpers/helper.ts -> constants.ts
            fs.writeFileSync(path.join(dir, "entry.ts"), "import { helper } from './helpers/helper';\nhelper();", "utf8");
            fs.mkdirSync(path.join(dir, "helpers"), { recursive: true });
            fs.writeFileSync(path.join(dir, "helpers", "helper.ts"), "import { value } from '../constants';\nexport function helper() { return value; }", "utf8");
            fs.writeFileSync(path.join(dir, "constants.ts"), "export const value = 42;", "utf8");

            const skeletons = traverseImports(["entry.ts"], dir, [], 2);

            expect(skeletons).toContain("helpers/helper.ts");
            expect(skeletons).toContain("constants.ts");
            expect(skeletons).toContain("- function.name: helper");
            expect(skeletons).toContain("- import: import { value }");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test("ToolExecutor.searchWeb returns warning when no API key is configured", async () => {
        const oldKey = process.env.BRAVE_SEARCH_API_KEY;
        const oldFirecrawl = process.env.FIRECRAWL_API_KEY;
        delete process.env.BRAVE_SEARCH_API_KEY;
        delete process.env.FIRECRAWL_API_KEY;
        try {
            const tracker = new ActionTracker();
            const config = defaultAgentConfig();
            const executor = new ToolExecutor(tracker, config);

            const result = await executor.searchWeb("test query");
            expect(result).toContain("Neither BRAVE_SEARCH_API_KEY nor FIRECRAWL_API_KEY is configured");
        } finally {
            if (oldKey) process.env.BRAVE_SEARCH_API_KEY = oldKey;
            if (oldFirecrawl) process.env.FIRECRAWL_API_KEY = oldFirecrawl;
        }
    });

    test("ToolExecutor.searchWeb calls Brave Search API and formats results when key is configured", async () => {
        const oldKey = process.env.BRAVE_SEARCH_API_KEY;
        process.env.BRAVE_SEARCH_API_KEY = "test-brave-key";

        const originalFetch = global.fetch;
        try {
            // Mock fetch globally
            global.fetch = (async (url: any) => {
                expect(url).toContain("q=typescript");
                return {
                    ok: true,
                    json: async () => ({
                        web: {
                            results: [
                                {
                                    title: "TypeScript Documentation",
                                    url: "https://www.typescriptlang.org",
                                    description: "The language site for TypeScript."
                                }
                            ]
                        }
                    })
                } as Response;
            }) as any;

            const tracker = new ActionTracker();
            const config = defaultAgentConfig();
            const executor = new ToolExecutor(tracker, config);

            const result = await executor.searchWeb("typescript");
            expect(result).toContain("TypeScript Documentation");
            expect(result).toContain("https://www.typescriptlang.org");
            expect(result).toContain("The language site for TypeScript.");
        } finally {
            global.fetch = originalFetch;
            if (oldKey) process.env.BRAVE_SEARCH_API_KEY = oldKey;
            else delete process.env.BRAVE_SEARCH_API_KEY;
        }
    });

    test("ToolExecutor.searchWeb falls back to Firecrawl when Brave is missing but Firecrawl is configured", async () => {
        const oldBrave = process.env.BRAVE_SEARCH_API_KEY;
        const oldFirecrawl = process.env.FIRECRAWL_API_KEY;
        delete process.env.BRAVE_SEARCH_API_KEY;
        process.env.FIRECRAWL_API_KEY = "test-firecrawl-key";

        const originalFetch = global.fetch;
        try {
            global.fetch = (async (url: any, options: any) => {
                expect(url).toBe("https://api.firecrawl.dev/v1/search");
                expect(options.method).toBe("POST");
                const body = JSON.parse(options.body);
                expect(body.query).toBe("firecrawl query");
                return {
                    ok: true,
                    json: async () => ({
                        data: [
                            {
                                title: "Firecrawl Docs",
                                url: "https://docs.firecrawl.dev",
                                description: "Firecrawl Documentation"
                            }
                        ]
                    })
                } as Response;
            }) as any;

            const tracker = new ActionTracker();
            const config = defaultAgentConfig();
            const executor = new ToolExecutor(tracker, config);

            const result = await executor.searchWeb("firecrawl query");
            expect(result).toContain("Firecrawl Docs");
            expect(result).toContain("https://docs.firecrawl.dev");
        } finally {
            global.fetch = originalFetch;
            if (oldBrave) process.env.BRAVE_SEARCH_API_KEY = oldBrave;
            else delete process.env.BRAVE_SEARCH_API_KEY;
            if (oldFirecrawl) process.env.FIRECRAWL_API_KEY = oldFirecrawl;
            else delete process.env.FIRECRAWL_API_KEY;
        }
    });

    test("ToolExecutor.scrapePage returns warning when no Firecrawl API key is configured", async () => {
        const oldKey = process.env.FIRECRAWL_API_KEY;
        delete process.env.FIRECRAWL_API_KEY;

        try {
            const tracker = new ActionTracker();
            const config = defaultAgentConfig();
            const executor = new ToolExecutor(tracker, config);

            const result = await executor.scrapePage("https://example.com");
            expect(result).toContain("FIRECRAWL_API_KEY is not configured");
        } finally {
            if (oldKey) process.env.FIRECRAWL_API_KEY = oldKey;
        }
    });

    test("ToolExecutor.scrapePage calls Firecrawl Scrape API and returns markdown", async () => {
        const oldKey = process.env.FIRECRAWL_API_KEY;
        process.env.FIRECRAWL_API_KEY = "test-firecrawl-key";

        const originalFetch = global.fetch;
        try {
            global.fetch = (async (url: any, options: any) => {
                expect(url).toBe("https://api.firecrawl.dev/v1/scrape");
                expect(options.method).toBe("POST");
                const body = JSON.parse(options.body);
                expect(body.url).toBe("https://example.com");
                return {
                    ok: true,
                    json: async () => ({
                        success: true,
                        data: {
                            markdown: "# Example Page\nThis is a mock page."
                        }
                    })
                } as Response;
            }) as any;

            const tracker = new ActionTracker();
            const config = defaultAgentConfig();
            const executor = new ToolExecutor(tracker, config);

            const result = await executor.scrapePage("https://example.com");
            expect(result).toContain("# Example Page");
            expect(result).toContain("This is a mock page.");
        } finally {
            global.fetch = originalFetch;
            if (oldKey) process.env.FIRECRAWL_API_KEY = oldKey;
            else delete process.env.FIRECRAWL_API_KEY;
        }
    });

    test("extractSymbols matches and extracts symbols and their full bodies from code content", () => {
        const fileContent = `
            export class AuthManager {
                constructor() {}
                async verifyToken(token: string) {
                    if (!token) return false;
                    return true;
                }
            }

            export function logAction(action: string) {
                console.log(action);
            }
        `;

        const symbols = extractSymbols("auth.ts", fileContent);

        const authClass = symbols.find(s => s.name === "AuthManager");
        expect(authClass).toBeDefined();
        expect(authClass!.type).toBe("class");
        expect(authClass!.text).toContain("export class AuthManager");
        expect(authClass!.text).toContain("verifyToken");

        const verifyMethod = symbols.find(s => s.name === "verifyToken");
        expect(verifyMethod).toBeDefined();
        expect(verifyMethod!.type).toBe("method");
        expect(verifyMethod!.text).toContain("async verifyToken");
        expect(verifyMethod!.text).toContain("return true;");

        const logFunction = symbols.find(s => s.name === "logAction");
        expect(logFunction).toBeDefined();
        expect(logFunction!.type).toBe("function");
        expect(logFunction!.text).toContain("export function logAction");
        expect(logFunction!.text).toContain("console.log(action);");
    });

    test("semanticSearch indexes symbols and returns exact code snippets on query matches", async () => {
        const dir = createTempDir();
        // Clear environment OPENROUTER_API_KEY to force local TF-IDF fallback to ensure predictable testing
        const oldOpenRouterKey = process.env.OPENROUTER_API_KEY;
        delete process.env.OPENROUTER_API_KEY;

        try {
            const fileContent = `
                export function calculateStandardTax(amount: number) {
                    return amount * 0.15;
                }

                export function calculateLuxuryTax(amount: number) {
                    return amount * 0.40;
                }
            `;
            fs.writeFileSync(path.join(dir, "tax.ts"), fileContent, "utf8");

            // Execute search to index the file and symbols
            const results = await semanticSearch("Where is calculateLuxuryTax?", dir, []);
            expect(results.length).toBeGreaterThan(0);
            expect(results[0]?.path).toBe("tax.ts");

            // Verify matched symbols text is populated with the exact function code block
            const matchedSymbolsText = getLatestMatchedSymbols();
            expect(matchedSymbolsText).toContain("calculateLuxuryTax");
            expect(matchedSymbolsText).toContain("amount * 0.40");
        } finally {
            closeDb();
            fs.rmSync(dir, { recursive: true, force: true });
            if (oldOpenRouterKey) process.env.OPENROUTER_API_KEY = oldOpenRouterKey;
        }
    });

    test("ToolExecutor.hasStagedMutations correctly tracks staged file overlay changes", () => {
        const tracker = new ActionTracker();
        const config = defaultAgentConfig();
        const executor = new ToolExecutor(tracker, config);

        expect(executor.hasStagedMutations()).toBe(false);

        // Stage file modification
        executor.createFile("dummy.ts", "content");
        expect(executor.hasStagedMutations()).toBe(true);

        executor.clearStaging();
        expect(executor.hasStagedMutations()).toBe(false);
    });
});
