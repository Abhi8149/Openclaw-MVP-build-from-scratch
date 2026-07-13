import { text, isCancel, confirm } from '@clack/prompts';
import chalk from 'chalk';
import { defaultAgentConfig } from '../agents/types';
import { ActionTracker } from '../agents/action-tracker';
import { ToolExecutor } from '../agents/tool-executor';
import { renderTerminalMarkdown } from '../../tui/terminal-md';
import { stepCountIs, ToolLoopAgent, tool } from 'ai';
import { getAgentModel } from '../../ai';
import {z} from "zod";
import { runApprovalFlow } from '../agents/approval';
import { createWebTools } from '../plan/web-tool';


export function createAskTools(executor: ToolExecutor) {
  return {
    read_file: tool({
      description:
        "Read a text file from the workspace. Use a path relative to the project root.",
      inputSchema: z.object({
        path: z.string().describe("Relative file path"),
      }),
      execute: async ({ path: p }) => executor.readFile(p),
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
  };
}

function askMd(question: string, answer: string): string {
  return `# Ask Mode\n\n## Question\n\n${question.trim()}\n\n## Answer\n\n${answer.trim()}\n`;
}
/**
 * Ask Mode — Continuous Q&A Chat Loop
 * 
 * Previously this function handled a single question and returned, forcing
 * the user back to mode selection. Now it enters a while(true) loop where
 * the user can ask multiple questions in sequence.
 * 
 * Features:
 * - /exit leaves Ask mode
 * - Each answer can optionally be saved to a .md file
 * - Config, tracker, and tools are created once and shared across all questions
 */
export async function runAskMode(){
  console.log(chalk.bold('\n❓ Ask Mode — Continuous Q&A'));
  console.log(chalk.dim('  Type /exit to leave Ask mode.\n'));

    // Configure the AI to be strictly READ-ONLY (created once, shared across all questions)
    const config = defaultAgentConfig();
    config.tools.allowShellExecution = false;
    config.tools.allowFileModification = false;
    config.tools.allowFolderCreation = false;
    config.tools.allowFileCreation = true; 

    const tracker = new ActionTracker();
    const executor = new ToolExecutor(tracker, config);

    const tools={
        ...createAskTools(executor),
        ...createWebTools(tracker)
    };

    let isFirstPrompt = true;

    while (true) {
        // Get the user's question
        const question = await text({
            message: isFirstPrompt ? 'What do you want to ask?' : '💬 Next question?',
            placeholder: isFirstPrompt ? undefined : ' Ask another question or type /exit...',
        });

        if (isCancel(question) || !question) break;

        const trimmedQuestion = question.trim();
        if (!trimmedQuestion) continue;

        // Slash command: /exit
        if (trimmedQuestion.toLowerCase() === '/exit') break;

        isFirstPrompt = false;

        // Run the agent to answer the question
        const agent = new ToolLoopAgent({
            model: getAgentModel(),
            stopWhen: stepCountIs(20),
            tools,
        });

        const result = await agent.generate({ prompt: trimmedQuestion });
        const answer = result.text?.trim() || "(no answer)";
        console.log("\n" + renderTerminalMarkdown(answer) + "\n");

        // Optionally save the answer to a .md file
        const wantSave = await confirm({
            message: "Save this answer to a .md file in the current directory?",
            initialValue: false,
        });

        if (isCancel(wantSave) || !wantSave) continue;

        const filename = await text({
            message: "Filename",
            initialValue: "ask.md",
            validate: (v) => {
                const s = (v ?? '').trim();
                if (!s) return "Required";
                if (s.includes('..') || s.includes('/') || s.includes('\\')) return 'No paths';
                if (!s.toLocaleLowerCase().endsWith('.md')) return "Must end with .md";
            }
        });

        if (isCancel(filename)) continue;

        const trimmedFilename = filename.trim();
        executor.createFile(trimmedFilename, askMd(trimmedQuestion, answer));
        const ok = await runApprovalFlow(tracker);
        if (!ok) {
            executor.clearStaging();
            continue;
        }

        executor.applyApprovedFromTracker();
        executor.clearStaging();
    }

    console.log(chalk.dim('\n👋 Left Ask Mode.\n'));
}
