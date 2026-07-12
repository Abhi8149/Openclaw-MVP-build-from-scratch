import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ToolExecutor } from "../modes/agents/tool-executor";
import { ActionTracker } from "../modes/agents/action-tracker";
import { defaultAgentConfig } from "../modes/agents/types";

function makeExecutor(initialContent: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edit-file-fuzzy-"));
    fs.writeFileSync(path.join(dir, "sample.ts"), initialContent, "utf8");

    const config = defaultAgentConfig();
    config.codebasePath = dir;
    const executor = new ToolExecutor(new ActionTracker(), config);
    return { dir, executor };
}

describe("edit_file fuzzy matching cascade", () => {
    test("exact match still works (fast path)", () => {
        const { dir, executor } = makeExecutor(
            "function greet(name) {\n    console.log('hi ' + name);\n}\n",
        );
        try {
            executor.editFile("sample.ts", [
                { search: "console.log('hi ' + name);", replace: "console.log(`hi ${name}`);" },
            ]);
            expect(executor.getEffectiveText("sample.ts")).toContain("console.log(`hi ${name}`);");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test("indentation-tolerant match reindents nested lines correctly", () => {
        const { dir, executor } = makeExecutor(
            [
                "function greet(name) {",
                "    if (name) {",
                "        console.log('hello ' + name);",
                "    }",
                "}",
                "",
            ].join("\n"),
        );
        try {
            // Model wrote search/replace as a dedented copy (missing the outer
            // function-body indent level) but kept the same 4-space-per-level width.
            executor.editFile("sample.ts", [
                {
                    search: "if (name) {\n    console.log('hello ' + name);\n}",
                    replace: "if (name) {\n    console.log('hi ' + name);\n}",
                },
            ]);

            const result = executor.getEffectiveText("sample.ts")!;
            // Nesting must be preserved at the file's real 8-space depth, not the
            // search block's local 4-space depth.
            expect(result).toContain("        console.log('hi ' + name);");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test("whitespace-tolerant match handles reformatted internal spacing", () => {
        const { dir, executor } = makeExecutor(
            "function greet(name) {\n    console.log('hello ' +  name);\n}\n",
        );
        try {
            // Search block has single spacing; actual file has a double space.
            executor.editFile("sample.ts", [
                { search: "console.log('hello ' + name);", replace: "console.log('hi ' + name);" },
            ]);
            expect(executor.getEffectiveText("sample.ts")).toContain("    console.log('hi ' + name);");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test("throws a clear error when the search block truly does not exist", () => {
        const { dir, executor } = makeExecutor("const x = 1;\n");
        try {
            expect(() =>
                executor.editFile("sample.ts", [{ search: "const y = 999;", replace: "const y = 2;" }]),
            ).toThrow(/Could not find search block/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test("throws an ambiguous-match error instead of guessing when multiple locations match", () => {
        const { dir, executor } = makeExecutor(
            ["function a() {", "  return 1;", "}", "", "function b() {", "  return 1;", "}", ""].join(
                "\n",
            ),
        );
        try {
            expect(() =>
                executor.editFile("sample.ts", [{ search: "return  1;", replace: "return 2;" }]),
            ).toThrow(/Ambiguous match/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
