import http from "node:http";
import { EventEmitter } from "node:events";

export interface GuiState {
    goal: string;
    status: "idle" | "running" | "waiting_approval" | "success" | "failed";
    attempts: number;
    maxAttempts: number;
    budgetUsed: number;
    maxBudget: number;
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
    }>;
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
        logs: [],
        stagedGroups: [],
        messages: [],
    };

    constructor() {
        super();
    }

    public start(port = 8000): Promise<string> {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => {
                const url = req.url ?? "";
                const method = req.method ?? "GET";

                // Serve Web Dashboard
                if (url === "/" || url === "/index.html") {
                    res.writeHead(200, { "Content-Type": "text/html" });
                    res.end(this.getHtmlContent());
                    return;
                }

                // Server-Sent Events Endpoint
                if (url === "/events") {
                    res.writeHead(200, {
                        "Content-Type": "text/event-stream",
                        "Cache-Control": "no-cache",
                        Connection: "keep-alive",
                    });
                    res.write(`data: ${JSON.stringify({ type: "init", state: this.state })}\n\n`);
                    this.clients.push(res);

                    req.on("close", () => {
                        this.clients = this.clients.filter((c) => c !== res);
                    });
                    return;
                }

                // API: Submit prompt
                if (url === "/api/prompt" && method === "POST") {
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
                if (url === "/api/approve" && method === "POST") {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ success: true }));
                    if (this.pendingApprovalResolver) {
                        this.pendingApprovalResolver(true);
                        this.pendingApprovalResolver = null;
                    }
                    return;
                }

                // API: Reject staged changes
                if (url === "/api/reject" && method === "POST") {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ success: true }));
                    if (this.pendingApprovalResolver) {
                        this.pendingApprovalResolver(false);
                        this.pendingApprovalResolver = null;
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

    public addAgentMessage(text: string) {
        this.updateState((s) => {
            s.messages.push({
                sender: "agent",
                text,
                timestamp: new Date().toLocaleTimeString(),
            });
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

    public stop() {
        for (const client of this.clients) {
            client.end();
        }
        this.clients = [];
        if (this.server) {
            this.server.close();
        }
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
    <script src="https://unpkg.com/lucide@latest"></script>
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

        <!-- Right Column: Staged Changes / Approvals -->
        <div class="lg:col-span-6 flex flex-col gap-6 overflow-hidden">
            <div class="glass flex-1 rounded-2xl flex flex-col overflow-hidden h-[600px] min-h-[500px]">
                <div class="px-5 py-4 border-b border-slate-800/80 flex items-center justify-between">
                    <h3 class="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                        <i data-lucide="shield-check" class="w-4 h-4"></i> Staged Changes Review
                    </h3>
                    <span class="text-xs text-slate-400" id="attempt-badge">Attempt: 0/3</span>
                </div>

                <!-- Diffs Container -->
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
        </div>
    </main>

    <!-- Footer -->
    <footer class="text-center py-4 text-xs text-slate-500 border-t border-slate-950 bg-slate-950">
        AbhiClaw CLI Tool Dashboard · Running Locally (127.0.0.1)
    </footer>

    <script>
        lucide.createIcons();

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

        function formatMessage(msg) {
            const isUser = msg.sender === "user";
            const avatarColor = isUser ? "bg-indigo-600/20 text-indigo-400 border-indigo-500/30" : "bg-purple-600/20 text-purple-400 border-purple-500/30";
            const icon = isUser ? "user" : "bot";
            const alignClass = isUser ? "flex-row-reverse" : "";
            const bubbleClass = isUser ? "bg-indigo-600/10 border-indigo-500/20 text-slate-100" : "bg-slate-900/60 border-slate-800/80 text-slate-200";

            return \`
                <div class="flex gap-3 \\\${alignClass}">
                    <div class="w-8 h-8 rounded-full \\\${avatarColor} border flex items-center justify-center flex-shrink-0">
                        <i data-lucide="\\\${icon}" class="w-4 h-4"></i>
                    </div>
                    <div class="flex-1 \\\${bubbleClass} border rounded-2xl px-4 py-3 max-w-[85%] text-sm leading-relaxed">
                        <div class="whitespace-pre-wrap">\\\${msg.text}</div>
                        <span class="text-[9px] text-slate-500 block text-right mt-1.5">\\\${msg.timestamp}</span>
                    </div>
                </div>
            \`;
        }

        function updateStateUI(state) {
            // Budget & attempt counts
            budgetVal.textContent = \`$\${state.budgetUsed.toFixed(4)} / $\${state.maxBudget.toFixed(2)}\`;
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
                lucide.createIcons();
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
                    if (line.includes("✓")) {
                        lineDiv.innerHTML = \`<span class="text-green-400 font-bold">\${line.slice(0, 3)}</span>\${line.slice(3)}\`;
                    } else if (line.includes("⚠️")) {
                        lineDiv.innerHTML = \`<span class="text-yellow-400">\${line}</span>\`;
                    } else if (line.includes("❌")) {
                        lineDiv.innerHTML = \`<span class="text-red-400">\${line}</span>\`;
                    } else {
                        lineDiv.textContent = line;
                    }
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
                    lucide.createIcons();
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
            lucide.createIcons();
        }

        // SSE Connection
        const source = new EventSource("/events");
        
        source.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === "init" || data.type === "update") {
                updateStateUI(data.state);
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
