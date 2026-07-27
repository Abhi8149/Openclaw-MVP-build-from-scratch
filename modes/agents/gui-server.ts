import http from "node:http";
import { EventEmitter } from "node:events";
import { generateCodebaseGraph } from "../../utils/graph-scanner";

/**
 * Interface representing the synchronized state of the local agent GUI.
 */
export interface GuiState {
    goal: string;
    status: "idle" | "running" | "waiting_approval" | "success" | "failed";
    attempts: number;
    maxAttempts: number;
    budgetUsed: number;
    maxBudget: number;
    totalTokens: { input: number; output: number };
    logs: string[];
    stagedGroups: Array<{
        label: string;
        tier: string;
        reason: string;
        patch: string | null;
    }>;
    messages: Array<{
        sender: "user" | "agent";
        text: string;
        timestamp: string;
        tokens?: { input: number; output: number };
        cost?: number;
    }>;
    pinnedFiles: string[];
    graphMatchedFiles: string[];
}

export class GuiServer extends EventEmitter {
    private server: http.Server | null = null;
    private clients: http.ServerResponse[] = [];
    private pendingApprovalResolver: ((approved: boolean) => void) | null = null;
    private pendingGoalResolver: ((goal: string) => void) | null = null;
    private state: GuiState = {
        goal: "",
        status: "idle",
        attempts: 0,
        maxAttempts: 3,
        budgetUsed: 0.0,
        maxBudget: 1.0,
        totalTokens: { input: 0, output: 0 },
        logs: [],
        stagedGroups: [],
        messages: [],
        pinnedFiles: [],
        graphMatchedFiles: [],
    };

    constructor() {
        super();
    }

    public start(port = 8000): Promise<string> {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => {
                const url = req.url ?? "";
                const method = req.method ?? "GET";
                const pathname = url.split("?")[0] || "/";

                // Serve Web Dashboard
                if (pathname === "/" || pathname === "/index.html") {
                    res.writeHead(200, { "Content-Type": "text/html" });
                    res.end(this.getHtmlContent());
                    return;
                }

                // Server-Sent Events Endpoint
                if (pathname === "/events") {
                    res.writeHead(200, {
                        "Content-Type": "text/event-stream",
                        "Cache-Control": "no-cache",
                        "Connection": "keep-alive",
                        "X-Accel-Buffering": "no",
                    });
                    res.write(`data: ${JSON.stringify({ type: "init", state: this.state })}\n\n`);
                    this.clients.push(res);

                    const heartbeat = setInterval(() => {
                        res.write(":\n\n"); // Heartbeat comment to keep connection alive
                    }, 10000);

                    req.on("close", () => {
                        clearInterval(heartbeat);
                        this.clients = this.clients.filter((c) => c !== res);
                    });
                    return;
                }

                // API: Submit prompt
                if (pathname === "/api/prompt" && method === "POST") {
                    let body = "";
                    req.on("data", (chunk) => {
                        body += chunk.toString();
                    });
                    req.on("end", () => {
                        try {
                            const data = JSON.parse(body);
                            const promptText = data.prompt ?? "";
                            res.writeHead(200, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ success: true }));

                            if (this.pendingGoalResolver && promptText.trim()) {
                                this.updateState((s) => {
                                    s.messages.push({
                                        sender: "user",
                                        text: promptText,
                                        timestamp: new Date().toLocaleTimeString(),
                                    });
                                    s.goal = promptText;
                                    s.status = "running";
                                    s.stagedGroups = [];
                                });
                                this.pendingGoalResolver(promptText);
                                this.pendingGoalResolver = null;
                            }
                        } catch (err) {
                            res.writeHead(400, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ success: false, error: String(err) }));
                        }
                    });
                    return;
                }

                // API: Approve staged changes
                if (pathname === "/api/approve" && method === "POST") {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ success: true }));
                    if (this.pendingApprovalResolver) {
                        this.pendingApprovalResolver(true);
                        this.pendingApprovalResolver = null;
                    }
                    return;
                }

                // API: Reject staged changes
                if (pathname === "/api/reject" && method === "POST") {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ success: true }));
                    if (this.pendingApprovalResolver) {
                        this.pendingApprovalResolver(false);
                        this.pendingApprovalResolver = null;
                    }
                    return;
                }

                // API: Toggle file pinning in context
                if (pathname === "/api/context/pin" && method === "POST") {
                    let body = "";
                    req.on("data", (chunk) => {
                        body += chunk.toString();
                    });
                    req.on("end", () => {
                        try {
                            const data = JSON.parse(body);
                            const filePath = data.path ?? "";
                            const isPin = !!data.pin;

                            if (filePath) {
                                this.updateState((s) => {
                                    if (isPin) {
                                        if (!s.pinnedFiles.includes(filePath)) {
                                            s.pinnedFiles.push(filePath);
                                        }
                                    } else {
                                        s.pinnedFiles = s.pinnedFiles.filter((p) => p !== filePath);
                                    }
                                });
                            }

                            res.writeHead(200, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ success: true, pinnedFiles: this.state.pinnedFiles }));
                        } catch (err) {
                            res.writeHead(400, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ success: false, error: String(err) }));
                        }
                    });
                    return;
                }

                // API: Fetch Codebase Dependency Graph
                if (pathname === "/api/graph" && method === "GET") {
                    try {
                        const codebasePath = process.cwd();
                        const excludePatterns = [
                            "node_modules", ".git", ".claude", ".openclaw-embeddings.json",
                            "agent-index.db*",
                            "dist", "build", ".next", "*.log", ".env*"
                        ];
                        const graph = generateCodebaseGraph(codebasePath, excludePatterns);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify(graph));
                    } catch (err) {
                        res.writeHead(500, { "Content-Type": "text/plain" });
                        res.end(`Failed to generate codebase graph: ${String(err)}`);
                    }
                    return;
                }

                // Not found fallback
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("Not Found");
            });

            this.server.on("error", (err) => reject(err));
            this.server.listen(port, "127.0.0.1", () => {
                resolve(`http://127.0.0.1:${port}`);
            });
        });
    }

    public updateState(updater: (s: GuiState) => void) {
        updater(this.state);
        this.broadcast({ type: "update", state: this.state });
    }

    public waitForGoal(): Promise<string> {
        this.updateState((s) => {
            s.status = "idle";
            s.stagedGroups = [];
        });
        return new Promise((resolve) => {
            this.pendingGoalResolver = resolve;
        });
    }

    public addAgentMessage(text: string, meta?: { tokens?: { input: number; output: number }; cost?: number }) {
        this.updateState((s) => {
            s.messages.push({
                sender: "agent",
                text,
                timestamp: new Date().toLocaleTimeString(),
                tokens: meta?.tokens,
                cost: meta?.cost,
            });
            if (meta?.tokens) {
                s.totalTokens.input += meta.tokens.input;
                s.totalTokens.output += meta.tokens.output;
            }
        });
    }

    public waitForUserApproval(): Promise<boolean> {
        this.updateState((s) => {
            s.status = "waiting_approval";
        });
        return new Promise((resolve) => {
            this.pendingApprovalResolver = resolve;
        });
    }

    public getPinnedFiles(): string[] {
        return this.state.pinnedFiles;
    }

    public setGraphMatchedFiles(files: string[]) {
        this.updateState((s) => {
            s.graphMatchedFiles = files;
        });
    }

    public stop() {
        for (const client of this.clients) {
            client.end();
        }
        this.clients = [];
        if (this.server) {
            this.server.close();
        }
    }

    public broadcastStreamChunk(chunk: string, isStart: boolean) {
        this.broadcast({
            type: "stream_chunk",
            chunk,
            isStart,
        });
    }

    public finalizeStreamMessage() {
        this.broadcast({
            type: "stream_end"
        });
    }

    private broadcast(msg: any) {
        const payload = JSON.stringify(msg);
        for (const client of this.clients) {
            client.write(`data: ${payload}\n\n`);
        }
    }

    private getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OpenClaw Web GUI Console</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
    <script src="https://unpkg.com/lucide@latest"></script>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
        body {
            font-family: 'Plus Jakarta Sans', sans-serif;
            background: linear-gradient(135deg, #090615 0%, #020204 100%);
        }
        .mono {
            font-family: 'JetBrains Mono', monospace;
        }
        .glass {
            background: rgba(18, 12, 32, 0.7);
            backdrop-filter: blur(14px);
            border: 1px solid rgba(255, 255, 255, 0.08);
        }
        .diff-added {
            background-color: rgba(34, 197, 94, 0.15);
            color: #4ade80;
        }
        .diff-removed {
            background-color: rgba(239, 68, 68, 0.15);
            color: #f87171;
        }
        .loading-pulse {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background-color: #a855f7;
            animation: pulse-jump 1.4s infinite ease-in-out both;
        }
        .loading-pulse:nth-child(2) {
            animation-delay: 0.2s;
        }
        .loading-pulse:nth-child(3) {
            animation-delay: 0.4s;
        }
        @keyframes pulse-jump {
            0%, 80%, 100% { transform: translateY(0); }
            40% { transform: translateY(-6px); }
        }

        /* Markdown body styling for chat bubbles to look visually premium */
        .markdown-body {
            font-size: 0.875rem;
            line-height: 1.625;
        }
        .markdown-body p {
            margin-bottom: 0.75rem;
        }
        .markdown-body p:last-child {
            margin-bottom: 0;
        }
        .markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 {
            font-weight: 700;
            color: #f1f5f9;
            margin-top: 1.25rem;
            margin-bottom: 0.5rem;
        }
        .markdown-body h1 { font-size: 1.25rem; }
        .markdown-body h2 { font-size: 1.125rem; }
        .markdown-body h3 { font-size: 1rem; }
        .markdown-body h4 { font-size: 0.875rem; }
        .markdown-body ul {
            list-style-type: disc;
            padding-left: 1.25rem;
            margin-bottom: 0.75rem;
        }
        .markdown-body ol {
            list-style-type: decimal;
            padding-left: 1.25rem;
            margin-bottom: 0.75rem;
        }
        .markdown-body li {
            margin-bottom: 0.25rem;
        }
        .markdown-body code {
            font-family: 'JetBrains Mono', monospace;
            background-color: rgba(255, 255, 255, 0.08);
            color: #e2e8f0;
            padding: 0.125rem 0.25rem;
            border-radius: 0.25rem;
            font-size: 0.8125rem;
        }
        .markdown-body pre {
            background-color: #05050a;
            border: 1px solid rgba(255, 255, 255, 0.05);
            padding: 0.875rem;
            border-radius: 0.75rem;
            overflow-x: auto;
            margin-top: 0.75rem;
            margin-bottom: 0.75rem;
        }
        .markdown-body pre code {
            background-color: transparent;
            padding: 0;
            border-radius: 0;
            color: #cbd5e1;
        }
        .markdown-body a {
            color: #a855f7;
            text-decoration: underline;
        }
        .markdown-body a:hover {
            color: #c084fc;
        }
        .markdown-body blockquote {
            border-left: 4px solid #a855f7;
            padding-left: 1rem;
            color: #94a3b8;
            font-style: italic;
            margin-bottom: 0.75rem;
        }
        .markdown-body hr {
            border-color: rgba(255, 255, 255, 0.08);
            margin: 1rem 0;
        }
        .markdown-body table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 0.75rem;
            font-size: 0.8125rem;
        }
        .markdown-body th, .markdown-body td {
            border: 1px solid rgba(255, 255, 255, 0.08);
            padding: 0.5rem;
            text-align: left;
        }
        .markdown-body th {
            background-color: rgba(255, 255, 255, 0.04);
            color: #f1f5f9;
        }
    </style>
</head>
<body class="text-slate-100 min-h-screen flex flex-col">
    <!-- Header -->
    <header class="glass sticky top-0 z-50 px-6 py-4 flex items-center justify-between border-b border-purple-950/40">
        <div class="flex items-center gap-3">
            <div class="bg-gradient-to-tr from-purple-600 to-indigo-500 p-2.5 rounded-xl text-white shadow-lg shadow-purple-500/25">
                <i data-lucide="terminal" class="w-6 h-6"></i>
            </div>
            <div>
                <h1 class="text-xl font-bold tracking-tight bg-gradient-to-r from-purple-400 to-indigo-300 bg-clip-text text-transparent">AbhiClaw Web Console</h1>
                <p class="text-xs text-slate-400">Interactive browser agent workspace</p>
            </div>
        </div>

        <div class="flex items-center gap-6">
            <!-- Total Tokens -->
            <div class="flex items-center gap-3 px-4 py-2 rounded-xl bg-slate-950/60 border border-slate-900">
                <div class="text-right">
                    <p class="text-[10px] uppercase tracking-wider text-slate-500">Total Tokens</p>
                    <p class="text-sm font-bold text-purple-300 font-mono" id="tokens-value">In: 0 | Out: 0</p>
                </div>
                <div class="w-8 h-8 rounded-full bg-purple-500/10 flex items-center justify-center text-purple-400">
                    <i data-lucide="cpu" class="w-4.5 h-4.5"></i>
                </div>
            </div>

            <!-- Budget status -->
            <div class="flex items-center gap-3 px-4 py-2 rounded-xl bg-slate-950/60 border border-slate-900">
                <div class="text-right">
                    <p class="text-[10px] uppercase tracking-wider text-slate-500">LLM Budget Used</p>
                    <p class="text-sm font-bold text-indigo-300 font-mono" id="budget-value">$0.00 / $1.00</p>
                </div>
                <div class="w-8 h-8 rounded-full bg-indigo-500/10 flex items-center justify-center text-indigo-400">
                    <i data-lucide="dollar-sign" class="w-4.5 h-4.5"></i>
                </div>
            </div>

            <!-- Agent status badge -->
            <div class="flex items-center gap-2.5 px-4 py-2 rounded-full border border-slate-800 bg-slate-950/60" id="status-badge">
                <span class="w-2.5 h-2.5 rounded-full bg-slate-500" id="status-dot"></span>
                <span class="text-xs font-bold uppercase tracking-wider" id="status-text">Idle</span>
            </div>
        </div>
    </header>

    <!-- Main Workspace -->
    <main class="flex-1 max-w-[1700px] w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 overflow-hidden">
        <!-- Left Column: Claude-like Chat Panel -->
        <div class="lg:col-span-6 flex flex-col gap-6 overflow-hidden">
            <!-- Chat Card -->
            <div class="glass flex-1 rounded-2xl flex flex-col overflow-hidden h-[600px] min-h-[500px]">
                <div class="px-5 py-4 border-b border-slate-800/80 flex items-center justify-between">
                    <h3 class="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                        <i data-lucide="messages-square" class="w-4 h-4"></i> Conversation
                    </h3>
                </div>

                <!-- Message stream -->
                <div class="flex-1 p-5 overflow-y-auto space-y-4 bg-slate-950/20" id="chat-messages">
                    <!-- Placeholder initial message -->
                    <div class="flex gap-3">
                        <div class="w-8 h-8 rounded-full bg-purple-600/20 border border-purple-500/30 flex items-center justify-center text-purple-400">
                            <i data-lucide="bot" class="w-4 h-4"></i>
                        </div>
                        <div class="flex-1 bg-slate-900/60 border border-slate-800/80 rounded-2xl px-4 py-3 max-w-[85%] text-slate-200 text-sm">
                            Hello! I am your AI coding agent. Enter a prompt below to tell me what to do on this codebase.
                        </div>
                    </div>
                </div>

                <!-- Thinking indicator -->
                <div id="thinking-indicator" class="px-6 py-3 flex items-center gap-3 bg-slate-950/30 border-t border-slate-900 hidden">
                    <div class="flex gap-1">
                        <span class="loading-pulse"></span>
                        <span class="loading-pulse"></span>
                        <span class="loading-pulse"></span>
                    </div>
                    <span class="text-xs text-purple-400 italic">Agent is thinking and processing files...</span>
                </div>

                <!-- Input box -->
                <div class="p-4 border-t border-slate-800/80 bg-slate-950/50">
                    <form id="chat-form" class="flex gap-3">
                        <input type="text" id="chat-input" placeholder="Tell the agent what to build or fix..." class="flex-1 px-4 py-3 rounded-xl bg-slate-900 border border-slate-800 focus:outline-none focus:border-purple-500 text-sm text-slate-100 placeholder-slate-500" required>
                        <button type="submit" id="send-btn" class="px-5 py-3 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-semibold text-sm shadow-md transition-all flex items-center justify-center">
                            <i data-lucide="send" class="w-4 h-4"></i>
                        </button>
                    </form>
                </div>
            </div>
        </div>

        <!-- Right Column: Staged Changes / Codebase Graph -->
        <div class="lg:col-span-6 flex flex-col gap-6 overflow-hidden">
            <div class="glass flex-1 rounded-2xl flex flex-col overflow-hidden h-[600px] min-h-[500px]">
                <div class="px-5 py-4 border-b border-slate-800/80 flex items-center justify-between">
                    <div class="flex items-center gap-4">
                        <button id="tab-diffs" class="text-xs font-bold uppercase tracking-wider text-purple-400 border-b-2 border-purple-500 pb-1 flex items-center gap-2 focus:outline-none">
                            <i data-lucide="shield-check" class="w-4 h-4"></i> Staged Diffs
                        </button>
                        <button id="tab-graph" class="text-xs font-bold uppercase tracking-wider text-slate-400 hover:text-slate-200 pb-1 flex items-center gap-2 focus:outline-none">
                            <i data-lucide="network" class="w-4 h-4"></i> Codebase Graph
                        </button>
                    </div>
                    <span class="text-xs text-slate-400" id="attempt-badge">Attempt: 0/3</span>
                </div>

                <!-- Diffs Content View -->
                <div id="diffs-view" class="flex-1 flex flex-col overflow-hidden">
                    <div class="flex-1 p-6 overflow-y-auto space-y-6" id="staged-container">
                        <div class="text-center py-16 text-slate-400 flex flex-col items-center justify-center gap-4">
                            <i data-lucide="file-code-2" class="w-14 h-14 text-slate-700"></i>
                            <p class="text-sm">Wait for agent turn execution to inspect proposed modifications.</p>
                        </div>
                    </div>

                    <!-- Approval Actions Bar -->
                    <div class="p-5 border-t border-slate-800/80 bg-slate-950/50 flex items-center justify-end gap-3 hidden" id="action-bar">
                        <button onclick="decide('reject')" class="px-5 py-2.5 rounded-xl border border-red-500/20 bg-red-500/10 hover:bg-red-500/20 text-red-400 font-semibold text-sm transition-all flex items-center gap-2">
                            <i data-lucide="x" class="w-4 h-4"></i> Reject
                        </button>
                        <button onclick="decide('approve')" class="px-6 py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-semibold text-sm shadow-lg shadow-purple-500/20 transition-all flex items-center gap-2">
                            <i data-lucide="check" class="w-4 h-4"></i> Approve & Apply
                        </button>
                    </div>
                </div>

                <!-- Codebase Graph View -->
                <div id="graph-view" class="flex-1 hidden flex flex-col overflow-hidden relative">
                    <div class="absolute top-3 left-3 z-10 flex gap-2 text-[10px] text-slate-300 bg-slate-950/80 px-3 py-2 rounded-xl border border-slate-800">
                        <span class="flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-full bg-emerald-500"></span> GraphRAG</span>
                        <span class="flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-full bg-indigo-500"></span> Pinned</span>
                        <span class="flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-full bg-slate-500"></span> Unloaded</span>
                    </div>
                    <div id="graph-canvas" class="flex-1 w-full h-full bg-slate-950/40"></div>
                </div>
            </div>
        </div>
    </main>

    <!-- Footer -->
    <footer class="text-center py-4 text-xs text-slate-500 border-t border-slate-950 bg-slate-950">
        AbhiClaw CLI Tool Dashboard · Running Locally (127.0.0.1)
    </footer>

    <script>
        function renderIcons() {
            if (typeof lucide !== "undefined" && lucide.createIcons) {
                try {
                    lucide.createIcons();
                } catch (e) {
                    console.error("Lucide rendering failed:", e);
                }
            }
        }
        renderIcons();

        let currentMessagesCount = 0;
        let currentLogsCount = 0;

        const chatMessages = document.getElementById("chat-messages");
        const chatForm = document.getElementById("chat-form");
        const chatInput = document.getElementById("chat-input");
        const sendBtn = document.getElementById("send-btn");
        const budgetVal = document.getElementById("budget-value");
        const statusBadge = document.getElementById("status-badge");
        const statusDot = document.getElementById("status-dot");
        const statusText = document.getElementById("status-text");
        const attemptBadge = document.getElementById("attempt-badge");
        const stagedContainer = document.getElementById("staged-container");
        const actionBar = document.getElementById("action-bar");
        const thinkingIndicator = document.getElementById("thinking-indicator");
        const tokensVal = document.getElementById("tokens-value");

        chatForm.addEventListener("submit", (e) => {
            e.preventDefault();
            const text = chatInput.value.trim();
            if (!text) return;

            chatInput.disabled = true;
            sendBtn.disabled = true;
            chatInput.value = "";

            fetch("/api/prompt", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ prompt: text })
            })
            .catch(err => {
                alert("Prompt submission failed: " + err);
                chatInput.disabled = false;
                sendBtn.disabled = false;
            });
        });

        function decide(choice) {
            fetch(\`/api/\${choice}\`, { method: "POST" })
                .then(r => r.json())
                .then(data => {
                    console.log("Decision submitted", choice);
                })
                .catch(err => {
                    alert("Decision failed: " + err);
                });
        }

        function escapeHtml(text) {
            return text
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        }

        function getFilename(fullPath) {
            if (!fullPath) return "file";
            const parts = fullPath.split("/");
            const lastPart = parts[parts.length - 1];
            return lastPart.split("\\\\").pop() || "file";
        }

        function getFriendlyLog(line) {
            if (line.includes("✓ create_file")) {
                const match = line.match(/"TargetFile":"([^"]+)"/) || line.match(/"path":"([^"]+)"/);
                const file = match ? getFilename(match[1]) : "file";
                return \`<span class="text-emerald-400">📁 Created file:</span> <b>\${file}</b>\`;
            }
            if (line.includes("✓ edit_file") || line.includes("✓ replace_file_content") || line.includes("✓ multi_replace_file_content")) {
                const match = line.match(/"TargetFile":"([^"]+)"/) || line.match(/"path":"([^"]+)"/);
                const file = match ? getFilename(match[1]) : "file";
                return \`<span class="text-indigo-400">📝 Updated file:</span> <b>\${file}</b>\`;
            }
            if (line.includes("✓ view_file") || line.includes("✓ read_file")) {
                const match = line.match(/"AbsolutePath":"([^"]+)"/) || line.match(/"path":"([^"]+)"/);
                const file = match ? getFilename(match[1]) : "file";
                return \`<span class="text-sky-400">📖 Examined file:</span> <b>\${file}</b>\`;
            }
            if (line.includes("✓ run_command") || line.includes("✓ execute_command")) {
                const match = line.match(/"CommandLine":"([^"]+)"/) || line.match(/"command":"([^"]+)"/);
                const cmd = match ? match[1] : "command";
                return \`<span class="text-amber-400">💻 Executed command:</span> <code class="bg-slate-900/80 px-1.5 py-0.5 rounded text-amber-300 font-mono text-[10px]">\${cmd}</code>\`;
            }
            if (line.includes("✓ delete_file")) {
                const match = line.match(/"TargetFile":"([^"]+)"/) || line.match(/"path":"([^"]+)"/);
                const file = match ? getFilename(match[1]) : "file";
                return \`<span class="text-rose-400">🗑️ Removed file:</span> <b>\${file}</b>\`;
            }
            if (line.includes("✓ get_repo_map") || line.includes("✓ list_dir")) {
                return \`<span class="text-purple-400">🔍 Analyzed project folder structure</span>\`;
            }
            if (line.includes("✓")) {
                return \`<span class="text-emerald-400">\${line}</span>\`;
            }
            if (line.includes("⚠️")) {
                return \`<span class="text-yellow-400">\${line}</span>\`;
            }
            if (line.includes("❌")) {
                return \`<span class="text-red-400">\${line}</span>\`;
            }
            return line;
        }

        function formatMessage(msg) {
            const isUser = msg.sender === "user";
            const avatarColor = isUser ? "bg-indigo-600/20 text-indigo-400 border-indigo-500/30" : "bg-purple-600/20 text-purple-400 border-purple-500/30";
            const icon = isUser ? "user" : "bot";
            const alignClass = isUser ? "flex-row-reverse" : "";
            const bubbleClass = isUser ? "bg-indigo-600/10 border-indigo-500/20 text-slate-100" : "bg-slate-900/60 border-slate-800/80 text-slate-200";

            let tokenHtml = "";
            if (msg.tokens && msg.cost !== undefined) {
                tokenHtml = \`
                    <div class="mt-2.5 pt-2 border-t border-slate-800/65 flex items-center gap-4 text-[10px] text-slate-400 font-mono">
                        <span class="flex items-center gap-1"><i data-lucide="arrow-down-left" class="w-3.5 h-3.5 text-slate-500"></i> In: \${msg.tokens.input}</span>
                        <span class="flex items-center gap-1"><i data-lucide="arrow-up-right" class="w-3.5 h-3.5 text-slate-500"></i> Out: \${msg.tokens.output}</span>
                        <span class="text-indigo-400 font-semibold">💰 Cost: $\${msg.cost.toFixed(6)}</span>
                    </div>
                \`;
            }

            const renderedText = (typeof marked !== "undefined" && marked.parse) 
                ? marked.parse(msg.text) 
                : \`<div class="whitespace-pre-wrap">\${escapeHtml(msg.text)}</div>\`;

            return \`
                <div class="flex gap-3 \${alignClass}">
                    <div class="w-8 h-8 rounded-full \${avatarColor} border flex items-center justify-center flex-shrink-0">
                        <i data-lucide="\${icon}" class="w-4 h-4"></i>
                    </div>
                    <div class="flex-1 \${bubbleClass} border rounded-2xl px-4 py-3 max-w-[85%] text-sm leading-relaxed overflow-hidden">
                        <div class="markdown-body text-slate-200">\${renderedText}</div>
                        \${tokenHtml}
                        <span class="text-[9px] text-slate-500 block text-right mt-1.5">\${msg.timestamp}</span>
                    </div>
                </div>
            \`;
        }

        function updateStateUI(state) {
            // Budget, tokens & attempt counts
            budgetVal.textContent = \`$\${state.budgetUsed.toFixed(4)} / $\${state.maxBudget.toFixed(2)}\`;
            tokensVal.textContent = \`In: \${state.totalTokens.input} | Out: \${state.totalTokens.output}\`;
            attemptBadge.textContent = \`Attempt: \${state.attempts}/\${state.maxAttempts}\`;

            // Status indicators
            statusDot.className = "w-2.5 h-2.5 rounded-full animate-pulse ";
            if (state.status === "idle") {
                statusBadge.className = "flex items-center gap-2 px-4 py-2 rounded-full border border-slate-800 text-slate-400 bg-slate-900/20";
                statusDot.className += "bg-slate-500";
                statusText.textContent = "Idle";
                
                chatInput.disabled = false;
                sendBtn.disabled = false;
                actionBar.classList.add("hidden");
                thinkingIndicator.classList.add("hidden");
            } else if (state.status === "running") {
                statusBadge.className = "flex items-center gap-2 px-4 py-2 rounded-full border border-purple-500/30 text-purple-400 bg-purple-500/5";
                statusDot.className += "bg-purple-500 animate-spin";
                statusText.textContent = "Executing";

                chatInput.disabled = true;
                sendBtn.disabled = true;
                actionBar.classList.add("hidden");
                thinkingIndicator.classList.remove("hidden");
            } else if (state.status === "waiting_approval") {
                statusBadge.className = "flex items-center gap-2 px-4 py-2 rounded-full border border-yellow-500/30 text-yellow-400 bg-yellow-500/5";
                statusDot.className += "bg-yellow-400";
                statusText.textContent = "Awaiting Approval";

                chatInput.disabled = true;
                sendBtn.disabled = true;
                actionBar.classList.remove("hidden");
                thinkingIndicator.classList.add("hidden");
            } else if (state.status === "success") {
                statusBadge.className = "flex items-center gap-2 px-4 py-2 rounded-full border border-green-500/30 text-green-400 bg-green-500/5";
                statusDot.className += "bg-green-400";
                statusText.textContent = "Success";

                chatInput.disabled = false;
                sendBtn.disabled = false;
                actionBar.classList.add("hidden");
                thinkingIndicator.classList.add("hidden");
            } else if (state.status === "failed") {
                statusBadge.className = "flex items-center gap-2 px-4 py-2 rounded-full border border-red-500/30 text-red-400 bg-red-500/5";
                statusDot.className += "bg-red-400";
                statusText.textContent = "Failed";

                chatInput.disabled = false;
                sendBtn.disabled = false;
                actionBar.classList.add("hidden");
                thinkingIndicator.classList.add("hidden");
            }

            // Sync Messages
            if (state.messages.length > currentMessagesCount) {
                for (let i = currentMessagesCount; i < state.messages.length; i++) {
                    const msg = state.messages[i];
                    chatMessages.innerHTML += formatMessage(msg);
                }
                currentMessagesCount = state.messages.length;
                chatMessages.scrollTop = chatMessages.scrollHeight;
                renderIcons();
            }

            // Append new agent logs to chat messages as structured logs if running
            if (state.logs.length > currentLogsCount) {
                const logsPane = document.createElement("div");
                logsPane.className = "bg-slate-950/40 border border-slate-900 rounded-xl p-3 font-mono text-[11px] leading-normal text-slate-400 max-w-[85%] self-start space-y-1";
                
                let addedAny = false;
                for (let i = currentLogsCount; i < state.logs.length; i++) {
                    const line = state.logs[i];
                    if (!line.trim()) continue;
                    addedAny = true;
                    
                    const lineDiv = document.createElement("div");
                    lineDiv.innerHTML = getFriendlyLog(line);
                    logsPane.appendChild(lineDiv);
                }
                
                if (addedAny) {
                    const wrapDiv = document.createElement("div");
                    wrapDiv.className = "flex gap-3";
                    wrapDiv.innerHTML = \`
                        <div class="w-8 h-8 rounded-full bg-slate-900/60 border border-slate-800 flex items-center justify-center flex-shrink-0 text-slate-500">
                            <i data-lucide="terminal" class="w-4 h-4"></i>
                        </div>
                    \`;
                    wrapDiv.appendChild(logsPane);
                    chatMessages.appendChild(wrapDiv);
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                    renderIcons();
                }
                
                currentLogsCount = state.logs.length;
            }

            // Sync Staged Groups
            if (state.stagedGroups.length === 0) {
                stagedContainer.innerHTML = \`
                    <div class="text-center py-16 text-slate-400 flex flex-col items-center justify-center gap-4">
                        <i data-lucide="file-code-2" class="w-14 h-14 text-slate-700"></i>
                        <p class="text-sm">Wait for agent turn execution to inspect proposed modifications.</p>
                    </div>
                \`;
            } else {
                let html = "";
                state.stagedGroups.forEach((g) => {
                    const badgeClass = g.tier === "high" ? "bg-red-500/10 text-red-400 border-red-500/20" : "bg-green-500/10 text-green-400 border-green-500/20";
                    html += \`
                        <div class="border border-slate-850 rounded-xl overflow-hidden bg-slate-900/10">
                            <div class="px-4 py-3 bg-slate-900/40 border-b border-slate-850 flex items-center justify-between">
                                <div class="flex items-center gap-2">
                                    <span class="px-2 py-0.5 rounded text-[10px] uppercase font-bold border \${badgeClass}">\${g.tier}</span>
                                    <h4 class="font-medium text-xs text-slate-200">\${g.label}</h4>
                                </div>
                                <span class="text-[10px] text-slate-400">\${g.reason}</span>
                            </div>
                    \`;
                    if (g.patch) {
                        html += \`
                            <div class="p-4 bg-slate-950/60 overflow-x-auto text-[11px] font-mono leading-normal space-y-0.5">
                        \`;
                        const patchLines = g.patch.split("\\n");
                        patchLines.forEach(line => {
                            let lineClass = "";
                            if (line.startsWith("+")) lineClass = "diff-added px-1 rounded";
                            else if (line.startsWith("-")) lineClass = "diff-removed px-1 rounded";
                            else if (line.startsWith("@")) lineClass = "text-indigo-400";
                            html += \`<div class="\${lineClass}">\${escapeHtml(line)}</div>\`;
                        });
                        html += \`</div>\`;
                    }
                    html += \`</div>\`;
                });
                stagedContainer.innerHTML = html;
            }
            renderIcons();
        }

        // Tab Navigation
        const tabDiffs = document.getElementById("tab-diffs");
        const tabGraph = document.getElementById("tab-graph");
        const diffsView = document.getElementById("diffs-view");
        const graphView = document.getElementById("graph-view");
        const graphCanvas = document.getElementById("graph-canvas");

        tabDiffs.addEventListener("click", () => {
            tabDiffs.className = "text-xs font-bold uppercase tracking-wider text-purple-400 border-b-2 border-purple-500 pb-1 flex items-center gap-2 focus:outline-none";
            tabGraph.className = "text-xs font-bold uppercase tracking-wider text-slate-400 hover:text-slate-200 pb-1 flex items-center gap-2 focus:outline-none";
            diffsView.classList.remove("hidden");
            graphView.classList.add("hidden");
        });

        tabGraph.addEventListener("click", () => {
            tabGraph.className = "text-xs font-bold uppercase tracking-wider text-purple-400 border-b-2 border-purple-500 pb-1 flex items-center gap-2 focus:outline-none";
            tabDiffs.className = "text-xs font-bold uppercase tracking-wider text-slate-400 hover:text-slate-200 pb-1 flex items-center gap-2 focus:outline-none";
            diffsView.classList.add("hidden");
            graphView.classList.remove("hidden");
            
            initOrRedrawGraph();
        });

        // Vis.js Network Graph Integration
        let visNetwork = null;
        let visNodes = null;
        let visEdges = null;

        function initOrRedrawGraph() {
            if (visNetwork) {
                visNetwork.redraw();
                return;
            }

            fetch("/api/graph")
                .then(r => r.json())
                .then(graphData => {
                    const rawNodes = graphData.nodes.map(n => {
                        return {
                            id: n.id,
                            label: n.label,
                            title: n.id + " (" + (n.size / 1024).toFixed(1) + " KB)",
                            color: {
                                background: "#334155",
                                border: "#475569",
                                highlight: { background: "#4f46e5", border: "#818cf8" }
                            },
                            borderWidth: 1.5,
                            size: 15 + Math.min(25, n.size / 1500)
                        };
                    });

                    visNodes = new vis.DataSet(rawNodes);
                    visEdges = new vis.DataSet(graphData.edges.map(e => ({
                        from: e.from,
                        to: e.to,
                        arrows: "to"
                    })));

                    const data = { nodes: visNodes, edges: visEdges };
                    const options = {
                        nodes: {
                            shape: "dot",
                            font: { color: "#cbd5e1", size: 10, face: "Plus Jakarta Sans" }
                        },
                        edges: {
                            color: { color: "#1e293b", highlight: "#4f46e5" },
                            smooth: { type: "continuous" }
                        },
                        physics: {
                            forceAtlas2Based: {
                                gravitationalConstant: -26,
                                centralGravity: 0.005,
                                springLength: 120,
                                springConstant: 0.18
                            },
                            maxVelocity: 146,
                            solver: "forceAtlas2Based",
                            timestep: 0.35,
                            stabilization: { iterations: 150 }
                        }
                    };

                    visNetwork = new vis.Network(graphCanvas, data, options);

                    if (window.lastState) {
                        applyNodeStyles(window.lastState);
                    }

                    // Toggle context pin on double-click
                    visNetwork.on("doubleClick", function (params) {
                        if (params.nodes.length > 0) {
                            const nodeId = params.nodes[0];
                            const isCurrentlyPinned = window.lastState ? window.lastState.pinnedFiles.includes(nodeId) : false;
                            
                            fetch("/api/context/pin", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ path: nodeId, pin: !isCurrentlyPinned })
                            })
                            .catch(err => console.error("Pin request failed:", err));
                        }
                    });
                })
                .catch(err => console.error("Failed to load codebase graph:", err));
        }

        function applyNodeStyles(state) {
            window.lastState = state;
            if (!visNodes) return;
            
            const updates = visNodes.get().map(node => {
                const isPinned = state.pinnedFiles.includes(node.id);
                const isMatched = state.graphMatchedFiles.includes(node.id);
                
                let color = "#1e293b"; // Unloaded default
                let borderColor = "#334155";
                if (isPinned) {
                    color = "#6366f1"; // Pinned
                    borderColor = "#818cf8";
                } else if (isMatched) {
                    color = "#10b981"; // GraphRAG Matched
                    borderColor = "#34d399";
                }

                return {
                    id: node.id,
                    color: {
                        background: color,
                        border: borderColor,
                        highlight: { background: "#4f46e5", border: "#818cf8" }
                    }
                };
            });
            visNodes.update(updates);
        }

        // SSE Connection
        const source = new EventSource("/events");
        
        let streamingText = "";

        source.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === "init" || data.type === "update") {
                window.lastState = data.state;
                updateStateUI(data.state);
                applyNodeStyles(data.state);
            } else if (data.type === "stream_chunk") {
                if (data.isStart) {
                    streamingText = "";
                    // Clear existing streaming placeholder if any
                    const existing = document.getElementById("streaming-agent-message");
                    if (existing) existing.remove();

                    // Create placeholder message markup
                    const placeholderHtml = \`
                        <div id="streaming-agent-message" class="flex gap-3">
                            <div class="w-8 h-8 rounded-full bg-purple-600/20 text-purple-400 border border-purple-500/30 flex items-center justify-center flex-shrink-0">
                                <i data-lucide="bot" class="w-4 h-4"></i>
                            </div>
                            <div class="flex-1 bg-slate-900/60 border border-slate-800/80 text-slate-200 border rounded-2xl px-4 py-3 max-w-[85%] text-sm leading-relaxed overflow-hidden">
                                <div class="markdown-body text-slate-200"></div>
                                <span class="text-[9px] text-slate-500 block text-right mt-1.5">Streaming...</span>
                            </div>
                        </div>
                    \`;
                    const tempDiv = document.createElement("div");
                    tempDiv.innerHTML = placeholderHtml.trim();
                    chatMessages.appendChild(tempDiv.firstElementChild || tempDiv.firstChild);
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                    renderIcons();
                } else {
                    streamingText += data.chunk;
                    const container = document.getElementById("streaming-agent-message");
                    if (container) {
                        const mdBody = container.querySelector(".markdown-body");
                        if (mdBody) {
                            mdBody.innerHTML = (typeof marked !== "undefined" && marked.parse)
                                ? marked.parse(streamingText)
                                : \`<div class="whitespace-pre-wrap">\${escapeHtml(streamingText)}</div>\`;
                            chatMessages.scrollTop = chatMessages.scrollHeight;
                        }
                    }
                }
            } else if (data.type === "stream_end") {
                const existing = document.getElementById("streaming-agent-message");
                if (existing) existing.remove();
            }
        };

        source.onerror = (err) => {
            console.error("EventSource failed:", err);
        };
    </script>
</body>
</html>
`;
    }
}
