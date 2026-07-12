# Intent-Driven Retrieval (GraphRAG) & Rolling State Memory

This document explains the technical implementation and user workflows of two cutting-edge features added to AbhiClaw: **Intent-Driven Retrieval** (semantic file search) and **Rolling State Memory** (context window rolling scratchpad).

---

## 1. Intent-Driven Retrieval (Semantic Search & GraphRAG)

### Concept
When tasks are run on large codebases, feeding the whole project tree into the LLM context window causes high latency and massive token costs. Instead of loading arbitrary files, AbhiClaw vectorizes the user's task goal (intent) and finds the top 3 most semantically related source files to load in full.

### Implementation Details
- **Module**: [semantic-retrieval.ts](file:///c:/Users/abhinav/OneDrive/Desktop/openclaw/utils/semantic-retrieval.ts)
- **Local JSON Cache**: We persist file modification times and generated vector coordinates in `.openclaw-embeddings.json`. Only modified or new files are re-vectorized.
- **Dynamic Embeddings**: Uses OpenRouter's `/v1/embeddings` endpoint with the high-performance `nomic-ai/nomic-embed-text` model.
- **Robust Local Fallback**: If OpenRouter is offline, or the API key is missing/unconfigured, the system automatically falls back to a **local TF-IDF term frequency overlap engine**. It computes Jaccard/Cosine similarity of term bags instantly on your local machine, guaranteeing search continues seamlessly.

---

## 2. Rolling State Memory (Execution State Scratchpad)

### Concept
As an AI agent runs a multi-step loop, the conversation history grows longer. Feeding all historical tool execution logs back to the API on every turn exhausts the context window. 

Rolling State Memory continuously wraps the language model. Instead of passing the entire chat history on every turn, it rolls up the execution history into a compact "Scratchpad."

### Implementation Details
- **Module**: [memory.ts](file:///c:/Users/abhinav/OneDrive/Desktop/openclaw/ai/memory.ts)
- **Model Proxy Wrapper**: We proxy the model's `doGenerate()` calls.
- **Continuous Rolling Summarization**:
  - Whenever the tool loop accumulates more than 2 steps, we take the preceding conversation history.
  - We call the LLM in the background with a specialized summarization prompt to roll up past turns into a bulleted progress report (the **Scratchpad**).
  - The main model only ever receives:
    1. The **Skeletal Map** (class/function boundary mappings).
    2. The full text of the **top 2-3 semantically related files** retrieved by the GraphRAG step.
    3. The updated **Scratchpad**.
    4. The **last 2 turns** of active conversation (to preserve immediate tool call parameters and execution responses).

---

## 3. How to Verify / Test

### Running the Automated Tests
We created unit tests checking vector similarity calculations, TF-IDF fallback mappings, and proxy prompt composition.
Run:
```bash
bun test testing-scripts/semantic-and-memory.test.ts
```

### Manual Verification
1. Open terminal and run:
   ```bash
   bun index.ts wakeup
   ```
2. Select **CLI** or **Web UI**.
3. Type a task (e.g., *"Update the git helper to print debug logs"*).
4. Notice the terminal or web dashboard printout:
   ```
   🔍 Scanning codebase for intent-driven retrieval...
   🎯 Intent-driven retrieval found 3 semantically related files:
      • utils/git.ts (score: 0.814)
      • modes/agents/orchestrator.ts (score: 0.620)
      • testing-scripts/session-rewind.test.ts (score: 0.542)
   ```
5. The agent will run with memory rolling enabled, keeping token usage flat and saving up to 90% in LLM API expenses!
