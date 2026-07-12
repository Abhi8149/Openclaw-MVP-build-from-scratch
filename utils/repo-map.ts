import fs from "node:fs";
import path from "node:path";

export function generateRepoMap(dir: string, excludes: string[]): string {
    const lines: string[] = [];

    function scan(currentDir: string) {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });

        for (const entry of entries) {
            const relPath = path.relative(dir, path.join(currentDir, entry.name));
            if (excludes.some(ex => relPath.includes(ex))) continue;

            if (entry.isDirectory()) {
                scan(path.join(currentDir, entry.name));
            } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) {
                lines.push(`- ${relPath}`);
                const code = fs.readFileSync(path.join(currentDir, entry.name), "utf8");
                const codeLines = code.split(/\r?\n/);

                for (let i = 0; i < codeLines.length; i++) {
                    const line = codeLines[i]!;
                    const match = line.match(/(?:export\s+)?(?:class|function|const|let|var)\s+(\w+)\b/);
                    // Filter out comments or generic strings
                    if (match && (line.includes("class ") || line.includes("function ") || line.includes("=>") || line.includes("= function"))) {
                        const name = match[1];
                        if (!name) continue;
                        
                        let startLine = i + 1;
                        let endLine = startLine;
                        let braceCount = 0;
                        let foundBrace = false;

                        outer: for (let j = i; j < codeLines.length; j++) {
                            const l = codeLines[j]!;
                            for (let c = 0; c < l.length; c++) {
                                if (l[c] === "{") {
                                    braceCount++;
                                    foundBrace = true;
                                } else if (l[c] === "}") {
                                    braceCount--;
                                }
                                if (foundBrace && braceCount === 0) {
                                    endLine = j + 1;
                                    break outer;
                                }
                            }
                        }

                        // Only add if we successfully matched class or function bounds
                        lines.push(`    • ${match[0].trim()} (lines ${startLine}-${endLine})`);
                    }
                }
            }
        }
    }

    scan(dir);
    return lines.join("\n");
}