import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import chalk from "chalk";
import type { AgentConfig, ActionLog } from "./types";
import { ActionTracker } from "./action-tracker";
import { classifyFileMutation, classifyShellCommand } from "./risk-classifier";

const TEXT_EXT = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
    ".md",
    ".mdx",
    ".css",
    ".html",
    ".yml",
    ".yaml",
    ".toml",
    ".txt",
])

function isProbablyTextFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return TEXT_EXT.has(ext) || ext === "";
}

function leadingWhitespace(line: string): string {
    return line.match(/^[ \t]*/)?.[0] ?? "";
}

function collapseWhitespace(line: string): string {
    return line.trim().replace(/[ \t]+/g, " ");
}

// Finds all windows in contentLines whose lines equal searchLines under `normalize`.
function findLineWindowMatches(
    contentLines: string[],
    searchLines: string[],
    normalize: (line: string) => string,
): number[] {
    const matches: number[] = [];
    const normSearch = searchLines.map(normalize);
    for (let i = 0; i + searchLines.length <= contentLines.length; i++) {
        let ok = true;
        for (let j = 0; j < searchLines.length; j++) {
            if (normalize(contentLines[i + j]!) !== normSearch[j]) {
                ok = false;
                break;
            }
        }
        if (ok) matches.push(i);
    }
    return matches;
}

// Re-applies the actual file's indentation to a replacement block that was
// written against a search block with different (but equivalent) indentation.
function reindentReplacement(
    replaceLines: string[],
    searchFirstLine: string,
    actualFirstLine: string,
): string[] {
    const searchIndent = leadingWhitespace(searchFirstLine);
    const actualIndent = leadingWhitespace(actualFirstLine);
    if (searchIndent === actualIndent) return replaceLines;

    // Apply the same absolute indent shift to every line's own indentation,
    // rather than slicing a fixed prefix, so relative nesting is preserved.
    const delta = actualIndent.length - searchIndent.length;
    const indentChar = actualIndent[0] ?? searchIndent[0] ?? " ";

    return replaceLines.map((line) => {
        if (line.trim() === "") return line;
        const ownIndent = leadingWhitespace(line);
        const newLen = Math.max(0, ownIndent.length + delta);
        return indentChar.repeat(newLen) + line.slice(ownIndent.length);
    });
}

export class ToolExecutor {
    private overlay = new Map<string, string>();
    private deleted = new Set<string>();
    private readonly norm = (rel: string) => {
        //getting normalized with te
        return path.posix.normalize(rel.split(path.sep).join("/")).replace(/^\.\//, "");
    }

    constructor(
        private readonly tracker: ActionTracker,
        public readonly config: AgentConfig,
    ) { }

    private resolveSafe(rel: string): string {
        const abs = path.resolve(this.config.codebasePath, rel);
        const root = path.resolve(this.config.codebasePath);
        const relCheck = path.relative(root, abs);
        if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
            throw new Error(`Path escapes workspace: ${rel}`);
        }
        return abs;
    }

    private excluded(relPath: string): boolean {
        const norm = this.norm(relPath);
        const segments = norm.split("/");
        const base = segments[segments.length - 1] ?? "";

        for (const pat of this.config.excludePatterns) {
            if (pat === "*.log" && base.endsWith(".log")) return true;
            if (pat === ".env*" && base.startsWith(".env")) return true;
            if (pat.includes("*")) continue;
            if (segments.includes(pat) || norm === pat || norm.startsWith(`${pat}/`))
                return true;
        }
        return false;
    }

    private assertNotExcluded(rel: string, op: string): void {
        if (this.excluded(rel)) {
            throw new Error(`${op}: path is excluded by policy: ${rel}`);
        }
    }

    getEffectiveText(rel: string): string | undefined {
        const key = this.norm(rel);
        if (this.deleted.has(key)) return undefined;
        if (this.overlay.has(key)) return this.overlay.get(key);
        const abs = this.resolveSafe(rel);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return undefined;
        return fs.readFileSync(abs, "utf8");
    }

    readFile(rel: string): string {
        this.assertNotExcluded(rel, "read_file");
        // Read through getEffectiveText to seamlessly access staged/overlay files in memory
        const text = this.getEffectiveText(rel);
        if (text === undefined) {
            throw new Error(`File not found: ${rel}`);
        }
        if (Buffer.byteLength(text, "utf8") > this.config.maxFileSizeToRead) {
            throw new Error(`File too large: ${rel}`);
        }
        this.tracker.log({
            type: "code_analysis",
            path: this.norm(rel),
            details: { after: text, toolName: "read_file" },
            status: "executed",
        });
        return text;
    }

    createFile(rel: string, content: string): string {
        if (!this.config.tools.allowFileCreation)
            throw new Error("File creation disabled");
        this.assertNotExcluded(rel, "create_file");
        const key = this.norm(rel);
        const abs = this.resolveSafe(rel);
        if (fs.existsSync(abs) && !this.deleted.has(key)) {
            throw new Error(`create_file: already exists: ${rel}`);
        }
        this.deleted.delete(key);
        this.overlay.set(key, content);
        const risk = classifyFileMutation("file_create", key, undefined, content);
        this.tracker.log({
            type: "file_create",
            path: key,
            details: { after: content },
            status: "pending",
            riskTier: risk.tier,
            riskReason: risk.reason,
            requiresTypedConfirmation: risk.requiresTypedConfirmation,
        });
        return `Staged new file: ${key}`;
    }

    modifyFile(rel: string, content: string): string {
        if (!this.config.tools.allowFileModification)
            throw new Error("File modification disabled");
        this.assertNotExcluded(rel, "modify_file");
        const before = this.getEffectiveText(rel);
        if (before === undefined)
            throw new Error(`modify_file: file not found: ${rel}`);
        const key = this.norm(rel);
        this.overlay.set(key, content);
        const risk = classifyFileMutation("file_modify", key, before, content);
        this.tracker.log({
            type: "file_modify",
            path: key,
            details: { before, after: content },
            status: "pending",
            riskTier: risk.tier,
            riskReason: risk.reason,
            requiresTypedConfirmation: risk.requiresTypedConfirmation,
        });
        return `Staged update: ${key}`;
    }

    deleteFile(rel: string): string {
        if (!this.config.tools.allowFileModification)
            throw new Error("File deletion disabled");
        this.assertNotExcluded(rel, "delete_file");
        const before = this.getEffectiveText(rel);
        if (before === undefined)
            throw new Error(`delete_file: file not found: ${rel}`);
        const key = this.norm(rel);
        this.overlay.delete(key);
        this.deleted.add(key);
        const risk = classifyFileMutation("file_delete", key, before, undefined);
        this.tracker.log({
            type: "file_delete",
            path: key,
            details: { before },
            status: "pending",
            riskTier: risk.tier,
            riskReason: risk.reason,
            requiresTypedConfirmation: risk.requiresTypedConfirmation,
        });
        return `Staged delete: ${key}`;
    }

    createFolder(rel: string): string {
        if (!this.config.tools.allowFolderCreation)
            throw new Error("Folder creation disabled");
        this.assertNotExcluded(rel, "create_folder");
        const key = this.norm(rel);
        const risk = classifyFileMutation("folder_create", key, undefined, undefined);
        this.tracker.log({
            type: "folder_create",
            path: key,
            details: { after: key },
            status: "pending",
            riskTier: risk.tier,
            riskReason: risk.reason,
            requiresTypedConfirmation: risk.requiresTypedConfirmation,
        });
        return `Staged folder: ${key}`;
    }

    listFiles(rel: string, recursive: boolean): string {
        this.assertNotExcluded(rel, "list_files");
        const abs = this.resolveSafe(rel);
        if (!fs.existsSync(abs)) throw new Error(`list_files: not found: ${rel}`);

        const lines: string[] = [];
        const walk = (dir: string, prefix: string) => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const ent of entries) {
                const full = path.join(dir, ent.name);
                const relP = path.relative(this.config.codebasePath, full);
                if (this.excluded(relP)) continue;
                if (ent.isDirectory()) {
                    lines.push(`${prefix}${ent.name}/`);
                    if (recursive) walk(full, `${prefix}${ent.name}/`);
                } else {
                    lines.push(`${prefix}${ent.name}`);
                }
            }
        };

        if (fs.statSync(abs).isDirectory()) walk(abs, "");
        else lines.push(path.relative(this.config.codebasePath, abs));

        // Merge in staged files from memory overlay and remove staged deletions
        const outSet = new Set<string>();
        for (const line of lines) {
            const cleanPath = line.endsWith("/") ? line.slice(0, -1) : line;
            if (!this.deleted.has(this.norm(path.join(rel, cleanPath)))) {
                outSet.add(line);
            }
        }

        const relNorm = this.norm(rel);
        for (const stagedKey of this.overlay.keys()) {
            if (this.excluded(stagedKey)) continue;
            let subPath = "";
            if (relNorm === "" || relNorm === ".") {
                subPath = stagedKey;
            } else if (stagedKey.startsWith(relNorm + "/")) {
                subPath = stagedKey.slice(relNorm.length + 1);
            }
            if (subPath) {
                if (recursive) {
                    const parts = subPath.split("/");
                    let acc = "";
                    for (let i = 0; i < parts.length - 1; i++) {
                        acc += parts[i] + "/";
                        outSet.add(acc);
                    }
                    outSet.add(subPath);
                } else {
                    const firstSlash = subPath.indexOf("/");
                    if (firstSlash === -1) {
                        outSet.add(subPath);
                    } else {
                        outSet.add(subPath.slice(0, firstSlash + 1));
                    }
                }
            }
        }

        const out = [...outSet].sort().join("\n");
        this.tracker.log({
            type: "code_analysis",
            path: this.norm(rel),
            details: { after: out, toolName: "list_files" },
            status: "executed",
        });
        return out || "(empty)";
    }

    searchFiles(
        rootRel: string,
        globPattern: string,
        contentQuery?: string,
    ): string {
        this.assertNotExcluded(rootRel, "search_files");
        const rootAbs = this.resolveSafe(rootRel);
        if (!fs.existsSync(rootAbs))
            throw new Error(`search_files: root not found: ${rootRel}`);

        const results: string[] = [];
        const regexFromGlob = (g: string): RegExp => {
            const escaped = g
                .replace(/[.+^${}()|[\]\\]/g, "\\$&")
                .replace(/\*\*/g, "§§")
                .replace(/\*/g, "[^/\\\\]*")
                .replace(/§§/g, ".*")
                .replace(/\?/g, ".");
            return new RegExp(`^${escaped}$`, "i");
        };
        const nameRe = regexFromGlob(globPattern.replace(/\\/g, "/"));

        const walk = (dir: string) => {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, ent.name);
                const relP = path
                    .relative(this.config.codebasePath, full)
                    .split(path.sep)
                    .join("/");
                if (this.excluded(relP)) continue;
                if (ent.isDirectory()) walk(full);
                else if (nameRe.test(relP) || nameRe.test(ent.name)) {
                    if (contentQuery) {
                        if (!isProbablyTextFile(full)) continue;
                        const text = fs.readFileSync(full, "utf8");
                        if (!text.includes(contentQuery)) continue;
                    }
                    results.push(relP);
                }
            }
        };

        if (fs.statSync(rootAbs).isDirectory()) walk(rootAbs);
        else {
            const relP = path
                .relative(this.config.codebasePath, rootAbs)
                .split(path.sep)
                .join("/");
            results.push(relP);
        }

        // Include matching staged files from memory overlay
        const rootNorm = this.norm(rootRel);
        for (const stagedKey of this.overlay.keys()) {
            if (this.excluded(stagedKey)) continue;
            const inRoot = (rootNorm === "" || rootNorm === "." || stagedKey.startsWith(rootNorm + "/"));
            if (inRoot && (nameRe.test(stagedKey) || nameRe.test(path.basename(stagedKey)))) {
                if (contentQuery) {
                    const text = this.overlay.get(stagedKey) || "";
                    if (!text.includes(contentQuery)) continue;
                }
                results.push(stagedKey);
            }
        }

        const filtered = results.filter(p => !this.deleted.has(this.norm(p)));
        const out = [...new Set(filtered)].sort().join("\n");
        this.tracker.log({
            type: "code_analysis",
            path: this.norm(rootRel),
            details: { after: out || "(no matches)", toolName: "search_files" },
            status: "executed",
        });
        return out || "(no matches)";
    }

    analyzeCodebase(rootRel: string): string {
        const rootAbs = this.resolveSafe(rootRel);
        if (!fs.existsSync(rootAbs))
            throw new Error(`analyze_codebase: not found: ${rootRel}`);

        let files = 0;
        let dirs = 0;
        const walk = (dir: string) => {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, ent.name);
                const relP = path.relative(this.config.codebasePath, full);
                if (this.excluded(relP)) continue;
                if (ent.isDirectory()) {
                    dirs++;
                    walk(full);
                } else {
                    files++;
                }
            }
        };
        if (fs.statSync(rootAbs).isDirectory()) walk(rootAbs);
        else files = 1;

        const summary = `Files: ${files} | Directories: ${dirs}`;
        this.tracker.log({
            type: "code_analysis",
            path: this.norm(rootRel),
            details: { after: summary, toolName: "analyze_codebase" },
            status: "executed",
        });
        return summary;
    }

    queueShell(command: string): string {
        if (!this.config.tools.allowShellExecution)
            throw new Error("Shell execution disabled");
        const risk = classifyShellCommand(command);
        this.tracker.log({
            type: "tool_execute",
            path: "shell",
            details: { command, toolName: "execute_shell" },
            status: "pending",
            riskTier: risk.tier,
            riskReason: risk.reason,
            requiresTypedConfirmation: risk.requiresTypedConfirmation,
        });
        return `Shell queued: ${command}`;
    }


      skillRoots(): string[] {
    const extra =
      process.env.SKILLS_DIRS?.split(/[;]/)
        .map((s) => s.trim())
        .filter(Boolean) ?? [];
    return [
      ...extra,
      path.join(homedir(), ".cursor/skills-cursor"),
      path.join(homedir(), ".claude/skills"),
    ];
  }

    listSkills(): string {
    const lines: string[] = [];
    for (const root of this.skillRoots()) {
      if (!fs.existsSync(root)) continue;
      const walk = (dir: string) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) walk(full);
          else if (ent.name === "SKILL.md") lines.push(full);
        }
      };
      walk(root);
    }
    const out = lines.sort().join("\n");
    this.tracker.log({
      type: "code_analysis",
      path: "skills",
      details: { after: out || "(none)", toolName: "list_skills" },
      status: "executed",
    });
    return out || "(none)";
  }

    readSkill(skillPath: string): string {
    const abs = path.isAbsolute(skillPath)
      ? path.normalize(skillPath)
      : path.normalize(path.resolve(this.config.codebasePath, skillPath));
    const allowed = this.skillRoots().some((root) => {
      const r = path.resolve(root);
      return abs === r || abs.startsWith(r + path.sep);
    });
    if (!allowed) throw new Error("read_skill: outside skill roots");
    const text = fs.readFileSync(abs, "utf8");
    this.tracker.log({
      type: "code_analysis",
      path: abs,
      details: { after: text, toolName: "read_skill" },
      status: "executed",
    });
    return text;
  }

  async applyApprovedFromTracker(): Promise<{ errors: string[] }> {
    const errors: string[] = [];
    const all = [...this.tracker.getActions()];
    console.log(`🔍 [Debug] applyApprovedFromTracker: total actions in tracker: ${all.length}`);
    console.log(`🔍 [Debug] Action statuses: ${all.map(a => `${a.path}:${a.type}:${a.status}`).join(', ')}`);

    for (const a of all.filter(
      (x) => x.type === "folder_create" && x.status === "approved",
    )) {
      try {
        fs.mkdirSync(this.resolveSafe(a.path), { recursive: true });
      } catch (e) {
        errors.push(String(e));
      }
    }

    const fileOps = all
      .filter(
        (a) =>
          (a.type === "file_create" ||
            a.type === "file_modify" ||
            a.type === "file_delete") &&
          a.status === "approved",
      )
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    console.log(`🔍 [Debug] Approved file operations: ${fileOps.length}`);

    const lastByPath = new Map<string, ActionLog>();
    for (const a of fileOps) lastByPath.set(this.norm(a.path), a);

    console.log(`🔍 [Debug] Unique paths to write: ${lastByPath.size}`);

    for (const [p, a] of lastByPath) {
      try {
        if (a.type === "file_delete") {
          fs.rmSync(this.resolveSafe(p), { force: true });
          console.log(`🔍 [Debug] Deleted: ${p}`);
        } else {
          const target = this.resolveSafe(p);
          const contentLen = (a.details.after ?? "").length;
          console.log(`🔍 [Debug] Writing ${contentLen} chars to: ${target}`);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, a.details.after ?? "", "utf8");
          console.log(`🔍 [Debug] Successfully wrote: ${target}`);
        }
      } catch (e) {
        console.log(`🔍 [Debug] ERROR writing ${p}: ${e}`);
        errors.push(String(e));
      }
    }

    for (const a of all.filter(
      (x) => x.type === "tool_execute" && x.status === "approved",
    )) {
      const cmd = a.details.command;
      if (!cmd) continue;

      console.log(chalk.bold(`\n🚀 [Shell] Executing command: ${cmd}\n`));

      await new Promise<void>((resolve) => {
        const wasRaw = process.stdin.isRaw;
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
        }

        const child = spawn(cmd, {
          shell: true,
          cwd: this.config.codebasePath,
          stdio: "inherit",
        });

        child.on("exit", (code) => {
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(wasRaw);
          }
          if (code && code !== 0) {
            errors.push(`shell exit ${code}: ${cmd}`);
          }
          resolve();
        });

        child.on("error", (err) => {
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(wasRaw);
          }
          errors.push(`shell error: ${err.message}`);
          resolve();
        });
      });
    }

    return { errors };
  }

  editFile(rel: string, edits: Array<{ search: string; replace: string }>): string {
    if (!this.config.tools.allowFileModification) {
        throw new Error("File modification disabled");
    }
    this.assertNotExcluded(rel, "edit_file");

    const key = this.norm(rel);
    const originalContent = this.getEffectiveText(rel);
    if (originalContent === undefined) {
        throw new Error(`edit_file: file not found: ${rel}`);
    }

    let currentContent = originalContent.replace(/\r\n/g, "\n");

    // Apply each search-and-replace block one by one. Matching is a cascade:
    // exact string match first, then indentation-tolerant, then whitespace-
    // tolerant line matching, since models frequently reformat whitespace
    // even when the code they intend to match is otherwise identical.
    for (const edit of edits) {
        const searchStr = edit.search.replace(/\r\n/g, "\n");
        const replaceStr = edit.replace.replace(/\r\n/g, "\n");

        const exactOccurrences = currentContent.split(searchStr).length - 1;
        if (exactOccurrences === 1) {
            currentContent = currentContent.replace(searchStr, replaceStr);
            continue;
        }
        if (exactOccurrences > 1) {
            throw new Error(`Ambiguous match: search block appears multiple times in ${rel}`);
        }

        const contentLines = currentContent.split("\n");
        const searchLines = searchStr.split("\n");

        let matches = findLineWindowMatches(contentLines, searchLines, (l) => l.trim());
        let level = "indentation-tolerant";
        if (matches.length === 0) {
            matches = findLineWindowMatches(contentLines, searchLines, collapseWhitespace);
            level = "whitespace-tolerant";
        }

        if (matches.length === 0) {
            throw new Error(
                `Could not find search block in ${rel} (tried exact, indentation-tolerant, and whitespace-tolerant matching):\n${searchStr}`,
            );
        }
        if (matches.length > 1) {
            throw new Error(
                `Ambiguous match: search block matches ${matches.length} locations in ${rel} via ${level} matching. Add more surrounding context to disambiguate.`,
            );
        }

        const start = matches[0]!;
        const end = start + searchLines.length;
        const replaceLines = reindentReplacement(
            replaceStr.split("\n"),
            searchLines[0] ?? "",
            contentLines[start]!,
        );

        contentLines.splice(start, end - start, ...replaceLines);
        currentContent = contentLines.join("\n");
    }

    // Stage the modification using the existing overlay map
    this.overlay.set(key, currentContent);

    // Log the action to the tracker so diffs can be generated
    const risk = classifyFileMutation("file_modify", key, originalContent, currentContent);
    this.tracker.log({
        type: "file_modify",
        path: key,
        details: { before: originalContent, after: currentContent },
        status: "pending",
        riskTier: risk.tier,
        riskReason: risk.reason,
        requiresTypedConfirmation: risk.requiresTypedConfirmation,
    });

    return `Staged targeted edits for: ${key}`;
  }

  hasStagedMutations(): boolean {
    return this.overlay.size > 0 || this.deleted.size > 0;
  }

  /**
   * Returns list of relative paths currently staged in memory overlay
   */
  getStagedPaths(): string[] {
    return Array.from(this.overlay.keys());
  }

  /**
   * Returns a concise human-readable bulleted summary of staged uncommitted files
   * so LLMs and prompts know what uncommitted changes currently exist in RAM.
   */
  getStagedSummary(): string {
    const entries: string[] = [];
    for (const [key] of this.overlay.entries()) {
        const abs = this.resolveSafe(key);
        const existsOnDisk = fs.existsSync(abs);
        entries.push(`- ${key} (${existsOnDisk ? "modified" : "created"}, staged in memory overlay)`);
    }
    for (const key of this.deleted) {
        entries.push(`- ${key} (deleted, staged in memory overlay)`);
    }
    return entries.length > 0 ? entries.join("\n") : "None";
  }

  tempWriteStaged(): () => void {
    const backups = new Map<string, string | null>(); // null means file did not exist

    // 1. Back up and write overlay files
    for (const [rel, content] of this.overlay.entries()) {
        const abs = this.resolveSafe(rel);
        if (fs.existsSync(abs)) {
            backups.set(rel, fs.readFileSync(abs, "utf8"));
        } else {
            backups.set(rel, null);
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, "utf8");
    }

    // 2. Back up and handle deleted files
    for (const rel of this.deleted) {
        const abs = this.resolveSafe(rel);
        if (fs.existsSync(abs)) {
            backups.set(rel, fs.readFileSync(abs, "utf8"));
            fs.rmSync(abs, { force: true });
        }
    }

    // Return restore function
    return () => {
        // Restore deleted or modified files
        for (const [rel, original] of backups.entries()) {
            const abs = this.resolveSafe(rel);
            if (original === null) {
                if (fs.existsSync(abs)) {
                    fs.rmSync(abs, { force: true });
                }
            } else {
                fs.mkdirSync(path.dirname(abs), { recursive: true });
                fs.writeFileSync(abs, original, "utf8");
            }
        }
    };
  }

  async searchWeb(query: string): Promise<string> {
    const braveKey = process.env.BRAVE_SEARCH_API_KEY;
    const firecrawlKey = process.env.FIRECRAWL_API_KEY;

    if (braveKey) {
      try {
        const response = await fetch(
          `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`,
          {
            headers: {
              "Accept": "application/json",
              "Accept-Encoding": "gzip",
              "X-Subscription-Token": braveKey,
            },
          }
        );

        if (!response.ok) {
          throw new Error(`Brave Search API error: ${response.status} ${response.statusText}`);
        }

        const data: any = await response.json();
        const results = data.web?.results ?? [];
        if (results.length === 0) {
          return "No search results found.";
        }

        const formatted = results
          .slice(0, 5)
          .map((r: any, idx: number) => {
            return `[Result ${idx + 1}]
Title: ${r.title}
URL: ${r.url}
Snippet: ${r.description ?? "No description available."}`;
          })
          .join("\n\n");

        this.tracker.log({
          type: "code_analysis",
          path: "web_search",
          details: { after: formatted, toolName: "search_web" },
          status: "executed",
        });

        return formatted;
      } catch (err: any) {
        return `Error performing web search via Brave: ${err.message}`;
      }
    } else if (firecrawlKey) {
      try {
        const response = await fetch("https://api.firecrawl.dev/v1/search", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${firecrawlKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: query,
            limit: 5,
          }),
        });

        if (!response.ok) {
          throw new Error(`Firecrawl Search API error: ${response.status} ${response.statusText}`);
        }

        const data: any = await response.json();
        const results = data.data ?? [];
        if (results.length === 0) {
          return "No search results found.";
        }

        const formatted = results
          .map((r: any, idx: number) => {
            return `[Result ${idx + 1}]
Title: ${r.title ?? "No Title"}
URL: ${r.url}
Snippet: ${r.description ?? r.snippet ?? "No description available."}`;
          })
          .join("\n\n");

        this.tracker.log({
          type: "code_analysis",
          path: "web_search",
          details: { after: formatted, toolName: "search_web" },
          status: "executed",
        });

        return formatted;
      } catch (err: any) {
        return `Error performing web search via Firecrawl: ${err.message}`;
      }
    }

    return "Error: Neither BRAVE_SEARCH_API_KEY nor FIRECRAWL_API_KEY is configured in your .env file. Please add one of them to enable web search.";
  }

  async scrapePage(url: string): Promise<string> {
    const key = process.env.FIRECRAWL_API_KEY;
    if (!key) {
      return "Error: FIRECRAWL_API_KEY is not configured in your .env file. Please add it to enable web page scraping.";
    }

    try {
      const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: url,
          formats: ["markdown"],
        }),
      });

      if (!response.ok) {
        throw new Error(`Firecrawl Scrape API error: ${response.status} ${response.statusText}`);
      }

      const data: any = await response.json();
      if (!data.success || !data.data) {
        throw new Error(data.error ?? "Failed to scrape page successfully.");
      }

      const markdown = data.data.markdown ?? "No content returned.";

      this.tracker.log({
        type: "code_analysis",
        path: "web_scrape",
        details: { after: markdown, toolName: "scrape_page" },
        status: "executed",
      });

      return markdown;
    } catch (err: any) {
      return `Error scraping page via Firecrawl: ${err.message}`;
    }
  }

  rollbackActions(actionIds: string[]): void {
    const all = this.tracker.getActions();
    for (const id of actionIds) {
      const a = all.find(x => x.id === id);
      if (!a) continue;

      // Mark as rejected in tracker
      this.tracker.updateStatus(id, "rejected", false);

      // Revert overlays
      const key = this.norm(a.path);
      if (a.type === "file_create") {
        this.overlay.delete(key);
      } else if (a.type === "file_modify") {
        if (a.details.before !== undefined) {
          this.overlay.set(key, a.details.before);
        } else {
          this.overlay.delete(key);
        }
      } else if (a.type === "file_delete") {
        this.deleted.delete(key);
        if (a.details.before !== undefined) {
          this.overlay.set(key, a.details.before);
        }
      }
    }
  }

  clearStaging():void{
    this.overlay.clear()
    this.deleted.clear()
  }
}
