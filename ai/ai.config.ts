import { createOpenRouter } from "@openrouter/ai-sdk-provider";

export function getAgentModel(){
    const provider=createOpenRouter({apiKey: process.env.OPENROUTER_API_KEY});

    const modelId=process.env.OPEROUNTER_MODEL;

    return provider(modelId!);
}