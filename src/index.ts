#!/usr/bin/env node
// Arachne — MCP server entry point
// Weaves code into optimal AI context, like the greatest weaver of Greek mythology
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { loadConfig } from './lib/config';
import { Store } from './lib/store';
import { Indexer } from './lib/indexer';
import { BM25Search } from './lib/search';
import { Backup } from './lib/backup';
import { Assembler } from './lib/assembler';
import { Embedding } from './lib/embedding';
import { VectorStore } from './lib/vector-store';
import { KVBridge } from './lib/kv-bridge';
import { registerContextTools } from './tools/context-tools';

async function main(): Promise<void> {
  const config = loadConfig();

  // 1. Initialize Store (SQLite + Phase 3 migration)
  const store = new Store(config.dataDir);
  await store.init();
  console.error(`[n2-arachne] DB initialized: ${store.dbPath}`);

  // 2. Initialize engines
  const projectDir = config.projectDir ?? process.cwd();
  const indexer = new Indexer(store, config);
  const search = new BM25Search(store, config.search);
  const backup = new Backup(store, config.backup);
  const assembler = new Assembler(store, search, config.assembly);

  // 3. Phase 2: KV-Cache bridge (session memory)
  const kvBridge = new KVBridge(store, config.dataDir, projectDir, config.kvCache);
  if (kvBridge.isEnabled) {
    const kvData = kvBridge.load();
    if (kvData) {
      console.error(`[n2-arachne] KV restored: ${kvData.searchHistory.length} queries, ${kvData.hotFiles.length} hot files (saved ${kvData.lastSavedAt})`);
    } else {
      console.error('[n2-arachne] KV cache: fresh session');
    }
  }

  // 4. Phase 3: Semantic search (only when embedding.enabled)
  let vectorStore: VectorStore | null = null;
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

  // 5. Auto-indexing (when enabled in config)
  if (config.indexing.autoIndex) {
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
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[n2-arachne] Auto-index failed: ${message}`);
    }
  }

  // 6. Create MCP server
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pkg = require('../package.json') as { version: string };
  const server = new McpServer({
    name: 'n2-arachne',
    version: pkg.version,
  });

  // 7. Register MCP tools (with KV bridge for search history)
  registerContextTools(server, z, search, indexer, backup, assembler, config, vectorStore, kvBridge);

  // 8. Auto-save KV on process exit
  if (kvBridge.isEnabled) {
    const gracefulShutdown = (): void => {
      kvBridge.save();
    };
    process.on('exit', gracefulShutdown);
    process.on('SIGINT', () => { gracefulShutdown(); process.exit(0); });
    process.on('SIGTERM', () => { gracefulShutdown(); process.exit(0); });
  }

  // 9. Connect stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[n2-arachne] MCP server ready (v${pkg.version})`);
}

main().catch(err => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[n2-arachne] Fatal: ${message}`);
  process.exit(1);
});

