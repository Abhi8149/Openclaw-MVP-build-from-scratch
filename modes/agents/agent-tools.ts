import { tool } from "ai";
import { z } from "zod";
import type { ToolExecutor } from "./tool-executor";
import { generateRepoMap } from "../../utils/repo-map";
import { BrowserService } from "../../services/browser-service";

const browser = BrowserService.getInstance();

export function createAgentTool(executor: ToolExecutor) {
    return {
        read_file: tool({
            description: "Read a text from the workspace. Use a path relative to the project root",
            inputSchema: z.object({
                path: z.string().describe("Relative file path"),
            }),
            execute: async ({ path: p }) => executor.readFile(p)
        }),

        create_file: tool({
            description: "Stage creation of a new file (not written until the user approves)",
            inputSchema: z.object({
                path: z.string(),
                content: z.string()
            }),
            execute: async ({ path: p, content }) => executor.createFile(p, content),
        }),
        modify_file: tool({
            description: "Stage a full-file replacement for an existing file (pending approval)",
            inputSchema: z.object({
                path: z.string(),
                content: z.string().describe("Complete new file contents"),
            }),
            execute: async ({ path: p, content }) => executor.modifyFile(p, content),
        }),
        delete_file: tool({
            description: "Stage deletion of a file (pending approval).",
            inputSchema: z.object({
                path: z.string(),
            }),
            execute: async ({ path: p }) => executor.deleteFile(p),
        }),

        create_folder: tool({
            description:
                "Stage creation of a directory tree (pending approval). Uses mkdir -p on apply.",
            inputSchema: z.object({
                path: z.string().describe("Relative directory path"),
            }),
            execute: async ({ path: p }) => executor.createFolder(p),
        }),

        list_files: tool({
            description: "List files and directories under a path.",
            inputSchema: z.object({
                path: z.string(),
                recursive: z.boolean().optional().default(false),
            }),
            execute: async ({ path: p, recursive }) =>
                executor.listFiles(p, recursive),
        }),

        search_files: tool({
            description:
                'Find files matching a glob pattern (e.g. "*.ts", "**/*.md"). Optional content substring filter.',
            inputSchema: z.object({
                root: z.string().describe("Directory to search, relative to root"),
                pattern: z
                    .string()
                    .describe("Glob-like pattern using * and ** (forward slashes)"),
                content_contains: z.string().optional(),
            }),
            execute: async ({ root, pattern, content_contains }) =>
                executor.searchFiles(root, pattern, content_contains),
        }),

        analyze_codebase: tool({
            description:
                "Summarize structure: file counts, size, extensions. Read-only.",
            inputSchema: z.object({
                path: z.string().default("."),
            }),
            execute: async ({ path: p }) => executor.analyzeCodebase(p),
        }),

        execute_shell: tool({
            description:
                "Queue a shell command to run in the workspace after user approval. Use with care.",
            inputSchema: z.object({
                command: z.string().describe("Single command; runs with shell: true"),
            }),
            execute: async ({ command }) => executor.queueShell(command),
        }),

        list_skills: tool({
            description:
                "List absolute paths to SKILL.md files under configured skill directories (Cursor / Claude).",
            inputSchema: z.object({}),
            execute: async () => executor.listSkills(),
        }),

        read_skill: tool({
            description:
                "Read a SKILL.md file. Path must be absolute and under skill roots, or use a path returned by list_skills.",
            inputSchema: z.object({
                path: z.string(),
            }),
            execute: async ({ path: p }) => executor.readSkill(p),
        }),

        //new functions from my side
        edit_file: tool({
            description: "Make targeted edits to a file using search and replace blocks.",
            inputSchema: z.object({
                path: z.string().describe("Relative path of the file"),
                edits: z.array(z.object({
                    search: z.string().describe("The exact block of code to find (must match exactly including spacing)"),
                    replace: z.string().describe("The block of code to replace it with")
                })).min(1)
            }),
            execute: async ({ path: p, edits }) => executor.editFile(p, edits)
        }),

        get_repo_map: tool({
            description: "Get a map of all files and top-level exported functions in the project.",
            inputSchema: z.object({}),
            execute: async () => generateRepoMap(executor.config.codebasePath, executor.config.excludePatterns)
        }),

        search_web: tool({
            description: "Search the web using Brave Search for documentation, libraries, code examples, or syntax help when local workspace information is insufficient.",
            inputSchema: z.object({
                query: z.string().describe("The search query"),
            }),
            execute: async ({ query }) => executor.searchWeb(query)
        }),

        scrape_page: tool({
            description: "Scrape the complete text content of a specific public URL into clean Markdown using Firecrawl.",
            inputSchema: z.object({
                url: z.string().url().describe("The full public URL of the web page to scrape"),
            }),
            execute: async ({ url }) => executor.scrapePage(url)
        }),

        // Browser tools
        browser_navigate: tool({
            description: "Navigate the active browser to a URL (e.g. 'https://github.com' or 'web.whatsapp.com').",
            inputSchema: z.object({
                url: z.string().describe("The full web URL to navigate to"),
            }),
            execute: async ({ url }) => {
                return await browser.navigate(url);
            },
        }),

        browser_snapshot: tool({
            description: "Inspect the current web page. Returns the page title, URL, readable summary text, and a numbered list of interactive elements [ref=1, ref=2] with their names and input values.",
            inputSchema: z.object({}),
            execute: async () => {
                const snapshot = await browser.getSnapshot();

                // Format into an easily parseable LLM-friendly block
                const elementsFormatted = snapshot.elements
                    .map(e => `[ref=${e.ref}] <${e.tag}> role="${e.role}" name="${e.name}"${e.value ? ` value="${e.value}"` : ""}`)
                    .join("\n");

                return [
                    `Page URL: ${snapshot.url}`,
                    `Page Title: ${snapshot.title}`,
                    `\n--- Interactive Elements on Page ---`,
                    elementsFormatted || "(No clickable or input elements detected)",
                    `\n--- Page Text Content (Excerpt) ---`,
                    snapshot.summaryText || "(Empty body)",
                ].join("\n");
            }
        }),


        browser_click: tool({
            description: "Click an interactive element on the current page using its [ref=X] number from browser_snapshot or a CSS selector.",
            inputSchema: z.object({
                ref: z.number().describe("The reference number [ref=X] obtained from the latest browser_snapshot"),
            }),
            execute: async ({ ref }) => {
                return await browser.click(ref);
            },
        }),

        browser_fill: tool({
            description: "Type text into an input field or textarea on the page using its [ref=X] number from browser_snapshot.",
            inputSchema: z.object({
                ref: z.number().describe("The reference number [ref=X] of the input field"),
                text: z.string().describe("The text string to type into the input"),
            }),
            execute: async ({ ref, text }) => {
                return await browser.fill(ref, text);
            },
        }),

        browser_press_key: tool({
            description: "Simulate pressing a keyboard key such as 'Enter', 'Tab', 'Escape', 'ArrowDown'.",
            inputSchema: z.object({
                key: z.string().describe("The key name to press (e.g. 'Enter', 'Escape')"),
            }),
            execute: async ({ key }) => {
                return await browser.pressKey(key);
            },
        }),

        browser_screenshot: tool({
            description: "Take a visual PNG screenshot of the current browser viewport and save it locally.",
            inputSchema: z.object({
                outputPath: z.string().optional().describe("Optional path where the PNG will be saved"),
            }),
            execute: async ({ outputPath }) => {
                return await browser.takesScreenshot(outputPath);
            },
        }),
    }
}