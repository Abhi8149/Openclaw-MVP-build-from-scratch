import type { LanguageModel } from "ai";

export function wrapModelWithRollingMemory(
    model: any,
    goal: string,
    skeletalMap: string,
    semanticFilesContent: string
): any {
    let scratchpad = "";

    return {
        specificationVersion: model.specificationVersion,
        provider: model.provider,
        modelId: model.modelId,
        defaultObjectGenerationMode: model.defaultObjectGenerationMode,

        doGenerate: async function (options: any) {
            const messages = options.prompt || [];

            // If we have history, summarize the intermediate messages
            if (messages.length > 2) {
                // We summarize messages from the start up to the second-to-last turn,
                // keeping the last 2 turns active for tool loop execution.
                const historyToSummarize = messages.slice(0, -2);
                
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
                            content: `Current Scratchpad:\n${scratchpad || "None"}\n\nNew Turn Events:\n${historyStr}`
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

            // Build our minimized system prompt incorporating GraphRAG, Map, and Scratchpad
            const systemPrompt = [
                "You are an AI coding agent executing a task.",
                "Here is the Skeletal Map of the codebase:",
                skeletalMap,
                "",
                "Here are the full contents of the semantically related files:",
                semanticFilesContent,
                "",
                "Current Scratchpad (summary of past execution state):",
                scratchpad || "None so far.",
            ].join("\n");

            // We preserve the last 2 messages (to ensure the ToolLoopAgent's direct state machine knows what the last tool call/result was)
            const activeMessages = messages.slice(-2);

            // Construct new options with the minimized system prompt and active messages
            const newOptions = {
                ...options,
                prompt: [
                    { role: "system", content: systemPrompt },
                    ...activeMessages
                ]
            };

            return model.doGenerate(newOptions);
        }
    };
}
