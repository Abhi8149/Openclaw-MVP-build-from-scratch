import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import chalk from "chalk";


export function calculateTradeoff(goal: string): number {
    const lowercase = goal.toLowerCase();
    
    // Keywords demanding high reasoning capabilities (low tradeoff = priority to intelligence)
    const criticalKeywords = [
        "refactor", "database", "schema", "rewrite", "migration", "architecture", 
        "compiler", "loop", "healing", "thread", "concurrency", "performance",
        "checkpoint", "rewind", "bug", "fix", "issue"
    ];
    
    // Keywords signifying simple operations (high tradeoff = priority to cost savings)
    const simpleKeywords = [
        "readme", "documentation", "doc", "comment", "style", "css", "color", 
        "hello", "print", "todo", "ignore"
    ];
    
    let tradeoff = 5.0; // Default baseline tradeoff
    
    // Tradeoff calculations based on prompt length
    if (lowercase.length > 250) {
        tradeoff -= 2.0; // Detailed instructions usually indicate complex operations
    } else if (lowercase.length < 50) {
        tradeoff += 2.0; // Short prompts are typically simple tasks
    }
    
    // Adjust based on keywords
    for (const cw of criticalKeywords) {
        if (lowercase.includes(cw)) {
            tradeoff -= 3.0;
        }
    }
    
    for (const sw of simpleKeywords) {
        if (lowercase.includes(sw)) {
            tradeoff += 3.0;
        }
    }
    
    // Bound the tradeoff float between 0.0 and 10.0
    return Math.max(0.0, Math.min(10.0, tradeoff));
}

export async function getAgentModel(goal?: string){
    const provider = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

    let modelId = "openrouter/auto";

    // Dynamic routing via OpenRouter built-in auto-router if a goal is provided and model is auto
    if (modelId === "openrouter/auto" && goal) {
        const tradeoff = calculateTradeoff(goal);
        
        const settings: any = {
            plugins: [{
                id: "auto-router",
                cost_quality_tradeoff: tradeoff,
                allowed_models: [
                    "nvidia/nemotron-3-ultra-550b-a55b:free",
                    "deepseek/deepseek-v4-flash",
                    "openai/gpt-6-luna"
                ]
            }]
        };
        return provider("openrouter/auto", settings);
    }

    // Fallback to static model selection
    return provider(modelId);
}

export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
    "nvidia/nemotron-3-ultra-550b-a55b:free": { input: 0.0, output: 0.0 },
    "deepseek/deepseek-v4-flash": { input: 0.14, output: 0.28 },
    "openai/gpt-6-luna":{input:0.1, output:0.5},
    "openrouter/auto": { input: 0.07, output: 0.14 }, // Estimated average for auto-routing cost calculation
};