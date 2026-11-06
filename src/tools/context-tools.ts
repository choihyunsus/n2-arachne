// MCP tool registration (unified n2_arachne tool)
// Same pattern as QLN's n2_qln_call: 1 tool, multiple actions
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z as ZodType } from 'zod';
import type { BM25Search } from '../lib/search';
import type { Indexer } from '../lib/indexer';
import type { Backup } from '../lib/backup';
import type { Assembler } from '../lib/assembler';
import type { VectorStore } from '../lib/vector-store';
import type { KVBridge } from '../lib/kv-bridge';
import type { ArachneConfig, ChunkRow } from '../types';
import ignore from 'ignore';
import { buildToolSchema, type ToolArguments, type ToolResponse } from './tool-schema';
const MAX_PREVIEW_CHARS = 4096;

interface ToolContext {
  search: BM25Search;
  indexer: Indexer;
  backup: Backup;
  assembler: Assembler;
  config: ArachneConfig;
  vectorStore: VectorStore | null;
  kvBridge?: KVBridge;
}

/** Route action to the appropriate handler */
async function routeAction(
  options: ToolArguments,
  context: ToolContext,
  signal?: AbortSignal,
): Promise<ToolResponse> {
  const { search, indexer, backup, assembler, config, vectorStore, kvBridge } = context;
  switch (options.action) {
    case 'assemble':
      return handleAssemble(assembler, options, config, kvBridge);
    case 'search':
      return handleSearch(search, backup, options, kvBridge);
    case 'index':
      return handleIndex(
        indexer,
        backup,
        config,
        { subPath: options.path, force: options.force, signal },
        vectorStore,
      );
    case 'embed':
      return handleEmbedding(vectorStore, options.topK);
    case 'status':
      return handleStatus(indexer, backup, vectorStore);
    case 'health': {
      const report = indexer.getHealth();
      return {
        content: [{ type: 'text', text: report.markdown }],
        structuredContent: report,
      };
    }
    case 'files':
      return handleFiles(indexer, options);
    case 'backup':
      return handleBackup(backup, options);
    case 'restore':
      return handleRestore(backup, options, kvBridge);
    case 'gc':
      return handleGC(backup, options);
    default:
      return {
        content: [{ type: 'text', text: `Unknown action ${options.action}` }],
        isError: true,
      };
  }
}

export function registerContextTools(
  server: McpServer,
  z: typeof ZodType,
  search: BM25Search,
  indexer: Indexer,
  backup: Backup,
  assembler: Assembler,
  config: ArachneConfig,
  vectorStore: VectorStore | null,
  kvBridge?: KVBridge,
): void {
  const schema = buildToolSchema(z);
  const context: ToolContext = {
    search,
    indexer,
    backup,
    assembler,
    config,
    vectorStore,
    kvBridge,
  };

  // MCP SDK's overloaded server.tool() causes TS2589 with complex Zod schemas
  (server.tool as Function)(
    'n2_arachne',
    'Arachne — Weaves code into optimal AI context. Supports search/indexing/assembly/backup.',
    schema,
    (args: ToolArguments, extra?: { signal?: AbortSignal }) =>
      executeAction(context, args, extra?.signal),
  );
}

async function executeAction(
  context: ToolContext,
  args: ToolArguments,
  signal?: AbortSignal,
): Promise<ToolResponse> {
  const { indexer, kvBridge } = context;
  try {
    if (indexer.isIndexing && (args.action === 'search' || args.action === 'assemble'))
      throw new Error('Indexing is in progress. Check status and retry after the scan finishes.');
    const response = await routeAction(args, context, signal);
    if (
      ['search', 'assemble', 'files', 'health'].includes(args.action) &&
      indexer.hasIncompleteScan
    )
      response.content.push({
        type: 'text',
        text: 'The previous scan was partial or interrupted. Results cover the currently indexed files. Run index and check status to refresh coverage.',
      });
    if (kvBridge?.getLastError())
      response.content.push({
        type: 'text',
        text: `Session persistence failed. ${kvBridge.getLastError()}`,
      });
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text' as const, text: `Error: ${message}` }],
      isError: true,
    };
  }
}

// ── Action Handlers ──

function handleSearch(
  search: BM25Search,
  backup: Backup,
  opts: {
    query?: string;
    topK?: number;
    language?: string;
    searchBackups?: boolean;
    backupId?: string;
  },
  kvBridge?: KVBridge,
): ToolResponse {
  if (!opts.query) {
    return {
      content: [{ type: 'text', text: 'Error: query is required for search action' }],
      isError: true,
    };
  }

  const results = search.search(opts.query, {
    topK: opts.topK,
    language: opts.language,
  });

  // KV: record search query
  kvBridge?.recordSearch(opts.query, results.length);

  const backupResults = opts.searchBackups ? searchSavedBackup(backup, opts) : [];

  const formatted = results.map((result) => formatSearchResult(result.chunk, result.score));

  if (backupResults.length > 0) {
    formatted.push('\n--- Backup Results ---');
    for (const r of backupResults) {
      const backupId = (r as ChunkRow & { backup_id?: string }).backup_id ?? '';
      formatted.push(
        `🗃️ [backup:${backupId}] ${r.file_path}:${r.start_line}-${r.end_line} [${r.chunk_type}${r.name ? ': ' + r.name : ''}]\n\`\`\`\n${preview(r.content)}\n\`\`\``,
      );
    }
  }

  const text =
    results.length > 0 || backupResults.length > 0
      ? `Found ${results.length} results${backupResults.length > 0 ? ` (+${backupResults.length} from backup)` : ''}:\n\n${formatted.join('\n\n')}`
      : 'No results found.';

  return { content: [{ type: 'text', text }] };
}

function formatSearchResult(c: ChunkRow, score: number): string {
  return `📄 ${c.file_path}:${c.start_line}-${c.end_line} [${c.chunk_type}${c.name ? ': ' + c.name : ''}] (score: ${score.toFixed(2)}, ${c.token_count} tokens)\n\`\`\`${c.language ?? ''}\n${preview(c.content)}\n\`\`\``;
}

function preview(content: string): string {
  if (content.length <= MAX_PREVIEW_CHARS) return content;
  return content.slice(0, MAX_PREVIEW_CHARS) + '\n[preview truncated]';
}

function searchSavedBackup(
  backup: Backup,
  options: { query?: string; backupId?: string; topK?: number },
): ChunkRow[] {
  const entries = backup.list();
  const id = options.backupId ?? entries.at(-1)?.id;
  if (!id) return [];
  return backup.searchBackup(id, options.query ?? '', options.topK ?? 10);
}

async function handleIndex(
  indexer: Indexer,
  backup: Backup,
  config: ArachneConfig,
  opts: { subPath?: string; force?: boolean; signal?: AbortSignal },
  vectorStore: VectorStore | null = null,
): Promise<ToolResponse> {
  const projectDir = config.projectDir ?? process.cwd();

  if (opts.force && config.backup?.enabled && config.backup.autoBackupOnReindex && backup) {
    await backup.create('pre-reindex', 'pre-reindex');
  }

  const result = await indexer.index(projectDir, opts);
  const heading = result.complete ? 'Indexing complete' : 'Indexing partially completed';
  let text = `${heading}\nIndexed ${result.indexed}, unchanged ${result.skipped}, removed ${result.removed}, planned ${result.total}, elapsed ${result.elapsed}ms\n${result.issues
    .slice(0, 20)
    .map((issue) => `${issue.path} — ${issue.message}`)
    .join('\n')}`;
  if (result.issues.length > 20)
    text += `\nShowing 20 of ${result.issues.length} issues. Fix these sources and re-index to review remaining issues.`;
  const embedding = result.complete && vectorStore ? await handleEmbedding(vectorStore) : null;
  if (embedding) text += '\n' + embedding.content.map((item) => item.text).join('\n');
  return {
    content: [{ type: 'text', text }],
    isError: !result.complete || Boolean(embedding?.isError),
  };
}

async function handleEmbedding(store: VectorStore | null, limit = 64): Promise<ToolResponse> {
  if (!store)
    return {
      content: [
        {
          type: 'text',
          text: 'Embedding is disabled in the server configuration',
        },
      ],
      isError: true,
    };
  try {
    const result = await store.embedNewChunks(limit);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      isError: result.errors > 0,
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Embedding failed. ${(error as Error).message}` }],
      isError: true,
    };
  }
}

function handleStatus(
  indexer: Indexer,
  backup: Backup,
  vectorStore: VectorStore | null,
): ToolResponse {
  const stats = indexer.getStats();
  const backups = backup ? backup.list() : [];

  const lines: string[] = [
    `📊 Arachne Status`,
    `- Files: ${stats.fileCount}`,
    `- Chunks: ${stats.chunkCount}`,
    `- Total tokens: ${stats.totalTokens.toLocaleString()}`,
    `- DB size: ${stats.dbSizeMB} MB`,
    `- Last indexed: ${stats.lastIndexed ?? 'never'}`,
    `- Schema version: ${stats.schemaVersion}`,
    `\n📋 Languages:`,
    ...stats.languages.map((l) => `  ${l.language ?? 'unknown'}: ${l.cnt} files`),
  ];

  if (vectorStore) {
    const embeddedCount = vectorStore.getEmbeddedCount();
    lines.push(`\n🧠 Semantic Search:`);
    lines.push(
      `  Status: ${vectorStore.isInitializing ? 'Checking service' : vectorStore.isReady ? '✅ Active' : '❌ Inactive'}`,
    );
    lines.push(`  Embedding batch running ${vectorStore.isEmbedding}`);
    lines.push(`  Stored vectors: ${embeddedCount} / ${stats.chunkCount}`);
    if (vectorStore.getLastError())
      lines.push(`  Previous embedding error — ${vectorStore.getLastError()}`);
  }
  lines.push(`Index running ${indexer.isIndexing}`);
  if (indexer.hasIncompleteScan) lines.push('Previous scan was partial or interrupted');

  if (backups.length > 0) {
    lines.push(`\n🗃️ Backups: ${backups.length}`);
    for (const b of backups.slice(-3)) {
      lines.push(
        `  ${b.id}${b.label ? ' (' + b.label + ')' : ''} — ${b.files} files, ${b.sizeMB} MB`,
      );
    }
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function handleFiles(
  indexer: Indexer,
  opts: {
    language?: string;
    pattern?: string;
    offset?: number;
    limit?: number;
  },
): ToolResponse {
  let files = indexer.getFiles({ language: opts.language });

  if (opts.pattern) {
    const matcher = ignore().add(opts.pattern);
    files = files.filter((f) => matcher.ignores(f.path));
  }
  const offset = opts.offset ?? 0;
  const page = files.slice(offset, offset + (opts.limit ?? 200));
  const text =
    files.length > 0
      ? `📁 ${files.length} files, showing ${page.length} from offset ${offset}\n${page.map((f) => `  ${f.path} (${f.language}, ${f.chunk_count} chunks)`).join('\n')}`
      : 'No files found.';

  return { content: [{ type: 'text', text }] };
}

async function handleBackup(backup: Backup, opts: { label?: string }): Promise<ToolResponse> {
  const result = await backup.create(opts.label);
  return {
    content: [
      {
        type: 'text',
        text: `✅ Backup created: ${result.id}\n- Files: ${result.files}\n- Chunks: ${result.chunks}\n- Size: ${(result.size / 1024 / 1024).toFixed(2)} MB${result.exportedTo ? '\n- Exported to ' + result.exportedTo : ''}`,
      },
    ],
  };
}

async function handleRestore(
  backup: Backup,
  opts: { backupId?: string },
  kvBridge?: KVBridge,
): Promise<ToolResponse> {
  const result = await backup.restore(opts.backupId);
  kvBridge?.load();
  return {
    content: [
      {
        type: 'text',
        text: `✅ Restored from backup: ${result.restored}\n- Files: ${result.files}${result.label ? '\n- Label: ' + result.label : ''}\nThe restored index is ready to search.`,
      },
    ],
  };
}

async function handleGC(
  backup: Backup,
  opts: { maxAge?: number; maxCount?: number },
): Promise<ToolResponse> {
  const removed = await backup.gc(opts.maxAge, opts.maxCount);
  return {
    content: [{ type: 'text', text: `🧹 GC complete: ${removed} backup(s) removed.` }],
  };
}

async function handleAssemble(
  assembler: Assembler,
  opts: {
    query?: string;
    activeFile?: string;
    budget?: number;
    layers?: string[];
  },
  config: ArachneConfig,
  kvBridge?: KVBridge,
): Promise<ToolResponse> {
  if (!opts.query) {
    return {
      content: [{ type: 'text', text: 'Error: query is required for assemble action' }],
      isError: true,
    };
  }

  const result = await assembler.assemble(opts.query, {
    activeFile: opts.activeFile,
    budget: opts.budget,
    layers: opts.layers,
    projectDir: config.projectDir ?? process.cwd(),
  });

  // KV: record assemble query
  const layerItems = Object.values(result.metadata.layers).reduce((sum, l) => sum + l.itemCount, 0);
  kvBridge?.recordSearch(opts.query, layerItems);

  const meta = result.metadata;
  const header = [
    `🕷️ Arachne Context Assembled`,
    `- Query: "${meta.query}"`,
    `- Estimated context tokens: ${meta.tokensUsed.toLocaleString()} / ${meta.budget.toLocaleString()} (${meta.budget === 0 ? 0 : Math.round((meta.tokensUsed / meta.budget) * 100)}% used)`,
    `- Layers:`,
    ...Object.entries(meta.layers).map(
      ([k, v]) => `  ${k}: ${v.tokens.toLocaleString()} tokens, ${v.itemCount} items`,
    ),
  ];
  header.push(...(meta.warnings ?? []).map((warning) => `- ${warning}`));

  const text = `${header.join('\n')}\n\n---\n\n${result.context}`;
  return { content: [{ type: 'text', text }] };
}
