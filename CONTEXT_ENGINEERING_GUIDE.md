# 🧠 Context Engineering Guide for OpenClaw Desktop Agent

> **What is this?** A practical, no-fluff guide to the 7 most effective strategies for managing context in your desktop coding agent. Everything here is distilled from real production systems: Claude Code, Manus, Aider, Devin, OpenHands, and multiple research papers.

---

## Table of Contents

1. [The Core Problem](#the-core-problem)
2. [Strategy 1: Tiered Memory Architecture (The "OS" Approach)](#strategy-1-tiered-memory-architecture)
3. [Strategy 2: Conversation Compaction (Intelligent Summarization)](#strategy-2-conversation-compaction)
4. [Strategy 3: Repository Map — Token-Efficient Codebase Awareness](#strategy-3-repository-map)
5. [Strategy 4: Just-In-Time Context Retrieval (Lazy Loading)](#strategy-4-just-in-time-context-retrieval)
6. [Strategy 5: Structured Scratchpad & Persistent Notes](#strategy-5-structured-scratchpad--persistent-notes)
7. [Strategy 6: Context Window Positioning (Beat the "Lost in the Middle" Problem)](#strategy-6-context-window-positioning)
8. [Strategy 7: Single-Agent with Focused Subprocesses (Not Multi-Agent)](#strategy-7-single-agent-with-focused-subprocesses)
9. [Putting It All Together: The Context Pipeline](#putting-it-all-together)
10. [Key Principles to Remember](#key-principles-to-remember)
11. [References](#references)

---

## The Core Problem

Your desktop agent talks to an LLM through OpenRouter. Every time you make an API call, you send a **context window** — a big blob of text that includes the system prompt, conversation history, tool results, file contents, etc. The model reads ALL of this before generating its next response.

Here's the catch:

### Context is a Finite, Degrading Resource

- **Context windows have a hard limit.** Even if a model supports 128K or 200K tokens, you can't just dump everything in there.
- **"Context Rot"** (coined by Chroma): As you add more tokens to the context window, the model's ability to accurately recall and use information from that context **drops**. It's not a cliff — it's a gradual decay. At 64K tokens, a model that was 95% accurate at 4K tokens might only be 78% accurate.
- **"Lost in the Middle"** (Stanford/Google research): Models pay the most attention to information at the **beginning** and **end** of the context window. Stuff in the middle gets partially ignored. This is a well-documented architectural limitation of the transformer attention mechanism.
- **Attention Budget**: Think of the model as having a fixed "attention budget." Every token you add depletes this budget. Irrelevant tokens don't just waste space — they actively interfere with the model's ability to focus on what matters.

> **The Golden Rule of Context Engineering:**  
> *Find the **smallest possible set** of **high-signal tokens** that maximize the likelihood of your desired outcome.*

This means context engineering is NOT about "give the model everything." It's about giving it **exactly what it needs, when it needs it, in the right format**.

---

## Strategy 1: Tiered Memory Architecture

### The "Operating System" Approach for LLMs

**Source:** MemGPT paper (arxiv 2310.08560), Manus blog, Anthropic context management

### What is it?

Just like your computer has RAM (fast, small) and a hard drive (slow, large), your agent should have multiple layers of memory:

```
┌─────────────────────────────────────────┐
│          TIER 1: Working Memory         │  ← What's in the context window RIGHT NOW
│     (System prompt + current task +     │     This is your "RAM"
│      recent messages + active files)    │     Size: Whatever the model allows
│                                         │     (aim for 30-60% of max window)
├─────────────────────────────────────────┤
│        TIER 2: Session Memory           │  ← Stored locally, pulled in on demand
│   (Conversation summaries, scratchpad   │     This is your "SSD"
│    notes, task progress, key decisions) │     Size: Unlimited, stored as files
├─────────────────────────────────────────┤
│        TIER 3: Long-Term Memory         │  ← Persists across sessions
│   (User preferences, project patterns, │     This is your "Hard Drive"
│    learned rules, past session logs)    │     Size: Unlimited, stored as JSON/DB
└─────────────────────────────────────────┘
```

### How to implement it in OpenClaw:

1. **Tier 1 (Working Memory):** Build each API call with only what the model needs for the **current step**. This includes:
   - System prompt (fixed, ~500-2000 tokens)
   - Current task description
   - Last 3-5 conversation turns (not the entire history)
   - Contents of files the model is actively editing
   - Results of the most recent tool call

2. **Tier 2 (Session Memory):** Keep a local JSON file or text file per conversation session:
   ```json
   {
     "session_id": "abc123",
     "task_summary": "User wants to refactor the auth module",
     "key_decisions": [
       "Decided to use JWT instead of sessions",
       "Error handling follows the Result pattern"
     ],
     "files_modified": ["src/auth.py", "src/middleware.py"],
     "current_step": "Implementing token refresh logic",
     "unresolved_issues": ["Need to handle token expiry edge case"]
   }
   ```
   Before each API call, read this file and inject a condensed version into the context.

3. **Tier 3 (Long-Term Memory):** Persist across sessions:
   - User's coding style preferences
   - Project-specific rules (e.g., "always use type hints", "tests go in `__tests__/`")
   - Patterns the agent has learned from corrections

### Why this works:
- Keeps the context window lean and focused
- Nothing important is ever truly "lost" — it's just moved to a different tier
- Mirrors how humans work: we don't remember everything, but we know where to look

### Watch out for:
- **Stale data:** Tier 2/3 can become outdated. Always re-verify critical information against actual files before using it.
- **Over-loading Tier 1:** Resist the urge to pull too much from Tier 2 back into working memory.

---

## Strategy 2: Conversation Compaction

### Intelligent Summarization When History Gets Too Long

**Source:** Anthropic (Claude Code), OpenHands SDK condenser, ACE paper (arxiv 2510.04618)

### What is it?

When your conversation history grows too large (approaching 50-70% of the context window), you **summarize it** and replace the old messages with the summary. This is the single most important technique for long-running coding sessions.

### How it works step by step:

```
BEFORE COMPACTION (hitting ~70% of context limit):
┌──────────────────────────────────────┐
│ System Prompt                        │
│ User: "Fix the login bug"           │
│ Agent: *reads 5 files*              │  ← Old tool results eating up space
│ Agent: *ran tests, got errors*      │  ← Raw test output (1000+ tokens)
│ User: "Also handle the edge case"   │
│ Agent: *edited 3 files*             │  ← Full file diffs
│ User: "Now add tests"              │
│ Agent: ???                          │  ← Context is almost full!
└──────────────────────────────────────┘

AFTER COMPACTION:
┌──────────────────────────────────────┐
│ System Prompt                        │
│ [CONVERSATION SUMMARY]:             │
│   "User asked to fix login bug in   │
│    src/auth.py. Root cause was       │
│    missing null check on line 42.    │
│    Fixed by adding validation.       │
│    Then handled edge case for        │
│    expired tokens. Modified files:   │
│    src/auth.py, src/middleware.py,   │
│    src/utils.py. All passing now.    │
│    Current task: Add unit tests."    │
│ User: "Now add tests"              │  ← Last few turns kept verbatim
│ Agent: ???                          │  ← Plenty of room now!
└──────────────────────────────────────┘
```

### Implementation approach:

1. **Track token count** of your messages array after every turn.
2. **When you hit 60-70% of max context**, trigger compaction.
3. **Send the full conversation to the model** with a special summarization prompt:

   ```
   Summarize this conversation for an AI coding agent that needs to continue
   the work. Preserve:
   - The original task/goal
   - All architectural decisions and WHY they were made
   - Current progress and what's left to do
   - Names/paths of ALL files that were modified
   - Any unresolved bugs or issues
   - Specific code patterns or conventions established

   Do NOT include:
   - Raw file contents (the agent can re-read files)
   - Full tool outputs (only keep key findings)
   - Intermediate failed attempts (only keep final working approach)
   ```

4. **Replace the old messages** with a single `[CONVERSATION_SUMMARY]` message + keep the last 2-3 turns verbatim.
5. **Optionally keep the last 3-5 file paths** so the agent can re-read them if needed.

### The "tool result clearing" shortcut:

Even before full compaction, you can do a lighter version: **clear old tool results**. If the model read a file 20 turns ago, it doesn't need the raw file content in the history anymore. Replace old tool results with a short note like:

```
[Tool result cleared - previously read src/auth.py (245 lines)]
```

This alone can save 30-50% of context space.

### Watch out for:
- **"Brevity bias"**: The summary model tends to be too brief. Always err on the side of keeping MORE detail, especially around decisions and file paths.
- **"Context collapse"**: If you compact too aggressively or too many times, each summary loses a little bit of nuance. After 3-4 compactions, important details can erode. Combat this by anchoring key facts in the scratchpad (Strategy 5).

---

## Strategy 3: Repository Map

### Token-Efficient Codebase Awareness

**Source:** Aider's `repomap.py`, Anthropic (Claude Code's approach)

### What is it?

Instead of dumping entire files into the context, give the model a **lightweight "map" of the codebase** — just the structure, function names, class names, and key identifiers. This lets the model understand the codebase's architecture using a fraction of the tokens.

### What a repo map looks like:

```
src/auth/
  login.py
    │ class LoginHandler
    │   def authenticate(username, password) → AuthResult
    │   def validate_token(token) → bool
    │   def refresh_token(old_token) → str
    │ class AuthResult
    │   success: bool
    │   token: str | None
    │   error: str | None

  middleware.py
    │ def require_auth(func) → Callable
    │ def extract_token(request) → str | None

  models.py
    │ class User(BaseModel)
    │   id: int
    │   username: str
    │   hashed_password: str
    │ class Session(BaseModel)
    │   user_id: int
    │   token: str
    │   expires_at: datetime

tests/
  test_auth.py
    │ class TestLogin
    │   def test_valid_credentials()
    │   def test_invalid_password()
    │   def test_expired_token()
```

### How Aider does it (simplified):

1. **Parse every file** in the repo using Tree-sitter (a fast code parser)
2. **Extract "tags"** — function names, class names, method signatures
3. **Build a graph** of which identifiers reference which other identifiers
4. **Rank files by relevance** using PageRank-like algorithm:
   - Files mentioned in the conversation get high priority
   - Files that define symbols used in high-priority files get medium priority
   - Everything else gets low priority
5. **Generate a compact text representation** that fits within a token budget (typically 1024-4096 tokens)

### How to implement a simpler version for OpenClaw:

You don't need the full PageRank approach. A simpler version that still works great:

1. **Walk the project directory** and build a tree of files
2. **For Python files**, use `ast` module to extract function/class definitions:
   ```python
   import ast

   def get_file_outline(filepath):
       with open(filepath) as f:
           tree = ast.parse(f.read())
       outline = []
       for node in ast.walk(tree):
           if isinstance(node, ast.FunctionDef):
               args = [a.arg for a in node.args.args]
               outline.append(f"  def {node.name}({', '.join(args)})")
           elif isinstance(node, ast.ClassDef):
               outline.append(f"  class {node.name}")
       return outline
   ```
3. **Include this map in the system prompt** or as the first message, so the model always knows the project structure
4. **Update the map** whenever files change

### Why this is so powerful:
- A 50-file project that would take 100K+ tokens to fully include might only need 2K-4K tokens as a repo map
- The model can then **ask for specific files** when it needs the full content, instead of you pre-loading everything
- It prevents the "I don't know what files exist" problem that causes agents to waste turns exploring

### Watch out for:
- **Stale maps:** If you cache the map, make sure to invalidate it when files change (check mtimes, like Aider does)
- **Binary/non-code files:** Don't try to parse images, compiled files, etc. Just list them by name.

---

## Strategy 4: Just-In-Time Context Retrieval

### Load Data On Demand, Not Up Front

**Source:** Anthropic (Claude Code), Manus blog, LangChain context engineering guide

### What is it?

Instead of pre-loading all potentially relevant files/data into the context window, give the model **tools to fetch specific information when it needs it**. The model decides what to read, when.

### The analogy:

Think of it like the difference between:
- ❌ **Photocopying an entire library** and handing it to someone before they start working
- ✅ **Giving them a library card** and letting them check out books as needed

### What tools to provide:

```
Tools your agent should have:

1. read_file(path)         → Returns file contents
2. search_files(query)     → Grep/ripgrep through the codebase
3. list_directory(path)    → See what files exist in a folder
4. read_file_lines(path, start, end) → Read specific lines (NOT the whole file)
5. run_command(cmd)        → Execute shell commands for exploration
```

### The key insight — lightweight references:

Instead of keeping full file contents in context, keep **references**:

```
❌ BAD: Loading entire file into context
   [Full contents of src/auth.py - 500 lines, ~3000 tokens]

✅ GOOD: Keeping a lightweight reference
   "Previously examined src/auth.py (500 lines).
    Key findings: LoginHandler class at L42, authenticate() at L55,
    null check missing at L67. File re-readable via read_file tool."
```

This reference takes ~50 tokens instead of ~3000, but the model can re-read the file if it needs the actual code.

### How Claude Code does this:

Claude Code uses a **hybrid approach**:
- **Pre-loaded at start:** `CLAUDE.md` files (project-specific instructions) — small, always relevant
- **Loaded on demand:** Everything else. The agent uses `grep`, `find`, `cat`, `head`, `tail` to explore the codebase as needed
- **Never fully loaded:** Large files (databases, logs, etc.) — the agent writes targeted queries or uses `head`/`tail` to sample

### Implementation for OpenClaw:

```python
# Pseudo-code for your context builder

def build_context(system_prompt, conversation, current_task):
    context = []

    # Always included (small, always relevant)
    context.append({"role": "system", "content": system_prompt})

    # Include project rules if they exist (like CLAUDE.md)
    rules_file = find_project_rules()  # .openclaw, README.md, etc.
    if rules_file and token_count(rules_file) < 1000:
        context.append({"role": "system", "content": rules_file})

    # Include repo map (small, gives structural awareness)
    repo_map = generate_repo_map()
    context.append({"role": "system", "content": f"Project structure:\n{repo_map}"})

    # Include compacted history (NOT full raw history)
    context.extend(get_compacted_history(conversation))

    # Include scratchpad/notes if they exist
    notes = read_scratchpad()
    if notes:
        context.append({"role": "system", "content": f"Your working notes:\n{notes}"})

    # DON'T pre-load files. Let the model use tools to read them.
    return context
```

### Watch out for:
- **Tool call overhead:** Each tool call is a round trip. If you KNOW the model will need a specific file (e.g., the user said "fix auth.py"), pre-load it. Don't make the model waste a turn asking for it.
- **The "blind exploration" problem:** Without a repo map, the model might waste 5-10 turns just figuring out what files exist. Always provide structural awareness (Strategy 3) alongside just-in-time retrieval.

---

## Strategy 5: Structured Scratchpad & Persistent Notes

### External Memory the Agent Controls Itself

**Source:** Anthropic (Claude Code TODO lists, Claude Plays Pokémon), Manus (file-based memory), ACE paper

### What is it?

Give the model a **file it can write to** that persists across compactions and even across sessions. The model uses this as its own notepad — tracking progress, recording decisions, saving important findings.

### Why this is different from conversation history:

- Conversation history is **append-only** and grows forever → eventually gets compacted/lost
- A scratchpad is **editable** — the model can update, reorganize, and prune its notes
- It **survives compaction** — when you summarize the conversation, the scratchpad remains intact
- It's a **single source of truth** — instead of facts being scattered across 50 conversation turns

### What to put in the scratchpad:

```markdown
# OpenClaw Working Notes
## Session: 2026-10-13

### Current Task
Refactoring the authentication module to support OAuth2

### Progress
- [x] Analyzed existing auth code in src/auth/
- [x] Identified 3 files that need changes: login.py, middleware.py, models.py
- [ ] Implement OAuth2 token exchange
- [ ] Update middleware to validate OAuth tokens
- [ ] Write tests

### Key Decisions
- Using `authlib` library (user preference, stated in turn 3)
- Keeping backward compatibility with existing JWT tokens
- Storing OAuth tokens in the same Session model (added provider field)

### Important Findings
- `middleware.py:L45` has a race condition in token refresh (noted in turn 7)
- The User model has a unique constraint on email that might conflict with OAuth
- Test database uses SQLite, production uses PostgreSQL — need to account for this

### Files Modified This Session
- src/auth/login.py (added OAuth2Flow class)
- src/auth/models.py (added provider field to Session)
```

### How to implement it:

1. **Create a tool** called `update_notes` or `write_scratchpad`:
   ```
   Tool: update_notes
   Description: Write or update your working notes. These notes persist
                across conversation resets. Use them to track progress,
                record decisions, and save important findings.
   Parameters:
     - content (string): The full updated content of your notes
   ```

2. **Inject the scratchpad** into the context at the start of every conversation and after every compaction:
   ```
   [Your persistent working notes from previous context]:
   {scratchpad_contents}
   ```

3. **Instruct the model** in the system prompt to use the scratchpad:
   ```
   You have a persistent scratchpad. After completing significant work steps,
   update your notes with key findings, decisions, and progress. These notes
   survive when conversation history is summarized. Use them as your source
   of truth.
   ```

### The Claude Plays Pokémon example:

This is a real-world proof that scratchpads work at scale. The agent maintained:
- Precise counts ("trained Pikachu for 1,234 steps, gained 8/10 target levels")
- Maps of explored regions
- Combat strategy notes
- Long-term strategic plans

All of this survived across thousands of context resets because it was stored in the scratchpad, not in conversation history.

### Watch out for:
- **Scratchpad bloat:** If the model never prunes its notes, the scratchpad itself can grow too large. Set a soft limit (e.g., 2000 tokens) and instruct the model to keep it concise.
- **Conflicting information:** After many updates, old notes might conflict with new ones. Instruct the model to overwrite old entries rather than appending.

---

## Strategy 6: Context Window Positioning

### Beat the "Lost in the Middle" Problem

**Source:** "Lost in the Middle" paper (arxiv 2307.03172), Chroma "Context Rot" research

### What is it?

Research shows that LLMs pay the most attention to information at the **beginning** and **end** of the context window, and significantly less attention to stuff in the **middle**. This is called the "Lost in the Middle" effect.

### The attention curve looks like this:

```
Attention
Level
  |  ████                                           ████
  |  ████                                           ████
  |  ████                                           ████
  |  ████  ██                                   ██  ████
  |  ████  ████                             ████    ████
  |  ████  ████  ██                     ██  ████    ████
  |  ████  ████  ████  ████  ████  ████  ████  ████  ████
  └──────────────────────────────────────────────────────►
    START            MIDDLE (danger zone)              END
    of context                                    of context
```

### How to use this knowledge:

**Put the most important information at the BEGINNING and END of your context:**

```
┌─────────────────────────────────────────────────────┐
│ TOP (HIGH ATTENTION ZONE)                           │
│                                                     │
│  → System prompt with core instructions             │
│  → Project rules & constraints                      │
│  → Repo map / structural overview                   │
│  → Scratchpad / working notes                       │
│                                                     │
├─────────────────────────────────────────────────────┤
│ MIDDLE (LOW ATTENTION ZONE)                         │
│                                                     │
│  → Old conversation turns                           │
│  → Previous tool results                            │
│  → Background context / docs                        │
│  → Compacted summaries from older sessions          │
│                                                     │
├─────────────────────────────────────────────────────┤
│ BOTTOM (HIGH ATTENTION ZONE)                        │
│                                                     │
│  → Most recent user message                         │
│  → Current task / active question                   │
│  → Most recent tool results                         │
│  → Current file being edited (if applicable)        │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### Practical implementation:

When building your messages array for the API call, order it like this:

```python
messages = [
    # TOP - High attention
    {"role": "system", "content": system_prompt},           # Core instructions
    {"role": "system", "content": project_rules},           # Project-specific rules
    {"role": "system", "content": repo_map},                # Structural awareness
    {"role": "system", "content": scratchpad},              # Working notes

    # MIDDLE - Lower attention (okay for less critical info)
    *old_conversation_turns,                                # Historical context
    *compacted_summaries,                                   # Older session summaries

    # BOTTOM - High attention (most recent, most relevant)
    {"role": "user", "content": current_user_message},      # What to do now
    {"role": "assistant", "content": last_agent_response},  # Most recent response
    *recent_tool_results,                                   # Latest tool outputs
]
```

### Watch out for:
- **Don't over-optimize:** This is about strategic placement, not obsessive ordering. The effect is real but gradual — it's not like the model IGNORES the middle entirely.
- **The recency bias is your friend:** The model naturally pays more attention to recent turns. Use this — put the most actionable info in the last few messages.

---

## Strategy 7: Single-Agent with Focused Subprocesses

### Don't Build Multi-Agent — Build Smart Single-Agent with Context Isolation

**Source:** Cognition (Devin) blog "Don't Build Multi-Agent Systems", Anthropic managed agents, Anthropic sub-agent architecture

### What is it?

Instead of building multiple independent agents that talk to each other (multi-agent), build **one primary agent** that can spawn **focused subprocesses** for specific tasks. Each subprocess gets a clean, focused context window and returns only a condensed result.

### Why NOT multi-agent:

Cognition (the team behind Devin) found that multi-agent systems have fundamental problems:
- **Context fragmentation:** Each agent only sees part of the picture
- **Coordination overhead:** Agents waste tokens talking to each other
- **Error propagation:** One confused agent can derail the entire system
- **Debugging nightmare:** When something goes wrong, you can't tell which agent made the mistake

### What to do instead — Focused Subprocesses:

```
┌──────────────────────────────────────────────────┐
│            MAIN AGENT (OpenClaw)                  │
│  Has: Full conversation history, user context,   │
│       project understanding, scratchpad          │
│                                                  │
│  When it needs deep work on a subtask:           │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  SUBPROCESS: "Search the codebase for all  │  │
│  │  uses of deprecated API and suggest fixes" │  │
│  │                                            │  │
│  │  Gets: Clean context + specific task       │  │
│  │  Does: Deep exploration (50K+ tokens)      │  │
│  │  Returns: Condensed summary (1-2K tokens)  │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  Main agent incorporates the summary and         │
│  continues with full context intact.             │
└──────────────────────────────────────────────────┘
```

### How this helps context:

- The main agent's context stays **clean** — it gets a 1K summary instead of 50K of search results
- The subprocess gets a **focused context** — only what it needs for its specific task, no irrelevant history
- Each subprocess can use the **full context window** for its task without competing with conversation history

### Implementation for OpenClaw:

```python
def handle_complex_task(main_context, subtask_description):
    # 1. Main agent decides it needs a focused search/analysis
    # 2. Spawn a subprocess with minimal context
    subprocess_messages = [
        {"role": "system", "content": "You are a focused code analysis tool. "
                                       "Perform the following task and return "
                                       "a concise summary of findings."},
        {"role": "user", "content": subtask_description}
    ]

    # 3. Subprocess does its work (might use 50K+ tokens internally)
    subprocess_result = call_openrouter(subprocess_messages)

    # 4. Main agent gets only the condensed result
    main_context.append({
        "role": "assistant",
        "content": f"[Analysis complete]: {subprocess_result[:2000]}"
    })
```

### When to spawn a subprocess:

- **Searching across many files** (grep through entire codebase)
- **Analyzing large outputs** (test results, build logs)
- **Research tasks** (reading documentation, exploring APIs)
- **Code review** (reviewing a large diff)

### Watch out for:
- **Don't over-use subprocesses:** If a task is simple enough to do in the main context, just do it there. Subprocesses add latency (extra API call) and cost.
- **Keep the subprocess result concise:** The whole point is to get a small summary back. If the subprocess returns 10K tokens, you've defeated the purpose.

---

## Putting It All Together

### The Complete Context Pipeline for OpenClaw

Here's how all 7 strategies work together in a single API call:

```
USER SENDS MESSAGE
        │
        ▼
┌─── BUILD CONTEXT ────────────────────────────────────────┐
│                                                          │
│  1. Start with system prompt                    [TOP]    │
│  2. Add project rules (from .openclaw file)     [TOP]    │
│  3. Add repo map (auto-generated outline)       [TOP]    │
│  4. Add scratchpad/working notes (Strategy 5)   [TOP]    │
│  5. Add compacted history (Strategy 2)          [MIDDLE] │
│  6. Add recent tool results                     [BOTTOM] │
│  7. Add current user message                    [BOTTOM] │
│                                                          │
│  TOTAL: Should be 30-70% of max context window           │
│  (Leave room for the model's response + tool calls)      │
│                                                          │
└──────────────────────────────────────────────────────────┘
        │
        ▼
   SEND TO OPENROUTER
        │
        ▼
   MODEL RESPONDS (might use tools)
        │
        ├── If tool call → execute tool, add result, loop back
        │
        ├── If needs deep analysis → spawn subprocess (Strategy 7)
        │                            get summary, add to context
        │
        ├── If context > 60% full → trigger compaction (Strategy 2)
        │                           save key facts to scratchpad
        │
        └── Return response to user
```

### Token budget allocation (recommended):

| Component | Budget | Notes |
|-----------|--------|-------|
| System prompt | 500-2000 tokens | Core instructions, personality, rules |
| Project rules | 200-1000 tokens | From .openclaw or similar config |
| Repo map | 1000-4000 tokens | Auto-generated, refresh on file changes |
| Scratchpad | 500-2000 tokens | Agent's working notes |
| Compacted history | 2000-8000 tokens | Summarized conversation |
| Recent turns | 2000-6000 tokens | Last 3-5 turns, verbatim |
| Active file contents | 2000-8000 tokens | Only currently-edited files |
| **Reserved for response** | **4000-8000 tokens** | **Always leave room!** |

---

## Key Principles to Remember

### 1. "Treat Context as RAM, Not a Logfile"
Don't just append forever. Actively manage what's in and what's out.

### 2. "The Best Token is the One You Don't Send"
Every token that isn't directly useful to the current task is actively hurting performance. Be ruthless about relevance.

### 3. "Summarize Decisions, Not Discussions"
Instead of keeping 20 turns of back-and-forth about whether to use JWT or sessions, keep one line: "Decided: JWT for auth (rationale: stateless, better for API)."

### 4. "Let the Model Drive Exploration"
Pre-loading everything is a losing strategy. Give the model tools and let it pull in what it needs. It's smarter than you think at knowing what to look for.

### 5. "Anchor Critical Facts Outside the Chat"
Anything that MUST survive across compactions should be in the scratchpad or a persistent file, not just in conversation history. Conversation history is ephemeral; scratchpads are durable.

### 6. "Position Matters"
Put the most important context at the top and bottom of the window. Let less critical historical context live in the middle.

### 7. "One Smart Agent > Many Dumb Agents"
Keep a single agent with great context management. Use subprocesses for intensive subtasks, but always funnel results back through the main agent.

---

## References

| # | Source | Key Takeaway |
|---|--------|--------------|
| 1 | [Anthropic — Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Context is a finite resource with diminishing returns. Compaction, note-taking, and sub-agents are the three pillars. |
| 2 | [Manus — Context Engineering Lessons from Building Manus](https://manus.im/en/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) | KV-cache aware design, file-based memory over in-context memory, "todo list" driven execution. |
| 3 | [LangChain — Context Engineering for Agents](https://langchain.com/blog/context-engineering-for-agents) | Context = instructions + tools + state + memory + retrieval. Each must be independently optimized. |
| 4 | [Cognition — Don't Build Multi-Agent Systems](https://cognition.com/blog/dont-build-multi-agents) | Single-agent with context isolation > multi-agent coordination. Context fragmentation kills multi-agent reliability. |
| 5 | [Anthropic — Context Management on Developer Platform](https://www.anthropic.com/news/context-management) | Tool result clearing and memory tools as first-class primitives for context management. |
| 6 | [Lost in the Middle (arxiv 2307.03172)](https://arxiv.org/abs/2307.03172) | Models degrade on information in the middle of long contexts. Place critical info at beginning and end. |
| 7 | [MemGPT — LLMs as Operating Systems (arxiv 2310.08560)](https://arxiv.org/abs/2310.08560) | Tiered memory architecture inspired by OS virtual memory. Move data between fast/slow tiers intelligently. |
| 8 | [ACE — Agentic Context Engineering (arxiv 2510.04618)](https://arxiv.org/abs/2510.04618) | Treat contexts as "evolving playbooks" — prevent context collapse with structured, incremental updates. |
| 9 | [Chroma — Context Rot](https://github.com/chroma-core/context-rot) | Quantified proof that adding more tokens degrades retrieval accuracy. Accuracy drops measurably with context length. |
| 10 | [Aider — RepoMap](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py) | Tree-sitter based repo mapping with PageRank relevance scoring. Token-efficient codebase awareness. |
| 11 | [OpenHands — Context Condenser](https://github.com/OpenHands/software-agent-sdk/tree/main/openhands-sdk/openhands/sdk/context/condenser) | Pluggable condensation strategies: recent-events, LLM-based summarization, hybrid approaches. |
| 12 | [Anthropic — Managed Agents](https://anthropic.com/engineering/managed-agents) | Orchestrator-worker pattern for multi-agent systems, with context isolation between workers. |

---

> **Bottom Line:** Context engineering is not about having the biggest context window. It's about having the **smartest context window**. A well-engineered 16K-token context will outperform a lazy 128K-token context dump every single time. Build your OpenClaw agent with these strategies, and your OpenRouter model will perform like it's 10x smarter than it actually is — because it'll always have exactly the right information at exactly the right time.
