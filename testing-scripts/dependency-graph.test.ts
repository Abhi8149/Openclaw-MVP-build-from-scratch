/**
 * Dependency Graph Feature Test Suite
 * 
 * This test suite:
 * 1. Verifies the dependency scanner correctly builds file nodes and directed import edges
 *    using a temporary mock workspace with relative imports.
 * 2. Confirms that GuiServer serves the graph topology correctly via the /api/graph endpoint.
 * 3. Assures that file pinning works dynamically via POST /api/context/pin endpoints,
 *    updating state within the server correctly.
 */

import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateCodebaseGraph } from "../utils/graph-scanner";
import { GuiServer } from "../modes/agents/gui-server";

function createTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "graph-test-"));
}

describe("Codebase Dependency Graph Scanner", () => {
    test("scans source files and maps import statements to edges", () => {
        const dir = createTempDir();
        try {
            // Setup importer-importee files
            const utilsDir = path.join(dir, "utils");
            fs.mkdirSync(utilsDir, { recursive: true });

            fs.writeFileSync(
                path.join(utilsDir, "logger.ts"),
                "export function log(msg: string) { console.log(msg); }",
                "utf8"
            );

            fs.writeFileSync(
                path.join(dir, "app.ts"),
                `
                import { log } from "./utils/logger";
                log("started");
                `,
                "utf8"
            );

            const graph = generateCodebaseGraph(dir, ["node_modules"]);
            
            // Check nodes
            expect(graph.nodes.some(n => n.id === "app.ts")).toBe(true);
            expect(graph.nodes.some(n => n.id === "utils/logger.ts")).toBe(true);
            
            // Check edges
            expect(graph.edges.length).toBe(1);
            expect(graph.edges[0]!.from).toBe("app.ts");
            expect(graph.edges[0]!.to).toBe("utils/logger.ts");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("GuiServer Graph API & Context Pinning", () => {
    test("serves graph data and handles context pinning updates", async () => {
        const gui = new GuiServer();
        const port = 8089;
        await gui.start(port);

        try {
            // Test 1: Fetch graph from endpoint
            const graphRes = await fetch(`http://127.0.0.1:${port}/api/graph`);
            expect(graphRes.status).toBe(200);
            const graph = await graphRes.json();
            expect(graph).toHaveProperty("nodes");
            expect(graph).toHaveProperty("edges");

            // Test 2: Pin a file in context
            const pinRes = await fetch(`http://127.0.0.1:${port}/api/context/pin`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: "app.ts", pin: true })
            });
            expect(pinRes.status).toBe(200);
            const pinJson = await pinRes.json();
            expect(pinJson.success).toBe(true);
            expect(pinJson.pinnedFiles).toContain("app.ts");
            expect(gui.getPinnedFiles()).toContain("app.ts");

            // Test 3: Unpin the file
            const unpinRes = await fetch(`http://127.0.0.1:${port}/api/context/pin`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: "app.ts", pin: false })
            });
            expect(unpinRes.status).toBe(200);
            const unpinJson = await unpinRes.json();
            expect(unpinJson.pinnedFiles).not.toContain("app.ts");
            expect(gui.getPinnedFiles()).not.toContain("app.ts");
        } finally {
            gui.stop();
        }
    });
});
