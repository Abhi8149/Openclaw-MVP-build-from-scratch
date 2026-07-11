import { spawnSync } from "node:child_process";

export interface DiagnosticResult {
    passed: boolean;
    errorOutput?: string;
}

export function runProjectChecks(cwd: string): DiagnosticResult {
    // 1. Run TypeScript typecheck (if tsconfig exists)
    const tsc = spawnSync("bunx", ["tsc", "--noEmit"], { cwd, encoding: "utf8" });
    if (tsc.status !== 0) {
        return { passed: false, errorOutput: `TypeScript Errors:\n${tsc.stdout || tsc.stderr}` };
    }

    // 2. Run Test suite (if test command is available in package.json)
    const test = spawnSync("bun", ["test"], { cwd, encoding: "utf8" });
    if (test.status !== 0) {
        const output = (test.stdout || "") + (test.stderr || "");
        if (output.includes("No tests found!")) {
            // Ignore if there are no test files in the project
        } else {
            return { passed: false, errorOutput: `Test Suite Failures:\n${output}` };
        }
    }

    return { passed: true };
}