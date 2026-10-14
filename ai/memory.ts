import type { LanguageModel } from "ai";

export function wrapModelWithRollingMemory(
    model: any,
    goal: string,
    skeletalMap: string,
    semanticFilesContent: string | (() => string),
    getScratchpad?: () => string,
    setScratchpad?: (val: string) => void,
    getStagedSummary?: string | (() => string)
): any {
    let localScratchpad = "";

    const readScratchpad = (): string => {
        if (typeof getScratchpad === "function") {
            return getScratchpad();
        }
        return localScratchpad;
    };

    const updateScratchpad = (val: string) => {
        localScratchpad = val;
        if (typeof setScratchpad === "function") {
            setScratchpad(val);
        }
    };

    return {
        specificationVersion: model.specificationVersion,
        provider: model.provider,
        modelId: model.modelId,
        defaultObjectGenerationMode: model.defaultObjectGenerationMode,

        doGenerate: async function (options: any) {
            const messages = options.prompt || [];

            // If we have history, summarize the intermediate messages only when they exceed 8 messages.
            // This keeps the prompt cache valid for longer and avoids redundant summarize API calls.
            if (messages.length > 8) {
                // We keep the last 4 turns active to maintain full local context for the tool execution loop.
                const historyToSummarize = messages.slice(0, -4);
                
                try {
                    const historyStr = historyToSummarize
                        .map((m: any) => {
                            const role = m.role;
                            const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
                            return `[${role}]: ${text}`;
                        })
                        .join("\n");

                    const summaryPrompt = [
                        {
                            role: "system",
                            content: [
                                "You are a state-summarization assistant.",
                                "Given the preceding coding agent conversation and the current scratchpad, update the scratchpad (a concise list of actions taken, findings, and current progress) to incorporate the new events.",
                                "Keep the output extremely short (under 500 words) and bulleted.",
                                "Respond ONLY with the updated scratchpad text. Do not add any greeting or meta-text."
                            ].join("\n")
                        },
                        {
                            role: "user",
                            content: [
                                {
                                    type: "text",
                                    text: `Current Scratchpad:\n${readScratchpad() || "None"}\n\nNew Turn Events:\n${historyStr}`
                                }
                            ]
                        }
                    ];

                    // Use the model to summarize itself cheaply
                    const summaryRes = await model.doGenerate({
                        ...options,
                        prompt: summaryPrompt,
                        mode: { type: "regular" },
                        tools: undefined
                    });

                    if (summaryRes.text) {
                        updateScratchpad(summaryRes.text.trim());
                    }
                } catch (err) {
                    console.warn("⚠️ Rolling State Memory summary step failed:", err);
                }
            }

            const activeSemanticContent = typeof semanticFilesContent === "function"
                ? semanticFilesContent()
                : semanticFilesContent;

            const activeStagedSummary = typeof getStagedSummary === "function"
                ? getStagedSummary()
                : (getStagedSummary || "None");

            // Extract initial system instructions (if any) to preserve operational rules
            const existingSystem = messages.find((m: any) => m.role === "system");
            const systemExtra = existingSystem?.content 
                ? `\n\nOperational Instructions:\n${typeof existingSystem.content === "string" ? existingSystem.content : JSON.stringify(existingSystem.content)}`
                : "";

            // Build our minimized system prompt incorporating GraphRAG, Map, Staged files, Scratchpad, and original System Rules
            const systemPrompt = [
                "You are an AI coding agent executing a task.",
                "Here is the Skeletal Map of the codebase:",
                skeletalMap,
                "",
                "Here are the full contents of the semantically related files:",
                activeSemanticContent,
                "",
                "Currently Staged (Uncommitted) Files in Memory Overlay:",
                activeStagedSummary,
                "",
                "Current Scratchpad (summary of past execution state):",
                readScratchpad() || "None so far.",
                systemExtra
            ].join("\n");

            // Ensure conversation turns are preserved while capping high-volume tool execution steps
            const nonSystemMsgs = messages.filter((m: any) => m.role !== "system");
            const conversationTurns = nonSystemMsgs.filter((m: any) => m.role === "user" || (m.role === "assistant" && typeof m.content === "string"));
            const toolSteps = nonSystemMsgs.filter((m: any) => !conversationTurns.includes(m));

            const activeMessages: any[] = [
                ...conversationTurns,
                ...toolSteps.slice(-20)
            ];

            // Construct new options with the minimized system prompt and active messages
            const newOptions = {
                ...options,
                prompt: [
                    {
                        role: "system",
                        content: systemPrompt
                    },
                    ...activeMessages
                ]
            };

            return model.doGenerate(newOptions);
        },

        doStream: async function (options: any) {
            const messages = options.prompt || [];

            // If we have history, summarize the intermediate messages only when they exceed 8 messages.
            if (messages.length > 8) {
                const historyToSummarize = messages.slice(0, -4);
                
                try {
                    const historyStr = historyToSummarize
                        .map((m: any) => {
                            const role = m.role;
                            const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
                            return `[${role}]: ${text}`;
                        })
                        .join("\n");

                    const summaryPrompt = [
                        {
                            role: "system",
                            content: [
                                "You are a state-summarization assistant.",
                                "Given the preceding coding agent conversation and the current scratchpad, update the scratchpad (a concise list of actions taken, findings, and current progress) to incorporate the new events.",
                                "Keep the output extremely short (under 500 words) and bulleted.",
                                "Respond ONLY with the updated scratchpad text. Do not add any greeting or meta-text."
                            ].join("\n")
                        },
                        {
                            role: "user",
                            content: [
                                {
                                    type: "text",
                                    text: `Current Scratchpad:\n${readScratchpad() || "None"}\n\nNew Turn Events:\n${historyStr}`
                                }
                            ]
                        }
                    ];

                    const summaryRes = await model.doGenerate({
                        ...options,
                        prompt: summaryPrompt,
                        mode: { type: "regular" },
                        tools: undefined
                    });

                    if (summaryRes.text) {
                        updateScratchpad(summaryRes.text.trim());
                    }
                } catch (err) {
                    console.warn("⚠️ Rolling State Memory summary step failed:", err);
                }
            }

            const activeSemanticContent = typeof semanticFilesContent === "function"
                ? semanticFilesContent()
                : semanticFilesContent;

            const activeStagedSummary = typeof getStagedSummary === "function"
                ? getStagedSummary()
                : (getStagedSummary || "None");

            // Extract initial system instructions (if any) to preserve operational rules
            const existingSystem = messages.find((m: any) => m.role === "system");
            const systemExtra = existingSystem?.content 
                ? `\n\nOperational Instructions:\n${typeof existingSystem.content === "string" ? existingSystem.content : JSON.stringify(existingSystem.content)}`
                : "";

            const systemPrompt = [
                "You are an AI coding agent executing a task.",
                "Here is the Skeletal Map of the codebase:",
                skeletalMap,
                "",
                "Here are the full contents of the semantically related files:",
                activeSemanticContent,
                "",
                "Currently Staged (Uncommitted) Files in Memory Overlay:",
                activeStagedSummary,
                "",
                "Current Scratchpad (summary of past execution state):",
                readScratchpad() || "None so far.",
                systemExtra
            ].join("\n");

            // Ensure conversation turns are preserved while capping high-volume tool execution steps
            const nonSystemMsgs = messages.filter((m: any) => m.role !== "system");
            const conversationTurns = nonSystemMsgs.filter((m: any) => m.role === "user" || (m.role === "assistant" && typeof m.content === "string"));
            const toolSteps = nonSystemMsgs.filter((m: any) => !conversationTurns.includes(m));

            const activeMessages: any[] = [
                ...conversationTurns,
                ...toolSteps.slice(-12)
            ];

            const newOptions = {
                ...options,
                prompt: [
                    {
                        role: "system",
                        content: systemPrompt
                    },
                    ...activeMessages
                ]
            };

            return model.doStream(newOptions);
        }
    };
}
