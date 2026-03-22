# ?ï∏Ô∏?Arachne (n2-arachne)

[![npm version](https://img.shields.io/npm/v/n2-arachne.svg)](https://www.npmjs.com/package/n2-arachne)
[![License](https://img.shields.io/badge/license-Dual%20(Apache--2.0%20%2B%20Commercial)-blue.svg)](LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/n2-arachne.svg)](https://www.npmjs.com/package/n2-arachne)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org)

**[?úÍµ≠??(README.ko.md)** | English | **[?•Êú¨Ë™?(README.ja.md)**

> Weave your codebase into the perfect context for AI ??like Arachne, the greatest weaver of Greek mythology. ?ï∑Ô∏?

## ?§î The Problem ??Why AI Gets Your Code Wrong

Imagine going to a doctor and saying **"I have a headache."**

- ??**Bad doctor**: reads your entire 500-page medical history, gets confused, prescribes the wrong medicine
- ??**Good doctor**: looks at relevant records only ??recent symptoms, medications, allergies ??and nails the diagnosis

**AI coding assistants are like that bad doctor.**

When your project has 500 files, AI can't read them all. So what happens?

```
?ìÇ Your Project (500 files, 2M tokens)
??
?ú‚??Ä auth/login.ts        ???éØ The bug is HERE
?ú‚??Ä auth/session.ts      ???îó login imports this
?ú‚??Ä api/http.ts          ???îó session imports this
?ú‚??Ä utils/config.ts      ???ôÔ∏è timeout settings live here
??
?ú‚??Ä pages/home.tsx       ????completely irrelevant
?ú‚??Ä pages/about.tsx      ????completely irrelevant
?ú‚??Ä components/Button.tsx ????completely irrelevant
?î‚??Ä ... 493 more files    ????all irrelevant
```

| Approach | What AI receives | Result |
|----------|-----------------|--------|
| ??Dump everything | 2,000,000 tokens | Exceeds context window, AI confused |
| ??Random files | ~50,000 tokens | Misses critical code, wrong fix |
| ??**Arachne** | **30,000 tokens** (4 relevant files) | Precise fix, every time |

> **Tokens** = units of text AI reads. More tokens = more cost, slower, less accurate.
> AI has a limited "context window" ??like a desk that can only hold so many papers.

### ?ìä Real-World Benchmark (N2 Browser ??3,219 files)

| Metric | Value |
|--------|:-----:|
| **Project size** | 3,219 files, **4.68M tokens** |
| **Arachne output** | **14,074 tokens** |
| **Compression** | **333x** (99.7% reduction) |
| **Index time** | 627ms (incremental: 0ms) |
| **DB size** | 24 MB |

> *Measured on a real production project. Arachne delivered exactly what AI needed ??333x less data, same accuracy.*

---

## ?ï∑Ô∏?The Solution ??Arachne Picks Exactly What AI Needs

Arachne is a **local MCP server** that acts like that good doctor. It reads your entire codebase once, understands the structure, and **only sends what's relevant** to AI.

```
You: "Fix the login timeout bug"
                ??
                ??
?å‚??Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä??
?? ?ï∑Ô∏?Arachne: "I'll find exactly what you need"      ??
??                                                     ??
?? L1 ?ìÅ Project tree (so AI knows the structure)      ??
?? L2 ?ìÑ login.ts (the file you're working on)         ??
?? L3 ?îó http.ts, session.ts (found via search +       ??
??       dependency chain: login ??session ??http)     ??
?? L4 ?ôÔ∏è config.ts (frequently accessed, has timeout)  ??
??                                                     ??
?? ??30,000 tokens of perfectly curated context        ??
?î‚??Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä??
                ??
                ??
        AI generates accurate fix ??
```

**No manual file selection. No prompt engineering. Just ask.**

---

### Why Arachne?

- ?í∞ **98.5% token savings** ??30K instead of 2M tokens. Real money saved on API calls
- ?ß† **Beats "Lost in the Middle"** ??Smart output ordering (L1?íL3?íL4?íL2) keeps critical code where AI pays attention ([research-backed](https://arxiv.org/abs/2307.03172))
- ?îì **Zero external deps** ??No Docker, no cloud, no API keys. Just `npm install` and go
- ??**Blazing fast** ??21 files indexed in 12ms. Incremental updates in sub-second
- ?ì¶ **Ultralight** ??Only 3 deps: `better-sqlite3`, `sqlite-vec`, `zod`. No bloat
- ?Üì **Free for personal & open-source use** ??Dual license (Apache-2.0 + Commercial), no telemetry
- ?îå **Plug & play** ??Add MCP config ??done. Zero code changes to your project
- ?åç **Multi-language** ??Follows import chains across JS/TS, Python, Rust, Go, **Java**
- ?¶ô **Ollama optional** ??Works perfectly without Ollama (BM25 search). Add Ollama for bonus semantic search

### ?ï∑Ô∏?Arachne in 4 Panels

![What is Arachne? ??AI gets 500 files but can't find the bug. Arachne picks the 4 relevant files. 30K tokens, perfect fix every time.](docs/arachne-comic.png)

### ?§ù Soul + Arachne Synergy

![Soul remembers past sessions. Arachne finds the code. Together, AI never forgets and never misses.](docs/soul-synergy-comic.png)

## ??Key Features

| Feature | Description |
|---------|-------------|
| ?îå **MCP Standard** | Works with Claude, Gemini, GPT, Ollama ??any AI provider |
| ?íæ **Local-First** | All indexing in local SQLite. Zero data leaves your machine |
| ??**Incremental** | Only re-indexes changed files. Sub-second updates |
| ?ß† **Hybrid Search** | BM25 keyword + semantic vector search (Ollama embeddings) |
| ?ï∏Ô∏?**4-Layer Assembly** | Smart context paging within token budget |
| ?îó **Dependency Graph** | Follows import chains across JS/TS, Python, Rust, Go, **Java** |
| ?óÉÔ∏?**Backup & Restore** | SQLite online backup with in-backup search |

## ?èóÔ∏?Architecture: 4-Layer Context Assembly

```
?å‚??Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä??
??             Token Budget (e.g. 30K)        ??
?ú‚??Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?¨‚??Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä??
??L1: Fixed  ??File tree overview (10%)       ??
??(always)   ??Project structure snapshot     ??
?ú‚??Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?º‚??Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä??
??L2: Short  ??Current file + recent (20%)   ??
??(context)  ??What you're working on now     ??
?ú‚??Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?º‚??Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä??
??L3: Assoc  ??Search + dependencies (50%) ????
??(relevant) ??BM25 + semantic + dep chain   ??
?ú‚??Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?º‚??Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä??
??L4: Spare  ??Frequently accessed (20%)     ??
??(backup)   ??Files you use most            ??
?î‚??Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?¥‚??Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä??

Output order: L1 ??L3 ??L4 ??L2  (mitigates "Lost in the Middle")
```

## ?ß† Semantic Search (Optional, Zero Lock-in)

When Ollama is available, Arachne upgrades from keyword-only to **hybrid search**:

```
BM25 Score (keyword) ?Ä?Ä??
                       ?ú‚??Ä Weighted Merge (Œ±=0.5) ??Best Results
Cosine Similarity ?Ä?Ä?Ä?Ä?Ä??
(nomic-embed-text 768D)
```

- **sqlite-vec** for SIMD-accelerated (AVX2/SSE2/Neon) KNN vector search
- **768-dimensional** embeddings via Ollama `nomic-embed-text` ??runs 100% local
- **Graceful degradation**: No Ollama? Falls back to BM25-only. **Zero crashes. Always works.**
- Enable in config: `embedding.enabled = true`
- Vector storage: ~3KB per chunk. 5000 chunks = just 15MB on disk

## ??Java Support ??Built for Enterprise

Arachne provides **first-class Java support**, designed for large-scale enterprise codebases (5M+ LOC):

| Feature | Description |
|---------|-------------|
| **Smart Chunking** | Detects `class`, `interface`, `enum`, `method`, `@interface` (annotations) |
| **Large Class Splitting** | Classes over 500 tokens are **automatically sub-chunked** into individual methods |
| **Import Resolution** | Parses `import com.example.Service` and `import static org.junit.Assert.*` |
| **Access Modifiers** | Handles `public`, `private`, `protected`, `abstract`, `final`, `synchronized` |
| **Generics** | Correctly processes `<T extends Comparable<T>>` and complex generic types |
| **Spring/JUnit** | Tested with Spring Boot `@RestController`, JUnit5 static imports, Mockito |
| **Binary Exclusion** | Automatically ignores `.class`, `.jar`, `.war`, `.ear` files |

### How Large Class Sub-Chunking Works

```
// 500+ token class ??automatically split into methods
public class UserService {       // ??detected as container
    public User findById() {}    // ??sub-chunk 1
    public List<User> findAll()  // ??sub-chunk 2
    public User save() {}        // ??sub-chunk 3
    // ... fields, constructor   // ??remainder chunk
}

// Small class (<500 tokens) ??kept as single chunk (no overhead)
public class TinyDTO { ... }     // ??single chunk, efficient
```

> ?éØ **Why this matters for 5M LOC projects**: A single Java class can have 50+ methods spanning thousands of lines. Without sub-chunking, AI would receive the entire class as one blob. With Arachne, AI gets individual methods ??enabling precise, targeted code generation.

### ?í∞ Token Impact: Less Is More

```
Without sub-chunking:
  AI asks: "Fix the findById bug"
  ??BM25 hits UserService class
  ??Entire class sent: 6,000 tokens  ?í∏

With sub-chunking:
  AI asks: "Fix the findById bug"
  ??BM25 hits findById() method only
  ??Just the method sent: 80 tokens   ?í∞ 75x savings!
```

> Sub-chunking doesn't cost extra ??it **saves** tokens by sending only what's relevant instead of entire classes.

## ?õ°Ô∏?Stability: 104 Tests, Zero Failures

Arachne is built for production. Every edge case is tested:

| Category | What's Tested |
|----------|---------------|
| ?íâ SQL Injection | 5 attack patterns including Bobby Tables |
| ?õ°Ô∏?Null/Empty Input | null, undefined, empty string ??safe return |
| ?êò Huge Input | 10KB queries ??no crash |
| ?î£ Special Characters | Unicode, emoji, regex chars ??handled |
| ?îå Ollama Disconnect | Bad endpoint ??graceful BM25 fallback |
| ?îÑ Idempotency | Triple re-indexing ??same result |
| ?í∞ Extreme Budgets | Budget 0, 1, 1M ??all safe |
| ?ìä Edge topK | topK = -1, 0, 99999 ??no crash |
| ?íæ Schema Safety | Triple init ??data survives |

```
Phase 1 (Indexing/Search):    15/15 ??
Phase 2 (Assembly/Deps):      26/26 ??
Phase 3 (Semantic/Hybrid):    19/19 ??
Stability (Reddit-proof):     44/44 ??
?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä
Total:                       104/104 ??
```

## ?ì¶ Installation

> ?í° **Pro tip**: The best way to install? Just ask your AI agent: *"Install n2-arachne for me."* It knows what to do. ?ï∑Ô∏?

```bash
npm install n2-arachne
```

### MCP Config (Claude Desktop / Cursor / etc.)

```json
{
  "mcpServers": {
    "n2-arachne": {
      "command": "node",
      "args": ["/path/to/n2-arachne/index.js"],
      "env": {
        "ARACHNE_PROJECT_DIR": "/path/to/your/project"
      }
    }
  }
}
```

## ?îß Configuration

Create `config.local.js` in the Arachne directory:

```javascript
module.exports = {
    projectDir: '/path/to/your/project',
    dataDir: './data',

    indexing: {
        autoIndex: true,
        maxFileSize: 512 * 1024,    // 512KB max per file
    },

    // Enable semantic search (requires Ollama)
    embedding: {
        enabled: true,              // default: false
        provider: 'ollama',
        model: 'nomic-embed-text',
        endpoint: 'http://localhost:11434',
    },

    assembly: {
        defaultBudget: 30000,       // tokens
    },
};
```

## ?? Usage (MCP Tool)

Arachne registers a single MCP tool `n2_arachne` with these actions:

| Action | Description |
|--------|-------------|
| `search` | BM25 keyword search (+ semantic if enabled) |
| `assemble` | 4-Layer context assembly within token budget |
| `index` | Index/re-index project files |
| `status` | Show indexing stats + embedding status |
| `files` | List indexed files |
| `backup` | Create/list/restore backups |

### Example: Assemble Context

```json
{
  "action": "assemble",
  "query": "HTTP request timeout error handling",
  "activeFile": "lib/executor.js",
  "budget": 20000
}
```

## ?îó Connect with Soul / QLN

Arachne works great standalone, but becomes far more powerful with **Soul** (session memory) and **QLN** (tool routing).

Setup is simple ??just register them together in your MCP config:

### Soul + Arachne Together

```json
{
  "mcpServers": {
    "n2-soul": {
      "command": "node",
      "args": ["/path/to/n2-soul/index.js"]
    },
    "n2-arachne": {
      "command": "node",
      "args": ["/path/to/n2-arachne/index.js"],
      "env": {
        "ARACHNE_PROJECT_DIR": "/path/to/your/project"
      }
    }
  }
}
```

> ?í° **Zero extra config needed!** Register both servers in the same MCP config and AI automatically uses both tools.
> - `Soul` remembers past session work and decisions
> - `Arachne` finds the exact code and delivers it to AI
> - Result: AI picks up right where you left off ??no "what was I working on?"

### Full N2 Stack (Soul + Arachne + QLN)

```json
{
  "mcpServers": {
    "n2-soul": {
      "command": "node",
      "args": ["/path/to/n2-soul/index.js"]
    },
    "n2-arachne": {
      "command": "node",
      "args": ["/path/to/n2-arachne/index.js"],
      "env": {
        "ARACHNE_PROJECT_DIR": "/path/to/your/project"
      }
    },
    "n2-qln": {
      "command": "node",
      "args": ["/path/to/n2-qln/index.js"]
    }
  }
}
```

> Add QLN and even with 100+ MCP tools, AI automatically finds and uses only what it needs via QLN's semantic routing.

## ?åê N2 Ecosystem ??Better Together

| Package | Role | npm | Standalone |
|---------|------|-----|:----------:|
| **QLN** | Tool routing (1000+ tools ??1 router) | `n2-qln` | ??|
| **Soul** | Agent memory & session management | `n2-soul` | ??|
| **Ark** | Security policies & code verification | `n2-ark` | ??|
| **Arachne** | Code context auto-assembly ?ï∏Ô∏?| `n2-arachne` | ??|

> Every package works **100% standalone**. But when combined, magic happens:

### ?îó Synergy: How They Work Together

```
User: "Fix the login timeout bug"
     ??
     ??
?å‚??Ä?Ä QLN (Router) ?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä??
??1000+ tools ??Semantic routing finds:                 ??
??  ??n2_arachne.assemble (context)                     ??
??  ??n2_arachne.search (code search)                   ??
??Token cost: 2 tool defs instead of 1000+              ??
?î‚??Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?¨‚??Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä??
                 ??
                 ??
?å‚??Ä?Ä Arachne (Context) ?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä??
??L1: Project tree overview                              ??
??L2: auth/login.ts (current file)                       ??
??L3: BM25 + semantic search ??timeout-related code      ??
??    + dependency chain: login.ts ??api.ts ??http.ts    ??
??L4: Frequently accessed config files                   ??
????30K tokens of perfectly curated context              ??
?î‚??Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?¨‚??Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä??
                 ??
                 ??
?å‚??Ä?Ä Soul (Memory) ?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä??
??"Last session, Rose fixed a similar timeout in         ??
?? api.ts line 47. Decision: increased to 30s."          ??
????Past context + decisions + handoff notes             ??
????KV-Cache: instant session restoration                ??
?î‚??Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?¨‚??Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä??
                 ??
                 ??
?å‚??Ä?Ä Ark (Security) ?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä??
????No hardcoded credentials in generated code          ??
????Timeout value from config, not magic number         ??
????Error handling follows project conventions           ??
????Code verification before commit                      ??
?î‚??Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä?Ä??
```

### ?ìä Solo vs Combined

| Scenario | Solo | Combined |
|----------|------|----------|
| **Token usage** | AI sees all 1000+ tools | QLN routes ??AI sees 2-3 tools |
| **Context quality** | AI guesses which files matter | Arachne provides exact relevant code |
| **Memory** | AI forgets everything each turn | Soul remembers past sessions + decisions |
| **Code safety** | No guardrails | Ark validates before deploy |
| **Setup** | Each tool works independently | Zero extra config ??auto-detection |

### ?í° Real-World Impact

- **QLN + Arachne**: QLN routes the request to Arachne ??Arachne provides perfect context ??AI generates accurate code on the first try. No more "which file was that in?"
- **Soul + Arachne**: Soul remembers what you worked on last session ??Arachne indexes those files with higher priority ??continuity across sessions
- **Ark + Arachne**: Arachne provides code context ??AI generates code ??Ark validates it follows project patterns. Catch bugs before they ship.
- **All 4 together**: The AI becomes a team member who **remembers everything**, **finds anything**, **uses the right tools**, and **follows the rules**.

## ?ìÑ License

This project is **dual-licensed**:

| Use Case | License | Cost |
|----------|---------|------|
| Personal / Educational | Apache 2.0 | **Free** |
| Open-source (non-commercial) | Apache 2.0 | **Free** |
| Commercial / Enterprise | Commercial License | [Contact us](mailto:lagi0730@gmail.com) |

See [LICENSE](./LICENSE) for full details.

## ‚≠?Star History

If you find Arachne helpful, please consider giving us a star! ‚≠?


---

> *"Arachne ??the greatest weaver. Your code, perfectly woven."* ?ï∑Ô∏?

?åê [nton2.com](https://nton2.com) ¬∑ ?ì¶ [npm](https://www.npmjs.com/package/n2-arachne) ¬∑ ?âÔ∏è lagi0730@gmail.com

<sub>?åπ Built by Rose ??N2's first AI agent. I wove this context engine, and I wrote this README too.</sub>

