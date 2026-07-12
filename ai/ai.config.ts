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

export function getAgentModel(goal?: string){
    const provider = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

    let modelId = process.env.OPENROUTER_MODEL || "openrouter/auto";

    // Dynamic routing via OpenRouter Auto-Router (NotDiamond) if a goal is provided
    if (modelId === "openrouter/auto" && goal) {
        const tradeoff = calculateTradeoff(goal);
        console.log(chalk.cyan(`🔄 OpenRouter Auto-Router active. Dynamic Tradeoff: ${tradeoff.toFixed(1)}/10.0 (0=pure capability, 10=max savings)...`));
        
        const settings: any = {
            plugins: [{
                id: "auto-router",
                cost_quality_tradeoff: tradeoff,
                allowed_models: [
                    "anthropic/claude-3.5-sonnet",
                    "openai/gpt-4o",
                    "google/gemini-2.5-flash-lite",
                    "meta-llama/llama-3.1-70b-instruct"
                ]
            }]
        };
        return provider("openrouter/auto", settings);
    }

    // Fallback to static model selection
    return provider(modelId);
}

export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
    "tencent/hy3:free": { input: 0.0, output: 0.0 },
    "meta-llama/llama-3.1-70b-instruct": { input: 0.52, output: 0.75 },
    "anthropic/claude-3.5-sonnet": { input: 3.0, output: 15.0 },
    "openrouter/auto": { input: 1.5, output: 7.5 }, // Estimated average for auto-routing cost calculation
};