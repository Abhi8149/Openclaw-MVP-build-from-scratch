import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";

interface CacheItem {
    path: string;
    mtime: number;
    vector?: number[];
    tokens: string[];
}

const CACHE_FILE = ".openclaw-embeddings.json";

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s_-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2);
}

function computeLocalSimilarity(tokensA: string[], tokensB: string[]): number {
    const freqA: Record<string, number> = {};
    const freqB: Record<string, number> = {};
    for (const t of tokensA) freqA[t] = (freqA[t] || 0) + 1;
    for (const t of tokensB) freqB[t] = (freqB[t] || 0) + 1;

    const allTerms = new Set([...Object.keys(freqA), ...Object.keys(freqB)]);
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (const term of allTerms) {
        const valA = freqA[term] || 0;
        const valB = freqB[term] || 0;
        dotProduct += valA * valB;
        normA += valA * valA;
        normB += valB * valB;
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        const a = vecA[i] ?? 0;
        const b = vecB[i] ?? 0;
        dotProduct += a * b;
        normA += a * a;
        normB += b * b;
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function fetchEmbeddingFromAPI(text: string, apiKey: string): Promise<number[]> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 8000); // 8-second timeout limit

    try {
        const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "nomic-ai/nomic-embed-text",
                input: text.slice(0, 8000) // Truncate to fit model input window limit
            }),
            signal: controller.signal
        });

        clearTimeout(id);

        if (!res.ok) {
            throw new Error(`Embedding API returned status ${res.status}`);
        }

        const data = (await res.json()) as any;
        if (!data.data?.[0]?.embedding) {
            throw new Error("Invalid response shape from Embeddings API");
        }

        return data.data[0].embedding;
    } catch (err) {
        clearTimeout(id);
        throw err;
    }
}

function loadCache(codebasePath: string): Record<string, CacheItem> {
    const cachePath = path.join(codebasePath, CACHE_FILE);
    if (!fs.existsSync(cachePath)) return {};
    try {
        return JSON.parse(fs.readFileSync(cachePath, "utf8"));
    } catch {
        return {};
    }
}

function saveCache(codebasePath: string, cache: Record<string, CacheItem>) {
    const cachePath = path.join(codebasePath, CACHE_FILE);
    try {
        fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf8");
    } catch (err) {
        console.error("Failed to write embeddings cache:", err);
    }
}

function scanFiles(dir: string, baseDir: string, exclude: string[]): string[] {
    const results: string[] = [];
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
            const allowed = [".ts", ".js", ".tsx", ".jsx", ".md", ".json", ".css", ".html", ".txt"];
            if (allowed.includes(ext)) {
                results.push(fullPath);
            }
        }
    }
    return results;
}

export async function semanticSearch(
    goal: string,
    codebasePath: string,
    excludePatterns: string[]
): Promise<Array<{ path: string; content: string }>> {
    console.log(chalk.dim("🔍 Scanning codebase for intent-driven retrieval..."));
    
    const filePaths = scanFiles(codebasePath, codebasePath, excludePatterns);
    const cache = loadCache(codebasePath);
    const apiKey = process.env.OPENROUTER_API_KEY || "";
    
    let cacheUpdated = false;
    let useVectors = apiKey.length > 0;

    // Phase 1: Update cache with new/modified files
    for (const file of filePaths) {
        const relPath = path.relative(codebasePath, file).replace(/\\/g, "/");
        const stat = fs.statSync(file);
        const mtime = stat.mtimeMs;

        const cached = cache[relPath];
        if (cached && cached.mtime === mtime) {
            continue;
        }

        const content = fs.readFileSync(file, "utf8").trim();
        if (!content) {
            continue;
        }
        const tokens = tokenize(content);
        let vector: number[] | undefined;

        if (useVectors) {
            try {
                vector = await fetchEmbeddingFromAPI(content, apiKey);
            } catch (err) {
                console.log(chalk.yellow(`⚠️ Embeddings API failed for ${relPath}: ${String(err)}. Switching to local fallback.`));
                useVectors = false;
            }
        }

        cache[relPath] = {
            path: relPath,
            mtime,
            vector,
            tokens
        };
        cacheUpdated = true;
    }

    if (cacheUpdated) {
        saveCache(codebasePath, cache);
    }

    // Phase 2: Vectorize goal/intent or tokenize for term-frequency overlap
    let goalVector: number[] | undefined;
    const goalTokens = tokenize(goal);

    if (useVectors) {
        try {
            goalVector = await fetchEmbeddingFromAPI(goal, apiKey);
        } catch {
            useVectors = false;
        }
    }

    // Phase 3: Score files
    const scoredFiles: Array<{ relPath: string; score: number }> = [];

    for (const relPath of Object.keys(cache)) {
        const item = cache[relPath]!;
        const fullPath = path.join(codebasePath, relPath);
        if (!fs.existsSync(fullPath)) continue;

        let score = 0;
        if (useVectors && goalVector && item.vector) {
            score = cosineSimilarity(goalVector, item.vector);
        } else {
            score = computeLocalSimilarity(goalTokens, item.tokens);
        }

        scoredFiles.push({ relPath, score });
    }

    // Sort descending by similarity score
    scoredFiles.sort((a, b) => b.score - a.score);

    // Retrieve top 3
    const topFiles = scoredFiles.slice(0, 3);
    console.log(chalk.cyan(`🎯 Intent-driven retrieval found ${topFiles.length} semantically related files:`));
    for (const f of topFiles) {
        console.log(chalk.cyan(`   • ${f.relPath} (score: ${f.score.toFixed(3)})`));
    }

    return topFiles.map((f) => {
        const fullPath = path.join(codebasePath, f.relPath);
        return {
            path: f.relPath,
            content: fs.readFileSync(fullPath, "utf8")
        };
    });
}
