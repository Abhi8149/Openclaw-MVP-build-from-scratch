import { createOpenRouter } from "@openrouter/ai-sdk-provider";

export function getAgentModel(){
    const provider=createOpenRouter({apiKey: process.env.OPENROUTER_API_KEY});

    const modelId=process.env.OPENROUTER_MODEL;

    return provider(modelId!);
}

export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
    "tencent/hy3:free": { input: 0.0, output: 0.0 },
    "meta-llama/llama-3.1-70b-instruct": { input: 0.52, output: 0.75 },
    "anthropic/claude-3.5-sonnet": { input: 3.0, output: 15.0 },
};