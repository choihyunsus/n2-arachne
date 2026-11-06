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
async function initEngines(config: ArachneConfig): Promise<{
  store: Store;
  indexer: Indexer;
  search: BM25Search;
  backup: Backup;
  assembler: Assembler;
  kvBridge: KVBridge;
}> {
  const projectDir = config.projectDir ?? process.cwd();
  const store = new Store(config.dataDir, {
    dbPath: config.dbPath,
    project: config.project,
    agent: config.agent,
    projectRoot: projectDir,
  });
  await store.init();
  console.error(`[n2-arachne] DB initialized: ${store.dbPath}`);

  const indexer = new Indexer(store, config);
  const search = new BM25Search(store, config.search);
  const backup = new Backup(store, config.backup);
  backup.recover();
  const assembler = new Assembler(store, search, {
    ...config.assembly,
    tokenMultiplier: config.indexing.tokenMultiplier,
  });
  const kvBridge = new KVBridge(store, config.dataDir, projectDir, config.kvCache);

  if (kvBridge.isEnabled) {
    const kvData = kvBridge.load();
    if (kvData) {
      console.error(
        `[n2-arachne] KV restored: ${kvData.searchHistory.length} queries, ${kvData.hotFiles.length} hot files (saved ${kvData.lastSavedAt})`,
      );
    } else if (kvBridge.getLastError()) {
      console.error(`[n2-arachne] Session restore failed: ${kvBridge.getLastError()}`);
    } else {
      console.error('[n2-arachne] KV cache: fresh session');
    }
  }

  return { store, indexer, search, backup, assembler, kvBridge };
}

/** Initialize semantic search when embedding is enabled */
function createSemanticSearch(
  config: ArachneConfig,
  store: Store,
  search: BM25Search,
  assembler: Assembler,
): VectorStore | null {
  if (!config.embedding?.enabled) return null;

  const embedding = new Embedding(config.embedding);
  const vectorStore = new VectorStore(store, embedding);
  search.setVectorStore(vectorStore);
  assembler.setVectorStore(vectorStore);

  return vectorStore;
}

/** Run auto-indexing and embedding generation */
async function runAutoIndex(
  config: ArachneConfig,
  indexer: Indexer,
  vectorStore: VectorStore | null,
  closed: () => boolean,
): Promise<void> {
  try {
    const availability = vectorStore?.init() ?? Promise.resolve(false);
    if (!config.indexing.autoIndex) {
      await availability;
      return;
    }
    const projectDir = config.projectDir ?? process.cwd();
    console.error(`[n2-arachne] Auto-indexing: ${projectDir}`);
    const result = await indexer.index(projectDir);
    if (!result.complete) {
      console.error(
        `[n2-arachne] Auto-index partially completed with ${result.issues.length} issues`,
      );
      return;
    }
    console.error(
      `[n2-arachne] Indexed: ${result.indexed} files (${result.skipped} unchanged, ${result.removed} stale) in ${result.elapsed}ms`,
    );

    const available = await availability;
    if (closed()) return;
    if (available && vectorStore) {
      const embedResult = await vectorStore.embedNewChunks();
      console.error(
        `[n2-arachne] Embedded: ${embedResult.embedded} chunks (${embedResult.errors} errors, ${embedResult.remaining} remaining)`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[n2-arachne] Auto-index failed: ${message}`);
  }
}

async function main(): Promise<void> {
  if (printCliInformation()) return;
  const config = loadConfig();
  const { store, indexer, search, backup, assembler, kvBridge } = await initEngines(config);
  const vectorStore = createSemanticSearch(config, store, search, assembler);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pkg = require('../package.json') as { version: string };
  const server = new McpServer({ name: 'n2-arachne', version: pkg.version });

  registerContextTools(
    server,
    z,
    search,
    indexer,
    backup,
    assembler,
    config,
    vectorStore,
    kvBridge,
  );

  const closed = attachShutdown(server, store, indexer, kvBridge, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[n2-arachne] MCP server ready (v${pkg.version})`);
  void runAutoIndex(config, indexer, vectorStore, closed);
}

function attachShutdown(
  server: McpServer,
  store: Store,
  indexer: Indexer,
  kvBridge: KVBridge,
  config: ArachneConfig,
): () => boolean {
  let closed = false;
  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    indexer.cancel();
    if (kvBridge.isEnabled && config.kvCache?.autoSaveOnExit !== false && !kvBridge.save()) {
      console.error(`[n2-arachne] Session save failed: ${kvBridge.getLastError()}`);
    }
    store.close();
  };
  process.once('exit', shutdown);
  process.once('SIGINT', () => {
    shutdown();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    shutdown();
    process.exit(0);
  });

  process.stdin.once('end', () => {
    shutdown();
    process.exit(0);
  });
  server.server.onclose = () => {
    shutdown();
    process.exit(0);
  };

  return () => closed;
}

function printCliInformation(): boolean {
  const args = process.argv.slice(2);
  const version = (require('../package.json') as { version: string }).version;
  if (args.includes('--version')) {
    console.log(version);
    return true;
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      `n2-arachne ${version}\nUsage  n2-arachne [--stdio]\n\nConfigure N2_CONTEXT_PROJECT_DIR, N2_CONTEXT_DATA_DIR and optionally N2_CONTEXT_DB_PATH.\nSet N2_PROJECT and N2_AGENT_NAME to select a persistent owner.\nThe default command starts an MCP stdio server. See README.md for configuration and limits.`,
    );
    return true;
  }
  if (args.some((argument) => argument !== '--stdio'))
    throw new Error('Unknown argument. Run --help for usage.');
  return false;
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[n2-arachne] Fatal: ${message}`);
  process.exit(1);
});
