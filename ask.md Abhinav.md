# Ask Mode

## Question

Create a short summary and project structure of current folder openclaw

## Answer

Here's a short summary and the project structure of the **openclaw** folder.

## Summary

**openclaw** (CLI name: `AbhiClaw`) is a Bun/TypeScript AI-powered command-line assistant. It uses the Vercel AI SDK (`ai`) with an OpenRouter model provider to drive an agent, and `@clack/prompts` + `chalk` + `figlet` for an interactive terminal UI.

The tool launches with a banner and lets you pick a mode, then drills into three workflows:

- **Agent mode** – a `ToolLoopAgent` that can read/search/analyze files, create/modify/delete files, create folders, run shell commands, and read AI "skills." All mutations are **staged** and require a user **approval flow** before being applied.
- **Plan mode** – first drafts a structured plan (JSON-schema-validated, 1–15 steps) using read-only + optional web research, lets the user pick which steps to run, then executes them with the same staged/approve safety model.
- **Ask mode** – a strictly read-only Q&A agent (plus optional web tools) that can save its answer to a local `.md` file.

Web capabilities come from Firecrawl (`@mendable/firecrawl-js`) when `FIRECRAWL_API_KEY` is set. Common concerns are centralized: model config in `ai/`, terminal markdown rendering in `tui/`, the staged-action safety layer (`ToolExecutor` + `ActionTracker` + `approval`) in `modes/agents/`.

## Project Structure

```
openclaw/
├── index.ts                  # Entry point (commander CLI: `wakeup` command)
├── package.json              # Bun/TS project, deps: ai, @openrouter, clack, chalk, firecrawl, marked...
├── tsconfig.json
├── bun.lock
├── README.md
├── hello.txt
├── .gitignore
│
├── ai/                       # AI model setup
│   ├── ai.config.ts          # getAgentModel() -> OpenRouter provider (env: OPENROUTER_API_KEY, OPENROUTER_MODEL)
│   └── index.ts              # re-export
│
├── tui/                      # Terminal UI helpers
│   ├── runWakeup.ts          # Figlet banner + select CLI / Telegram / Exit
│   └── terminal-md.ts        # Markdown -> terminal renderer (marked + marked-terminal)
│
└── modes/
    ├── cli.ts                # Sub-mode menu: Agent / Plan / Ask
    │
    ├── agents/               # Core agent + safety layer
    │   ├── orchestrator.ts   # runAgentMode(): ToolLoopAgent (stepCountIs 40) + approval
    │   ├── agent-tools.ts    # createAgentTool(): read/create/modify/delete file, folder, shell, search, skills
    │   ├── tool-executor.ts  # ToolExecutor: staging, path safety, apply-approved mutations
    │   ├── action-tracker.ts # ActionTracker: logs staged/approved/rejected actions
    │   ├── approval.ts       # runApprovalFlow(): prompts user to approve staged actions
    │   ├── diff-view.ts      # diff rendering for approvals
    │   └── types.ts          # ActionType, AgentConfig, defaultAgentConfig()
    │
    ├── ask/                  # Read-only Q&A mode
    │   └── orchestrator.ts   # runAskMode(): read-only tools + web, optional save answer to .md
    │
    └── plan/                 # Plan-first mode
        ├── orchestrator.ts   # runPlanMode(): generate plan, select steps, execute w/ approval
        ├── planner.ts        # generatePlan(): research + JSON-schema plan via wrapped model
        ├── selection.ts      # printPlan(), selectSteps()
        ├── web-tool.ts       # createWebTools(): web_search / web_crawl / fetch_url (Firecrawl)
        └── types.ts          # Plan, Planstep types
```

**Key design themes:** staged mutations with human-in-the-loop approval, path-exclusion safety (`node_modules`, `.git`, `.env*`, etc.), read-only enforcement in Ask/Plan modes, and optional web research tooling.
