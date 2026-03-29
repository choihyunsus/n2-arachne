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

/** MCP tool response shape (index signature required by MCP SDK) */
interface ToolResponse {
  [x: string]: unknown;
  content: Array<{ [x: string]: unknown; type: 'text'; text: string }>;
  isError?: boolean;
}

/** Build the unified tool schema */
function buildToolSchema(z: typeof ZodType): Record<string, unknown> {
  return {
    action: z.enum(['assemble', 'search', 'index', 'status', 'files', 'backup', 'restore', 'gc'])
      .describe('Action to execute (assemble: auto AI context assembly ★core)'),
    query: z.string().optional().describe('Search query (required for search action)'),
    topK: z.number().optional().describe('Number of search results (default: 10)'),
    language: z.string().optional().describe('Language filter (js, ts, py, rs, ...)'),
    path: z.string().optional().describe('Indexing target path (default: project root)'),
    force: z.boolean().optional().describe('If true, force full re-indexing'),
    label: z.string().optional().describe('Backup label (human-readable name)'),
    backupId: z.string().optional().describe('Backup ID (defaults to latest)'),
    searchBackups: z.boolean().optional().describe('If true, also search backup DBs'),
    maxAge: z.number().optional().describe('Delete backups older than N days'),
    maxCount: z.number().optional().describe('Maximum number of backups to keep'),
    pattern: z.string().optional().describe('File filter glob pattern'),
    activeFile: z.string().optional().describe('Current active file path (used in assemble)'),
    budget: z.number().optional().describe('Token budget (default: 40000)'),
    layers: z.array(z.string()).optional().describe('Layers to use ["fixed", "shortTerm", "associative", "spare"]'),
  };
}

/** Route action to the appropriate handler */
async function routeAction(
  args: Record<string, unknown>,
  search: BM25Search, indexer: Indexer, backup: Backup,
  assembler: Assembler, config: ArachneConfig,
  vectorStore: VectorStore | null, kvBridge?: KVBridge,
): Promise<ToolResponse> {
  const { action, query, topK, language, path: subPath, force,
          label, backupId, searchBackups, maxAge, maxCount, pattern,
          activeFile, budget, layers } = args as {
    action: string; query?: string; topK?: number; language?: string;
    path?: string; force?: boolean; label?: string; backupId?: string;
    searchBackups?: boolean; maxAge?: number; maxCount?: number;
    pattern?: string; activeFile?: string; budget?: number; layers?: string[];
  };

  switch (action) {
    case 'assemble': return await handleAssemble(assembler, { query, activeFile, budget, layers }, config, kvBridge);
    case 'search': return handleSearch(search, backup, { query, topK, language, searchBackups, backupId }, kvBridge);
    case 'index': return await handleIndex(indexer, backup, config, { subPath, force });
    case 'status': return handleStatus(indexer, backup, vectorStore);
    case 'files': return handleFiles(indexer, { language, pattern });
    case 'backup': return await handleBackup(backup, { label });
    case 'restore': return await handleRestore(backup, { backupId });
    case 'gc': return await handleGC(backup, { maxAge, maxCount });
    default: return { content: [{ type: 'text' as const, text: `Unknown action: ${action}` }], isError: true };
  }
}

export function registerContextTools(
  server: McpServer, z: typeof ZodType,
  search: BM25Search, indexer: Indexer, backup: Backup,
  assembler: Assembler, config: ArachneConfig,
  vectorStore: VectorStore | null, kvBridge?: KVBridge,
): void {
  const schema = buildToolSchema(z);

  // MCP SDK's overloaded server.tool() causes TS2589 with complex Zod schemas
  (server.tool as Function)(
    'n2_arachne',
    'Arachne — Weaves code into optimal AI context. Supports search/indexing/assembly/backup.',
    schema,
    async (args: Record<string, unknown>) => {
      try {
        return await routeAction(args, search, indexer, backup, assembler, config, vectorStore, kvBridge);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    }
  );
}

// ── Action Handlers ──

function handleSearch(
  search: BM25Search,
  backup: Backup,
  opts: { query?: string; topK?: number; language?: string; searchBackups?: boolean; backupId?: string },
  kvBridge?: KVBridge,
): ToolResponse {
  if (!opts.query) {
    return { content: [{ type: 'text', text: 'Error: query is required for search action' }], isError: true };
  }

  const results = search.search(opts.query, { topK: opts.topK, language: opts.language });

  // KV: record search query
  kvBridge?.recordSearch(opts.query, results.length);

  let backupResults: ChunkRow[] = [];
  if (opts.searchBackups && backup) {
    try {
      const bkId = opts.backupId ?? 'latest';
      const backups = backup.list();
      const targetId = bkId === 'latest' && backups.length > 0 ? backups[backups.length - 1]!.id : bkId;
      if (targetId && targetId !== 'latest') {
        backupResults = backup.searchBackup(targetId, opts.query, opts.topK ?? 10);
      }
    } catch { /* backup search failure is non-fatal */ }
  }

  const formatted = results.map(r => {
    const c = r.chunk;
    return `📄 ${c.file_path}:${c.start_line}-${c.end_line} [${c.chunk_type}${c.name ? ': ' + c.name : ''}] (score: ${r.score.toFixed(2)}, ${c.token_count} tokens)\n\`\`\`${c.language ?? ''}\n${c.content}\n\`\`\``;
  });

  if (backupResults.length > 0) {
    formatted.push('\n--- Backup Results ---');
    for (const r of backupResults) {
      const backupId = (r as ChunkRow & { backup_id?: string }).backup_id ?? '';
      formatted.push(`🗃️ [backup:${backupId}] :${r.start_line}-${r.end_line} [${r.chunk_type}${r.name ? ': ' + r.name : ''}]\n\`\`\`\n${r.content}\n\`\`\``);
    }
  }

  const text = results.length > 0
    ? `Found ${results.length} results${backupResults.length > 0 ? ` (+${backupResults.length} from backup)` : ''}:\n\n${formatted.join('\n\n')}`
    : 'No results found.';

  return { content: [{ type: 'text', text }] };
}

async function handleIndex(
  indexer: Indexer,
  backup: Backup,
  config: ArachneConfig,
  opts: { subPath?: string; force?: boolean },
): Promise<ToolResponse> {
  const projectDir = config.projectDir ?? process.cwd();

  if (opts.force && config.backup?.autoBackupOnReindex && backup) {
    try {
      await backup.create('pre-reindex', 'pre-reindex');
    } catch { /* backup failure is non-fatal */ }
  }

  const result = await indexer.index(projectDir, { force: opts.force, subPath: opts.subPath });
  const text = `Indexing complete:\n- Indexed: ${result.indexed} files\n- Skipped: ${result.skipped} (unchanged)\n- Removed: ${result.removed} (stale)\n- Total: ${result.total} files\n- Elapsed: ${result.elapsed}ms`;
  return { content: [{ type: 'text', text }] };
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
    ...stats.languages.map(l => `  ${l.language ?? 'unknown'}: ${l.cnt} files`),
  ];

  if (vectorStore) {
    const embeddedCount = vectorStore.getEmbeddedCount();
    lines.push(`\n🧠 Semantic Search:`);
    lines.push(`  Status: ${vectorStore.isReady ? '✅ Active' : '❌ Inactive'}`);
    lines.push(`  Embedded chunks: ${embeddedCount} / ${stats.chunkCount}`);
  }

  if (backups.length > 0) {
    lines.push(`\n🗃️ Backups: ${backups.length}`);
    for (const b of backups.slice(-3)) {
      lines.push(`  ${b.id}${b.label ? ' (' + b.label + ')' : ''} — ${b.files} files, ${b.sizeMB} MB`);
    }
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function handleFiles(
  indexer: Indexer,
  opts: { language?: string; pattern?: string },
): ToolResponse {
  let files = indexer.getFiles({ language: opts.language });

  if (opts.pattern) {
    const regex = new RegExp(opts.pattern.replace(/\*/g, '.*').replace(/\?/g, '.'), 'i');
    files = files.filter(f => regex.test(f.path));
  }

  const text = files.length > 0
    ? `📁 ${files.length} files:\n${files.map(f => `  ${f.path} (${f.language}, ${f.chunk_count} chunks)`).join('\n')}`
    : 'No files found.';

  return { content: [{ type: 'text', text }] };
}

async function handleBackup(backup: Backup, opts: { label?: string }): Promise<ToolResponse> {
  const result = await backup.create(opts.label);
  return { content: [{ type: 'text', text: `✅ Backup created: ${result.id}\n- Files: ${result.files}\n- Chunks: ${result.chunks}\n- Size: ${(result.size / 1024 / 1024).toFixed(2)} MB` }] };
}

async function handleRestore(backup: Backup, opts: { backupId?: string }): Promise<ToolResponse> {
  const result = await backup.restore(opts.backupId);
  return { content: [{ type: 'text', text: `✅ Restored from backup: ${result.restored}\n- Files: ${result.files}${result.label ? '\n- Label: ' + result.label : ''}\n⚠️ Store needs re-initialization. Restart the MCP server.` }] };
}

async function handleGC(backup: Backup, opts: { maxAge?: number; maxCount?: number }): Promise<ToolResponse> {
  const removed = await backup.gc(opts.maxAge, opts.maxCount);
  return { content: [{ type: 'text', text: `🧹 GC complete: ${removed} backup(s) removed.` }] };
}

async function handleAssemble(
  assembler: Assembler,
  opts: { query?: string; activeFile?: string; budget?: number; layers?: string[] },
  config: ArachneConfig,
  kvBridge?: KVBridge,
): Promise<ToolResponse> {
  if (!opts.query) {
    return { content: [{ type: 'text', text: 'Error: query is required for assemble action' }], isError: true };
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
    `- Tokens: ${meta.tokensUsed.toLocaleString()} / ${meta.budget.toLocaleString()} (${Math.round(meta.tokensUsed / meta.budget * 100)}% used)`,
    `- Layers:`,
    ...Object.entries(meta.layers).map(([k, v]) => `  ${k}: ${v.tokens.toLocaleString()} tokens, ${v.itemCount} items`),
  ];

  const text = `${header.join('\n')}\n\n---\n\n${result.context}`;
  return { content: [{ type: 'text', text }] };
}
