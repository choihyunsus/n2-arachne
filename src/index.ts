#!/usr/bin/env node
// Arachne — MCP server entry point
// Weaves code into optimal AI context, like the greatest weaver of Greek mythology
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { loadConfig } from './lib/config';
import type { ArachneConfig } from './types';
import { Store } from './lib/store';
import { Indexer } from './lib/indexer';
import { BM25Search } from './lib/search';
import { Backup } from './lib/backup';
import { Assembler } from './lib/assembler';
import { Embedding } from './lib/embedding';
import { VectorStore } from './lib/vector-store';
import { KVBridge } from './lib/kv-bridge';
import { registerContextTools } from './tools/context-tools';

/** Initialize core engines and KV-Cache bridge */
function initEngines(config: ArachneConfig): {
  indexer: Indexer; search: BM25Search; backup: Backup;
  assembler: Assembler; kvBridge: KVBridge;
} {
  const projectDir = config.projectDir ?? process.cwd();
  const store = new Store(config.dataDir);
  // Synchronous init is fine — Store.init() is idempotent
  void store.init();
  console.error(`[n2-arachne] DB initialized: ${store.dbPath}`);

  const indexer = new Indexer(store, config);
  const search = new BM25Search(store, config.search);
  const backup = new Backup(store, config.backup);
  const assembler = new Assembler(store, search, config.assembly);
  const kvBridge = new KVBridge(store, config.dataDir, projectDir, config.kvCache);

  if (kvBridge.isEnabled) {
    const kvData = kvBridge.load();
    if (kvData) {
      console.error(`[n2-arachne] KV restored: ${kvData.searchHistory.length} queries, ${kvData.hotFiles.length} hot files (saved ${kvData.lastSavedAt})`);
    } else {
      console.error('[n2-arachne] KV cache: fresh session');
    }
  }

  return { indexer, search, backup, assembler, kvBridge };
}

/** Initialize semantic search when embedding is enabled */
async function initSemanticSearch(
  config: ArachneConfig, search: BM25Search, assembler: Assembler,
): Promise<VectorStore | null> {
  if (!config.embedding?.enabled) return null;

  const embedding = new Embedding(config.embedding);
  const vectorStore = new VectorStore(new Store(config.dataDir), embedding);
  const initialized = await vectorStore.init();

  if (initialized) {
    search.setVectorStore(vectorStore);
    assembler.setVectorStore(vectorStore);
    console.error(`[n2-arachne] Semantic search enabled (${embedding.model})`);
  } else {
    console.error('[n2-arachne] Semantic search unavailable, using BM25-only');
  }

  return initialized ? vectorStore : null;
}

/** Run auto-indexing and embedding generation */
async function runAutoIndex(
  config: ArachneConfig, indexer: Indexer, vectorStore: VectorStore | null,
): Promise<void> {
  if (!config.indexing.autoIndex) return;

  const projectDir = config.projectDir ?? process.cwd();
  console.error(`[n2-arachne] Auto-indexing: ${projectDir}`);

  try {
    const result = await indexer.index(projectDir);
    console.error(`[n2-arachne] Indexed: ${result.indexed} files (${result.skipped} unchanged, ${result.removed} stale) in ${result.elapsed}ms`);

    if (vectorStore?.isReady) {
      const embedResult = await vectorStore.embedNewChunks();
      console.error(`[n2-arachne] Embedded: ${embedResult.embedded} chunks (${embedResult.errors} errors)`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[n2-arachne] Auto-index failed: ${message}`);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { indexer, search, backup, assembler, kvBridge } = initEngines(config);
  const vectorStore = await initSemanticSearch(config, search, assembler);
  await runAutoIndex(config, indexer, vectorStore);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pkg = require('../package.json') as { version: string };
  const server = new McpServer({ name: 'n2-arachne', version: pkg.version });

  registerContextTools(server, z, search, indexer, backup, assembler, config, vectorStore, kvBridge);

  if (kvBridge.isEnabled) {
    const gracefulShutdown = (): void => { kvBridge.save(); };
    process.on('exit', gracefulShutdown);
    process.on('SIGINT', () => { gracefulShutdown(); process.exit(0); });
    process.on('SIGTERM', () => { gracefulShutdown(); process.exit(0); });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[n2-arachne] MCP server ready (v${pkg.version})`);
}

main().catch(err => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[n2-arachne] Fatal: ${message}`);
  process.exit(1);
});

