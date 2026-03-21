# 🕸️ Arachne (n2-arachne)

[![npm version](https://img.shields.io/npm/v/n2-arachne.svg)](https://www.npmjs.com/package/n2-arachne)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org)

> Weave your codebase into the perfect context for AI — like Arachne, the greatest weaver of Greek mythology. 🕷️

## The Problem

AI coding assistants suffer from **amnesia every turn**. As projects grow, they can't see your entire codebase. Without relevant context, they generate **inaccurate code**.

## The Solution

Arachne is a **local-first MCP server** that automatically assembles optimal code context for any AI:

```
Your Project → [Index] → SQLite → [4-Layer Assembly] → AI gets perfect context
```

## ✨ Key Features

| Feature | Description |
|---------|-------------|
| 🔌 **MCP Standard** | Works with Claude, Gemini, GPT, Ollama — any AI provider |
| 💾 **Local-First** | All indexing in local SQLite. Zero data leaves your machine |
| ⚡ **Incremental** | Only re-indexes changed files. Sub-second updates |
| 🧠 **Hybrid Search** | BM25 keyword + semantic vector search (Ollama embeddings) |
| 🕸️ **4-Layer Assembly** | Smart context paging within token budget |
| 🔗 **Dependency Graph** | Follows import chains across JS/TS, Python, Rust, Go |
| 🗃️ **Backup & Restore** | SQLite online backup with in-backup search |

## 🏗️ Architecture: 4-Layer Context Assembly

```
┌─────────────────────────────────────────────┐
│              Token Budget (e.g. 30K)        │
├────────────┬────────────────────────────────┤
│ L1: Fixed  │ File tree overview (10%)       │
│ (always)   │ Project structure snapshot     │
├────────────┼────────────────────────────────┤
│ L2: Short  │ Current file + recent (20%)   │
│ (context)  │ What you're working on now     │
├────────────┼────────────────────────────────┤
│ L3: Assoc  │ Search + dependencies (50%) ★ │
│ (relevant) │ BM25 + semantic + dep chain   │
├────────────┼────────────────────────────────┤
│ L4: Spare  │ Frequently accessed (20%)     │
│ (backup)   │ Files you use most            │
└────────────┴────────────────────────────────┘

Output order: L1 → L3 → L4 → L2  (mitigates "Lost in the Middle")
```

## 🧠 Semantic Search (Optional)

When Ollama is available, Arachne upgrades from keyword-only to **hybrid search**:

```
BM25 Score (keyword) ──┐
                       ├── Weighted Merge (α=0.5) → Best Results
Cosine Similarity ─────┘
(nomic-embed-text 768D)
```

- **sqlite-vec** for SIMD-accelerated KNN vector search
- **Graceful degradation**: No Ollama? Falls back to BM25-only. Zero crashes.
- Enable in config: `embedding.enabled = true`

## 🛡️ Stability: 104 Tests, Zero Failures

Arachne is built for production. Every edge case is tested:

| Category | What's Tested |
|----------|---------------|
| 💉 SQL Injection | 5 attack patterns including Bobby Tables |
| 🛡️ Null/Empty Input | null, undefined, empty string → safe return |
| 🐘 Huge Input | 10KB queries → no crash |
| 🔣 Special Characters | Unicode, emoji, regex chars → handled |
| 🔌 Ollama Disconnect | Bad endpoint → graceful BM25 fallback |
| 🔄 Idempotency | Triple re-indexing → same result |
| 💰 Extreme Budgets | Budget 0, 1, 1M → all safe |
| 📊 Edge topK | topK = -1, 0, 99999 → no crash |
| 💾 Schema Safety | Triple init → data survives |

```
Phase 1 (Indexing/Search):    15/15 ✅
Phase 2 (Assembly/Deps):      26/26 ✅
Phase 3 (Semantic/Hybrid):    19/19 ✅
Stability (Reddit-proof):     44/44 ✅
─────────────────────────────────────
Total:                       104/104 ✅
```

## 📦 Installation

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

## 🔧 Configuration

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

## 🚀 Usage (MCP Tool)

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

## 🌐 N2 Ecosystem

| Package | Role | npm |
|---------|------|-----|
| **QLN** | Tool routing (1000+ tools → 1 router) | `n2-qln` |
| **Soul** | Agent memory & session management | `n2-soul` |
| **Ark** | Security policies & code verification | `n2-ark` |
| **Arachne** | Code context auto-assembly 🕸️ | `n2-arachne` |

> Each package works **standalone**. Together, they amplify each other.
> Works with **any AI provider**, on **any platform**.

## 📄 License

Apache-2.0

---

*Arachne — the greatest weaver. Your code, perfectly woven.* 🕷️
