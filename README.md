# Arachne 5.0

Code and document retrieval for AI agents, with owner-scoped storage in the common Soul SQLite database.

[한국어](README.ko.md) · [日本語](README.ja.md)

## Install

Use Node.js 20.19 or newer. Download `n2-arachne-5.0.0.tgz` from the GitHub release and install it into a dedicated tools directory.

```sh
npm install ./n2-arachne-5.0.0.tgz
node node_modules/n2-arachne/dist/index.js --version
```

This version is distributed through GitHub. Check the version when installing through another registry. The tarball includes the Windows x64 document parser. Other platforms require Rust 1.98 and a platform C/C++ linker, then `npm run build:documents` inside the installed package. Source checkouts require `npm ci`, `npm run build:documents` and `npm run build`.

The package uses TypeScript search. Optional Rust acceleration and source builds are described in `native/README.md`.

## MCP setup

Use absolute paths appropriate for your machine.

```json
{
  "mcpServers": {
    "arachne": {
      "command": "node",
      "args": ["/tools/node_modules/n2-arachne/dist/index.js"],
      "env": {
        "N2_CONTEXT_PROJECT_DIR": "/projects/example",
        "N2_CONTEXT_DATA_DIR": "/state/example-arachne",
        "N2_CONTEXT_DB_PATH": "/state/soul/mimir.db",
        "N2_PROJECT": "example",
        "N2_AGENT_NAME": "assistant"
      }
    }
  }
}
```

On Windows, use paths such as `C:/tools/node_modules/n2-arachne/dist/index.js`. Keep a stable project/agent pair for each canonical source root. A registered owner rejects a different root.

The server connects before automatic indexing and embedding checks finish. Use `status` to follow startup. While indexing, `search` and `assemble` return a progress error requesting a retry. Partial or interrupted scans remain visible across restarts.

### The `n2_arachne` tool

| Action | Purpose | Arguments |
| --- | --- | --- |
| `index` | Incrementally index a root or subtree | `path`, `force` |
| `search` | Keyword retrieval and optional snapshot search | `query`, `topK`, `language`, `searchBackups`, `backupId` |
| `assemble` | Four context layers with optional hybrid retrieval | `query`, `activeFile`, `budget`, `layers` |
| `status` | Index, vector, backup and scan status | — |
| `files` | Paginated indexed files | `pattern`, `language`, `offset`, `limit` |
| `health` | Dependency graph metrics and bounded samples | — |
| `embed` | Generate missing or stale vectors | `topK` as batch limit |
| `backup` | Checksummed owner snapshot | `label` |
| `restore` | Transactional live owner restore | `backupId` |
| `gc` | Retention for this owner's new snapshots | `maxAge`, `maxCount` |

```json
{"action":"assemble","query":"request cancellation","activeFile":"src/client.ts","budget":6000}
```

Context allocation defaults to 10% project structure, 30% active source/dependencies, 40% retrieved code and 20% frequently accessed code. Headings, fences and truncation markers count toward the context estimate. `budget: 0` produces empty context. Estimates use configurable characters per token and can differ from model tokenization. The MCP diagnostic header is outside the context budget.

### Embeddings

Ollama embeddings are opt-in. Enable an available model with these environment variables.

```json
{
  "N2_CONTEXT_EMBEDDING_ENABLED": "true",
  "N2_CONTEXT_EMBEDDING_ENDPOINT": "http://127.0.0.1:11434",
  "N2_CONTEXT_EMBEDDING_MODEL": "nomic-embed-text",
  "N2_CONTEXT_EMBEDDING_TIMEOUT": "10000"
}
```

Requests support `/api/embed` and the legacy `/api/embeddings` fallback after 404/405 responses. Each vector is tied to an owner, model, dimension and full chunk input hash. Provider failures preserve keyword retrieval and produce assembly diagnostics. Re-run `embed` until `complete: true`. Automatic indexing generates at most one batch of 64 chunks. Selected source text is sent to the configured endpoint. Optional credentials use `N2_CONTEXT_EMBEDDING_KEY`.

## Common Soul storage

`N2_CONTEXT_DB_PATH` selects the local SQLite file used by distribution Soul and Mimir. Standalone mode defaults to `<dataDir>/mimir.db` with identical columns. Every process sharing the WAL database should use SQLite 3.51.3 or newer. Arachne checks its own runtime version. Use a local filesystem with SQLite-compatible locking.

Common schema version `meta.schema_version = 2` contains `experiences`, `insights`, `tags`, `embeddings`, `effect_tracking`, `experience_insight_links`, `insight_links`, `meta` and `tag_similarity`.

Arachne owns `arachne_` tables for scopes, files, chunks, dependencies, access logs, vectors, sessions, snapshots, migration receipts and maintenance leases. Its version is `meta.arachne_schema_version = 1`. File columns include `path`, `hash`, `language`, `size_bytes`, `chunk_count`, `content`, `indexed_at`, `modified_at` and explicit `project`/`agent`. Numeric file/chunk IDs remain available. Document `source_hash` incorporates raw bytes, parser binary and indexing configuration. Child IDs are checked against ownership.

Search filters ownership before limiting results. Restore replaces only the selected owner's Arachne records transactionally. Snapshots contain that owner's source text and session history. Soul/Mimir manage common experiences and insights. The host must authorize callers who can select owners or access the database file.

### Upgrade from 4.x

1. Stop the old process and retain a copy of its data directory.
2. Point `N2_CONTEXT_DATA_DIR` to that directory. Set the intended project, agent and source root explicitly.
3. Start 5.0. Legacy `context.db` imports transactionally into that owner in `mimir.db`. Existing common records and other owners are preserved. The legacy file remains available for rollback.
4. Version 4 `arachne-kv.json` history imports after source-root validation. New history persists in SQLite.
5. Run `index`, inspect `status`, then run `embed` as needed. Old sqlite-vec caches remain in the legacy database and new vectors are generated from current chunks.

Receipts make retries idempotent. Initial import is synchronous and may require a longer client startup timeout for large databases. `Store.init()` and `Store.migrateLegacy()` support offline migration. Legacy snapshots remain available for validated search and restore. New retention applies to 5.0 owner snapshots. Future schemas, root mismatches and unscoped old Daebung tables produce explicit errors requiring an intentional migration.

## Coverage and limits

- JavaScript/TypeScript, Python, Rust, Go and Java use heuristic declaration chunking. Common JS/TS extension aliases are included. Other configured source/text formats use bounded windows.
- Dependency extraction covers literal JS/TS, Rust, Python, Java, C/C++ and Go imports. Resolution is heuristic. Go package imports remain unresolved package references. Compiler aliases and dynamic expressions require application context.
- Root `.gitignore` and `.contextignore` support Git-style rules. Default exclusions cover nested dependency/build directories. Nested ignore files are outside the current reader's scope. Symlink entries are skipped.
- PDF, DOCX, PPTX and XLSX text extraction runs in a separate Rust worker. XLSX resolves actual shared/inline cells and cached formulas. OCR, password unlocking, formula recalculation and visual layout reproduction require external tools.
- `health` reports directed edges, undirected relationships, unresolved imports, self references, components, hubs, isolated nodes and cyclic components. Cycle samples list component members.

| Stage | Bound |
| --- | --- |
| Discovery | 100,000 entries, depth 64, configured file count, 120-second checks |
| Source input | 1 MiB default, configurable through 10 MiB |
| Document worker | 32 MiB input, two processes maximum, 256 MiB per-process budget, 20-second watchdog, 22-second parent timeout |
| Document expansion | 32 MiB expanded, 8 MiB extracted text, 4,096 ZIP entries, 2,000 PDF pages |
| Diagnostics | Approximately 1,000 issues per scan, first 20 displayed by MCP |
| Search cache | 64 MiB estimated input, then scoped FTS5 retrieval |
| Embedding response | 4 MiB, per-request timeout of 1–60,000 ms |
| Embedding batch | 64 default, library maximum 256, 20-second check between requests |
| Snapshot | 2 GiB, one million copied rows, 120-second copy checks |

Windows uses a process-memory Job limit and Linux uses an address-space limit. macOS samples peak resident memory every 10 ms and terminates an over-budget worker. Sampling can briefly exceed the threshold.

Checks bound individual stages. Request timeouts can extend an embedding batch beyond its between-request budget. Partial scans preserve unseen prior records and report incomplete coverage. Failed documents retain their previous index content. Review diagnostics when refreshing or narrowing a source selection.

## Library

```js
const { Store, Indexer, BM25Search, Assembler } = require('n2-arachne');
const config = structuredClone(require('n2-arachne/config.default.js'));
const store = new Store('/state/example-arachne', {
  dbPath: '/state/soul/mimir.db', project: 'example', agent: 'assistant',
  projectRoot: '/projects/example'
});
async function retrieve() {
  await store.init();
  try {
    const scan = await new Indexer(store, config).index(store.projectRoot);
    if (!scan.complete) throw new Error(JSON.stringify(scan.issues));
    const search = new BM25Search(store, config.search);
    const assembler = new Assembler(store, search, {
      ...config.assembly, tokenMultiplier: config.indexing.tokenMultiplier
    });
    return await assembler.assemble('request cancellation', { budget: 6000 });
  } finally { store.close(); }
}
retrieve().then(console.log).catch(console.error);
```

Imports have no server or storage side effects. `node <package-directory>` and `n2-arachne` start MCP. `--help` and `--version` work before configuration.

## Configuration and validation

The loader merges package `config.default.js`, optional package-local `config.local.js`, then environment values. Relative data/backup directories resolve against the package directory. Use absolute paths in deployments. `N2_DATA_DIR` aliases the data directory. Additional environment settings include `N2_CONTEXT_AUTO_INDEX`, `N2_CONTEXT_MAX_FILES`, `N2_CONTEXT_BUDGET`, `N2_CONTEXT_BACKUP_DIR`, `N2_CONTEXT_EXTERNAL_BACKUP` and `N2_ARACHNE_DOCUMENT_WORKER` for a custom parser executable.

Historical `integrations` fields are retained for caller compatibility. Shared storage uses DB path and owner settings. External policy and orchestration belong to the host.

```sh
npm ci
npm run build:documents
npm test
cargo +1.98.0 test --locked --manifest-path document-worker/Cargo.toml --jobs 2
cargo +1.98.0 test --locked --manifest-path native/Cargo.toml --jobs 2
```

Tests cover actual MCP calls, cancellation/retry, restarted persistence, shared ownership, legacy import, rollback, snapshots, document formats and provider failures. Local Windows verification exercises the included parser. CI runs source checks on Windows, Linux and macOS. Consult the release commit's run for platform results. Three OS memory-management FFI blocks require manual unsafe-code review alongside static checks.

## License

The existing LICENSE specifies non-commercial/personal/educational usage terms and a separate commercial license. Read those terms before deployment. Attribution, imported-component MIT notices and parser dependency notices are included. [License](LICENSE) · [Source and dependency notices](THIRD-PARTY-NOTICES)
