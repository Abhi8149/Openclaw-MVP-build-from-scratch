import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { semanticSearch, extractSkeleton } from "../utils/semantic-retrieval";
import { wrapModelWithRollingMemory } from "../ai/memory";

function createTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "semantic-test-"));
}

describe("Intent-Driven Retrieval & Rolling Memory", () => {
    test("semanticSearch finds matching files using local TF-IDF overlap fallback", async () => {
        const dir = createTempDir();
        try {
            // Create a target file with unique keywords
            fs.writeFileSync(
                path.join(dir, "database-connector.ts"),
                "export class DatabaseHelper {\n  connect() {\n    console.log('establishing postgres connection pool');\n  }\n}",
                "utf8"
            );

            // Create an unrelated file
            fs.writeFileSync(
                path.join(dir, "styles.css"),
                ".button { color: red; margin: 10px; padding: 5px; }",
                "utf8"
            );

            // Temporarily empty OPENROUTER_API_KEY to force TF-IDF local fallback
            const originalKey = process.env.OPENROUTER_API_KEY;
            process.env.OPENROUTER_API_KEY = "";

            try {
                const results = await semanticSearch("establish postgres database connection", dir, []);
                expect(results.length).toBeGreaterThan(0);
                
                // The database-connector file should rank top
                expect(results[0]!.path).toBe("database-connector.ts");
            } finally {
                process.env.OPENROUTER_API_KEY = originalKey;
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });

    test("wrapModelWithRollingMemory proxies doGenerate and minimizes system prompt", async () => {
        let optionsPassedToInner: any = null;

        const mockInnerModel = {
            specificationVersion: "v1",
            provider: "mock",
            modelId: "mock-model",
            defaultObjectGenerationMode: "json",
            doGenerate: async (options: any) => {
                optionsPassedToInner = options;
                return {
                    text: "Turn response",
                    finishReason: "stop",
                    usage: { promptTokens: 10, completionTokens: 5 }
                };
            }
        };

        const goal = "Write database connections";
        const skeletalMap = "export class DatabaseHelper";
        const semanticFiles = "--- File: database-connector.ts ---";

        const wrapped = wrapModelWithRollingMemory(mockInnerModel, goal, skeletalMap, semanticFiles);

        // Turn 1: 1 message (direct tool response)
        const initialPrompt = [
            { role: "user", content: "hello" }
        ];

        await wrapped.doGenerate({ prompt: initialPrompt });

        expect(optionsPassedToInner).not.toBeNull();
        expect(optionsPassedToInner.prompt[0].role).toBe("system");
        expect(optionsPassedToInner.prompt[0].content).toContain("Skeletal Map of the codebase");
        expect(optionsPassedToInner.prompt[0].content).toContain(skeletalMap);
        expect(optionsPassedToInner.prompt[0].content).toContain(semanticFiles);
        expect(optionsPassedToInner.prompt[1].role).toBe("user");
        expect(optionsPassedToInner.prompt[1].content).toBe("hello");
    });

    test("extractSkeleton generates correct code skeleton summary", () => {
        const fileContent = `
            import { Database } from "bun:sqlite";
            import chalk from "chalk";

            export class AuthController {
                async login(req: any) {
                    console.log("internal logic");
                }
            }

            export function verifyToken(token: string) {
                return true;
            }
        `;
        const skeleton = extractSkeleton("src/auth.ts", fileContent);
        
        expect(skeleton).toContain("File: src/auth.ts");
        expect(skeleton).toContain("- import: import { Database } from \"bun:sqlite\";");
        expect(skeleton).toContain("- class.name: AuthController");
        expect(skeleton).toContain("- method.name: login");
        expect(skeleton).toContain("- function.name: verifyToken");
        expect(skeleton).not.toContain("internal logic");
    });

    test("extractSkeleton handles other languages like Go, Rust, Java, and C++ via regex fallback", () => {
        // Go
        const goContent = `
            package main
            import (
                "fmt"
                "net/http"
            )
            type User struct {}
            func (u *User) GetName() string {}
            func main() {}
        `;
        const goSkeleton = extractSkeleton("main.go", goContent);
        expect(goSkeleton).toContain("File: main.go");
        expect(goSkeleton).toContain("- import: \"fmt\"");
        expect(goSkeleton).toContain("- type.name: User");
        expect(goSkeleton).toContain("- function.name: main");

        // Rust
        const rustContent = `
            use std::collections::HashMap;
            struct Point { x: i32 }
            fn compute_distance() {}
        `;
        const rustSkeleton = extractSkeleton("src/main.rs", rustContent);
        expect(rustSkeleton).toContain("- import: use std::collections::HashMap;");
        expect(rustSkeleton).toContain("- type.name: Point");
        expect(rustSkeleton).toContain("- function.name: compute_distance");

        // C++
        const cppContent = `
            #include <iostream>
            class Calculator {
                int add(int a) {}
            };
        `;
        const cppSkeleton = extractSkeleton("main.cpp", cppContent);
        expect(cppSkeleton).toContain("- import: #include <iostream>");
        expect(cppSkeleton).toContain("- class.name: Calculator");
        expect(cppSkeleton).toContain("- function.name: add");
    });
});
