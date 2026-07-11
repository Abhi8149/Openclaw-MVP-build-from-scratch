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
                // Extract functions & classes using regex for simplicity
                const code = fs.readFileSync(path.join(currentDir, entry.name), "utf8");
                const matches = code.match(/(class \w+|function \w+|export const \w+\s*=)/g);
                if (matches) {
                    matches.forEach(m => lines.push(`    • ${m.trim()}`));
                }
            }
        }
    }

    scan(dir);
    return lines.join("\n");
}