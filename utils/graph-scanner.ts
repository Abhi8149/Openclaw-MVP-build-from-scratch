/**
 * Codebase Dependency Scanner
 * 
 * This module recursively scans the workspace directory, ignores excluded files,
 * extracts JavaScript/TypeScript import statements using regex, resolves relative import
 * targets to their actual workspace files, and returns a force-directed graph schema
 * containing file nodes and import edges for visualization in the Web UI.
 */

import fs from "node:fs";
import path from "node:path";

export interface GraphNode {
    id: string;      // Resolved relative file path (e.g. "utils/git.ts")
    label: string;   // File basename (e.g. "git.ts")
    group: string;   // Subdirectory name for visual clustering
    size: number;    // File size in bytes
}

export interface GraphEdge {
    from: string;    // Source file (importer)
    to: string;      // Target file (imported dependency)
}

export interface CodebaseGraph {
    nodes: GraphNode[];
    edges: GraphEdge[];
}

function scanFiles(dir: string, baseDir: string, exclude: string[]): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, "/");

        const shouldExclude = exclude.some((p) => {
            if (p.includes("*")) {
                const regex = new RegExp("^" + p.replace(/\*/g, ".*") + "$");
                return regex.test(entry.name);
            }
            return relativePath.startsWith(p) || entry.name === p;
        });

        if (shouldExclude) continue;

        if (entry.isDirectory()) {
            results.push(...scanFiles(fullPath, baseDir, exclude));
        } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            const allowed = [".ts", ".js", ".tsx", ".jsx", ".json"];
            if (allowed.includes(ext)) {
                results.push(fullPath);
            }
        }
    }
    return results;
}

export function resolveImportPath(importerPath: string, importSpecifier: string, codebasePath: string): string | null {
    // Only resolve relative imports
    if (!importSpecifier.startsWith(".")) return null;

    const importerDir = path.dirname(path.join(codebasePath, importerPath));
    const absoluteTargetDir = path.resolve(importerDir, importSpecifier);
    const extensions = [".ts", ".tsx", ".js", ".jsx", ".json", "/index.ts", "/index.tsx", "/index.js", "/index.mjs"];

    // 1. Try target directory with extension additions
    for (const ext of extensions) {
        let candidate = absoluteTargetDir + ext;
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return path.relative(codebasePath, candidate).replace(/\\/g, "/");
        }
    }

    // 2. Try raw directory resolution (if extension is already provided in import specifier)
    if (fs.existsSync(absoluteTargetDir) && fs.statSync(absoluteTargetDir).isFile()) {
        return path.relative(codebasePath, absoluteTargetDir).replace(/\\/g, "/");
    }

    return null;
}

export function generateCodebaseGraph(codebasePath: string, excludePatterns: string[]): CodebaseGraph {
    const filePaths = scanFiles(codebasePath, codebasePath, excludePatterns);
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const fileSet = new Set<string>();

    // Phase 1: Build Nodes
    for (const file of filePaths) {
        const relPath = path.relative(codebasePath, file).replace(/\\/g, "/");
        const stat = fs.statSync(file);
        const folder = path.dirname(relPath).split("/")[0] || "root";

        nodes.push({
            id: relPath,
            label: path.basename(relPath),
            group: folder,
            size: stat.size
        });
        fileSet.add(relPath);
    }

    // Phase 2: Parse imports and build edges
    const importRegexes = [
        /from\s+["']([^"']+)["']/g,
        /import\s+["']([^"']+)["']/g,
        /(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g
    ];

    for (const file of filePaths) {
        const relPath = path.relative(codebasePath, file).replace(/\\/g, "/");
        let content = "";
        try {
            content = fs.readFileSync(file, "utf8");
        } catch {
            continue;
        }

        const imports = new Set<string>();
        for (const regex of importRegexes) {
            regex.lastIndex = 0;
            let match;
            while ((match = regex.exec(content)) !== null) {
                const specifier = match[1];
                if (specifier) {
                    imports.add(specifier);
                }
            }
        }

        for (const specifier of imports) {
            const resolved = resolveImportPath(relPath, specifier, codebasePath);
            if (resolved && fileSet.has(resolved)) {
                // Ensure duplicate edges are avoided
                const edgeExists = edges.some(e => e.from === relPath && e.to === resolved);
                if (!edgeExists) {
                    edges.push({
                        from: relPath,
                        to: resolved
                    });
                }
            }
        }
    }

    return { nodes, edges };
}
