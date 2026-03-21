#!/usr/bin/env node
// Arachne — MCP server entry point
// Weaves code into optimal AI context, like the greatest weaver of Greek mythology
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const { loadConfig } = require('./lib/config');
const { Store } = require('./lib/store');
const { Indexer } = require('./lib/indexer');
const { BM25Search } = require('./lib/search');
const { Backup } = require('./lib/backup');
const { Assembler } = require('./lib/assembler');
const { Embedding } = require('./lib/embedding');
const { VectorStore } = require('./lib/vector-store');
const { registerContextTools } = require('./tools/context-tools');

async function main() {
    const config = loadConfig();

    // 1. Initialize Store (SQLite + Phase 3 migration)
    const store = new Store(config.dataDir);
    await store.init();
    console.error(`[n2-arachne] DB initialized: ${store.dbPath}`);

    // 2. Initialize engines
    const indexer = new Indexer(store, config);
    const search = new BM25Search(store, config.search);
    const backup = new Backup(store, config.backup);
    const assembler = new Assembler(store, search, config.assembly);

    // 3. Phase 3: Semantic search (only when embedding.enabled)
    let vectorStore = null;
    if (config.embedding?.enabled) {
        const embedding = new Embedding(config.embedding);
        vectorStore = new VectorStore(store, embedding);
        const initialized = await vectorStore.init();
        if (initialized) {
            search.setVectorStore(vectorStore);
            assembler.setVectorStore(vectorStore);
            console.error(`[n2-arachne] Semantic search enabled (${embedding.model})`);
        } else {
            console.error('[n2-arachne] Semantic search unavailable, using BM25-only');
        }
    }

    // 4. Auto-indexing (when enabled in config)
    if (config.indexing.autoIndex) {
        const projectDir = config.projectDir || process.cwd();
        console.error(`[n2-arachne] Auto-indexing: ${projectDir}`);

        try {
            const result = await indexer.index(projectDir);
            console.error(`[n2-arachne] Indexed: ${result.indexed} files (${result.skipped} unchanged, ${result.removed} stale) in ${result.elapsed}ms`);

            // Auto-generate embeddings
            if (vectorStore?.isReady) {
                const embedResult = await vectorStore.embedNewChunks();
                console.error(`[n2-arachne] Embedded: ${embedResult.embedded} chunks (${embedResult.errors} errors)`);
            }
        } catch (err) {
            console.error(`[n2-arachne] Auto-index failed: ${err.message}`);
        }
    }

    // 5. Create MCP server
    const pkg = require('./package.json');
    const server = new McpServer({
        name: 'n2-arachne',
        version: pkg.version,
    });

    // 6. Register MCP tools (Phase 3: vectorStore added)
    registerContextTools(server, z, search, indexer, backup, assembler, config, vectorStore);

    // 7. Connect stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[n2-arachne] MCP server ready (v${pkg.version})`);
}

main().catch(err => {
    console.error(`[n2-arachne] Fatal: ${err.message}`);
    process.exit(1);
});
