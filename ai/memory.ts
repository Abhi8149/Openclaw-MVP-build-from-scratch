import type { LanguageModel } from "ai";

export function wrapModelWithRollingMemory(
    model: any,
    goal: string,
    skeletalMap: string,
    semanticFilesContent: string | (() => string)
): any {
    let scratchpad = "";

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
                                "Keep the output extremely short (under 150 words) and bulleted.",
                                "Respond ONLY with the updated scratchpad text. Do not add any greeting or meta-text."
                            ].join("\n")
                        },
                        {
                            role: "user",
                            content: [
                                {
                                    type: "text",
                                    text: `Current Scratchpad:\n${scratchpad || "None"}\n\nNew Turn Events:\n${historyStr}`
                                }
                            ]
                        }
                    ];

                    // Use the model to summarize itself cheaply
                    const summaryRes = await model.doGenerate({
                        ...options,
                        prompt: summaryPrompt,
                        // Strip tools from summary call so it does regular completions
                        mode: { type: "regular" },
                        tools: undefined
                    });

                    if (summaryRes.text) {
                        scratchpad = summaryRes.text.trim();
                    }
                } catch (err) {
                    console.warn("⚠️ Rolling State Memory summary step failed:", err);
                }
            }

            const activeSemanticContent = typeof semanticFilesContent === "function"
                ? semanticFilesContent()
                : semanticFilesContent;

            // Extract initial system instructions (if any) to preserve operational rules
            const existingSystem = messages.find((m: any) => m.role === "system");
            const systemExtra = existingSystem?.content 
                ? `\n\nOperational Instructions:\n${typeof existingSystem.content === "string" ? existingSystem.content : JSON.stringify(existingSystem.content)}`
                : "";

            // Build our minimized system prompt incorporating GraphRAG, Map, Scratchpad, and original System Rules
            const systemPrompt = [
                "You are an AI coding agent executing a task.",
                "Here is the Skeletal Map of the codebase:",
                skeletalMap,
                "",
                "Here are the full contents of the semantically related files:",
                activeSemanticContent,
                "",
                "Current Scratchpad (summary of past execution state):",
                scratchpad || "None so far.",
                systemExtra
            ].join("\n");

            // Ensure the user's prompt is NEVER sliced away during multi-turn tool loops
            const nonSystemMsgs = messages.filter((m: any) => m.role !== "system");
            const userMsg = nonSystemMsgs.find((m: any) => m.role === "user");

            const activeMessages: any[] = [];
            if (userMsg) {
                activeMessages.push(userMsg);
            }

            // Append up to the last 4 recent tool interaction steps
            const recentSteps = nonSystemMsgs.filter((m: any) => m !== userMsg).slice(-20);
            activeMessages.push(...recentSteps);

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
                                "Keep the output extremely short (under 150 words) and bulleted.",
                                "Respond ONLY with the updated scratchpad text. Do not add any greeting or meta-text."
                            ].join("\n")
                        },
                        {
                            role: "user",
                            content: [
                                {
                                    type: "text",
                                    text: `Current Scratchpad:\n${scratchpad || "None"}\n\nNew Turn Events:\n${historyStr}`
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
                        scratchpad = summaryRes.text.trim();
                    }
                } catch (err) {
                    console.warn("⚠️ Rolling State Memory summary step failed:", err);
                }
            }

            const activeSemanticContent = typeof semanticFilesContent === "function"
                ? semanticFilesContent()
                : semanticFilesContent;

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
                "Current Scratchpad (summary of past execution state):",
                scratchpad || "None so far.",
                systemExtra
            ].join("\n");

            // Ensure the user's prompt is NEVER sliced away during multi-turn tool loops
            const nonSystemMsgs = messages.filter((m: any) => m.role !== "system");
            const userMsg = nonSystemMsgs.find((m: any) => m.role === "user");

            const activeMessages: any[] = [];
            if (userMsg) {
                activeMessages.push(userMsg);
            }

            // Append up to the last 4 recent tool interaction steps
            const recentSteps = nonSystemMsgs.filter((m: any) => m !== userMsg).slice(-4);
            activeMessages.push(...recentSteps);

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
