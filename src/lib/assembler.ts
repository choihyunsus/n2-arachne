// 4-Layer paging algorithm for automatic AI context assembly
// Arachne's core value: "Automatically selects the code AI needs right now"
import path from 'path';
import fs from 'fs';
import type { Store } from './store';
import type { BM25Search } from './search';
import type { VectorStore } from './vector-store';
import type {
  AssemblyConfig, LayerWeights, LayerResult, LayerItem,
  AssembleOptions, AssembleResult, ChunkRow, SearchResult,
} from '../types';

/** File tree node for L1 structure generation */
interface TreeNode {
  _file?: boolean;
  _lang?: string | null;
  _chunks?: number;
  [key: string]: TreeNode | boolean | string | number | null | undefined;
}

/**
 * Estimate token count (without exact tokenizer)
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

export class Assembler {
  private readonly _store: Store;
  private readonly _search: BM25Search;
  private readonly _config: Partial<AssemblyConfig>;
  private readonly _defaultBudget: number;
  private readonly _layers: LayerWeights;
  private readonly _depthLimit: number;
  private _vectorStore: VectorStore | null = null;

  constructor(store: Store, search: BM25Search, assemblyConfig?: Partial<AssemblyConfig>) {
    this._store = store;
    this._search = search;
    this._config = assemblyConfig ?? {};
    this._defaultBudget = this._config.defaultBudget ?? 40000;
    this._layers = this._config.layers ?? {
      fixed: 0.10,
      shortTerm: 0.30,
      associative: 0.40,
      spare: 0.20,
    };
    this._depthLimit = this._config.dependencyDepth ?? 2;
  }

  /** Connect VectorStore (Phase 3 semantic search) */
  setVectorStore(vectorStore: VectorStore): void {
    this._vectorStore = vectorStore;
  }

  /**
   * Main context assembly function
   */
  async assemble(query: string, options: AssembleOptions = {}): Promise<AssembleResult> {
    const safeQuery = (query && typeof query === 'string') ? query : '';
    const budget = options.budget ?? this._defaultBudget;
    const enabledLayers = options.layers ?? ['fixed', 'shortTerm', 'associative', 'spare'];
    const projectDir = options.projectDir ?? this._store.getMeta('project_dir') ?? process.cwd();

    const { layerResults, totalUsed } = await this._executeLayers(
      safeQuery, enabledLayers, budget, projectDir, options.activeFile,
    );

    this._logAccess(safeQuery, options.activeFile, layerResults);
    const context = this._arrangeOutput(layerResults);

    return {
      context,
      metadata: {
        query: safeQuery, budget,
        tokensUsed: totalUsed,
        tokensRemaining: budget - totalUsed,
        layers: Object.fromEntries(
          Object.entries(layerResults).map(([k, v]) => [k, { tokens: v.tokens, itemCount: v.items.length }])
        ),
      },
    };
  }

  /** Execute each enabled layer within budget */
  private async _executeLayers(
    query: string, enabledLayers: string[], budget: number,
    projectDir: string, activeFile?: string,
  ): Promise<{ layerResults: Record<string, LayerResult>; totalUsed: number }> {
    const layerResults: Record<string, LayerResult> = {};
    let totalUsed = 0;

    if (enabledLayers.includes('fixed')) {
      const l1 = this._buildLayer1(projectDir, Math.floor(budget * this._layers.fixed));
      layerResults['fixed'] = l1; totalUsed += l1.tokens;
    }
    if (enabledLayers.includes('shortTerm')) {
      const l2 = this._buildLayer2(activeFile, Math.floor(budget * this._layers.shortTerm), projectDir);
      layerResults['shortTerm'] = l2; totalUsed += l2.tokens;
    }
    if (enabledLayers.includes('associative')) {
      const l3 = await this._buildLayer3(query, activeFile, Math.floor(budget * this._layers.associative));
      layerResults['associative'] = l3; totalUsed += l3.tokens;
    }
    if (enabledLayers.includes('spare')) {
      const l4Budget = Math.min(Math.floor(budget * this._layers.spare), budget - totalUsed);
      if (l4Budget > 500) {
        const l4 = this._buildLayer4(l4Budget);
        layerResults['spare'] = l4; totalUsed += l4.tokens;
      }
    }
    return { layerResults, totalUsed };
  }

  // ── Layer Builders ──

  private _buildLayer1(projectDir: string, budget: number): LayerResult {
    const tree = this._generateFileTree(projectDir, 3);
    const tokens = estimateTokens(tree);

    if (tokens > budget) {
      const shortTree = this._generateFileTree(projectDir, 2);
      const shortTokens = estimateTokens(shortTree);
      if (shortTokens <= budget) {
        return { text: shortTree, tokens: shortTokens, items: [] };
      }
      const truncated = shortTree.slice(0, Math.floor(budget * 3.5));
      return { text: truncated, tokens: estimateTokens(truncated), items: [] };
    }

    return { text: tree, tokens, items: [] };
  }

  /** Load active file content (full or chunked) */
  private _loadActiveFile(
    activeFile: string, budget: number, projectDir: string,
  ): { text: string; tokens: number; items: LayerItem[] } {
    const fileRecord = this._store.getFileByPath(activeFile);
    if (!fileRecord) return { text: '', tokens: 0, items: [] };

    const fullPath = path.join(projectDir, activeFile);
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const fileTokens = estimateTokens(content);

      if (fileTokens <= budget * 0.7) {
        const text = `\n## Active File: ${activeFile}\n\`\`\`${fileRecord.language ?? ''}\n${content}\n\`\`\`\n`;
        return { text, tokens: fileTokens, items: [{ type: 'activeFile', path: activeFile, tokens: fileTokens }] };
      }

      const chunks = this._store.getChunksByFileId(fileRecord.id);
      let chunkText = '';
      let chunkTokens = 0;
      for (const chunk of chunks) {
        if (chunkTokens + chunk.token_count > budget * 0.7) break;
        chunkText += `// ${chunk.name ?? chunk.chunk_type} (L${chunk.start_line}-${chunk.end_line})\n${chunk.content}\n\n`;
        chunkTokens += chunk.token_count;
      }
      const text = `\n## Active File: ${activeFile} (key chunks)\n\`\`\`${fileRecord.language ?? ''}\n${chunkText}\`\`\`\n`;
      return { text, tokens: chunkTokens, items: [{ type: 'activeFileChunks', path: activeFile, tokens: chunkTokens }] };
    } catch {
      return { text: '', tokens: 0, items: [] };
    }
  }

  private _buildLayer2(activeFile: string | undefined, budget: number, projectDir: string): LayerResult {
    let text = '';
    let tokens = 0;
    const items: LayerItem[] = [];

    if (activeFile) {
      const active = this._loadActiveFile(activeFile, budget, projectDir);
      text += active.text;
      tokens += active.tokens;
      items.push(...active.items);
    }

    const remaining = budget - tokens;
    if (remaining > 500) {
      const recentFiles = this._store.getRecentFiles(5);
      for (const rf of recentFiles) {
        if (rf.path === activeFile) continue;
        const chunks = this._store.getChunksByFileId(rf.file_id);
        if (chunks.length === 0) continue;

        const topChunk = chunks[0]!;
        if (tokens + topChunk.token_count > budget) break;

        text += `\n## Recent File: ${rf.path}\n\`\`\`${topChunk.language ?? ''}\n${topChunk.content}\n\`\`\`\n`;
        tokens += topChunk.token_count;
        items.push({ type: 'recentFile', path: rf.path, tokens: topChunk.token_count });
      }
    }

    return { text, tokens, items };
  }

  private async _buildLayer3(query: string, activeFile: string | undefined, budget: number): Promise<LayerResult> {
    let text = '';
    let tokens = 0;
    const items: LayerItem[] = [];

    let searchResults: SearchResult[];
    if (this._vectorStore?.isReady) {
      const hybridResults = await this._search.hybridSearch(query, { topK: 20 });
      searchResults = hybridResults.map(r => ({ chunk: r.chunk, score: r.score }));
    } else {
      searchResults = this._search.search(query, { topK: 20 });
    }
    const depChunks = this._getDependencyChunks(activeFile);
    const merged = this._mergeSearchAndDeps(searchResults, depChunks);

    for (const item of merged) {
      const chunkTokens = item.chunk.token_count || estimateTokens(item.chunk.content);
      if (tokens + chunkTokens > budget) continue;

      const filePath = item.chunk.file_path ?? '';
      const tag = item.source === 'dependency' ? ' [dep]' : '';
      const chunkLabel = item.chunk.name
        ? `${item.chunk.chunk_type}: ${item.chunk.name}`
        : item.chunk.chunk_type;

      text += `\n## ${filePath}:${item.chunk.start_line}-${item.chunk.end_line} [${chunkLabel}]${tag}\n\`\`\`${item.chunk.language ?? ''}\n${item.chunk.content}\n\`\`\`\n`;
      tokens += chunkTokens;
      items.push({
        type: item.source, path: filePath, chunk: chunkLabel,
        score: item.score, tokens: chunkTokens,
      });
    }

    return { text, tokens, items };
  }

  private _getDependencyChunks(activeFile: string | undefined): ChunkRow[] {
    if (!activeFile) return [];
    const fileRecord = this._store.getFileByPath(activeFile);
    if (!fileRecord) return [];

    const deps = this._store.getTransitiveDependencies(fileRecord.id, this._depthLimit);
    const depFileIds = deps.filter(d => d.target_file_id).map(d => d.target_file_id!);
    return depFileIds.length > 0 ? this._store.getChunksByFileIds(depFileIds) : [];
  }

  private _mergeSearchAndDeps(
    searchResults: SearchResult[],
    depChunks: ChunkRow[],
  ): Array<{ chunk: ChunkRow; score: number; source: string }> {
    const merged = searchResults.map(r => ({ chunk: r.chunk, score: r.score, source: 'search' }));

    const baseDepScore = searchResults.length > 0
      ? searchResults[searchResults.length - 1]!.score * 0.8 : 1.0;

    for (const chunk of depChunks) {
      const key = `${chunk.file_path}:${chunk.start_line}`;
      if (merged.some(m => `${m.chunk.file_path}:${m.chunk.start_line}` === key)) continue;
      merged.push({ chunk, score: baseDepScore, source: 'dependency' });
    }

    merged.sort((a, b) => b.score - a.score);
    return merged;
  }

  private _buildLayer4(budget: number): LayerResult {
    let text = '';
    let tokens = 0;
    const items: LayerItem[] = [];

    const frequentFiles = this._store.getMostAccessedFiles(5);

    for (const ff of frequentFiles) {
      const chunks = this._store.getChunksByFileId(ff.file_id);
      if (chunks.length === 0) continue;

      const sortedChunks = [...chunks].sort((a, b) => a.token_count - b.token_count);
      for (const chunk of sortedChunks) {
        if (tokens + chunk.token_count > budget) break;
        text += `\n## ${ff.path}:${chunk.start_line}-${chunk.end_line} [${chunk.name ?? chunk.chunk_type}] (freq: ${ff.access_count ?? 0})\n\`\`\`${chunk.language ?? ''}\n${chunk.content}\n\`\`\`\n`;
        tokens += chunk.token_count;
        items.push({
          type: 'frequent',
          path: ff.path,
          chunk: chunk.name ?? chunk.chunk_type,
          accessCount: ff.access_count ?? 0,
          tokens: chunk.token_count,
        });
        break;
      }
    }

    return { text, tokens, items };
  }

  // ── Output Arrangement ──

  private _arrangeOutput(layerResults: Record<string, LayerResult>): string {
    const sections: string[] = [];

    if (layerResults['fixed']?.text) {
      sections.push(`# 📁 Project Structure\n${layerResults['fixed'].text}`);
    }
    if (layerResults['associative']?.text) {
      sections.push(`# 🔗 Related Code\n${layerResults['associative'].text}`);
    }
    if (layerResults['spare']?.text) {
      sections.push(`# 📊 Frequently Referenced Code\n${layerResults['spare'].text}`);
    }
    if (layerResults['shortTerm']?.text) {
      sections.push(`# 📄 Current Work Context\n${layerResults['shortTerm'].text}`);
    }

    return sections.join('\n---\n');
  }

  // ── Utilities ──

  private _generateFileTree(_projectDir: string, maxDepth: number): string {
    const files = this._store.getAllFiles();
    if (files.length === 0) return '(no indexed files)';

    const tree: TreeNode = {};
    for (const f of files) {
      const parts = f.path.split('/');
      if (parts.length - 1 > maxDepth) continue;

      let node: TreeNode = tree;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        if (i === parts.length - 1) {
          node[part] = { _file: true, _lang: f.language, _chunks: f.chunk_count };
        } else {
          if (!node[part]) node[part] = {};
          node = node[part] as TreeNode;
        }
      }
    }

    return this._renderTree(tree, '', true);
  }

  private _renderTree(node: TreeNode, prefix: string, isRoot: boolean): string {
    const lines: string[] = [];
    const entries = Object.entries(node).filter(([k]) => !k.startsWith('_'));
    entries.sort((a, b) => {
      const aIsDir = !(a[1] as TreeNode)?._file;
      const bIsDir = !(b[1] as TreeNode)?._file;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a[0].localeCompare(b[0]);
    });

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const [name, child] = entry;
      const isLast = i === entries.length - 1;
      const connector = isRoot ? '' : (isLast ? '└── ' : '├── ');
      const childPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ');

      if ((child as TreeNode)?._file) {
        lines.push(`${prefix}${connector}${name}`);
      } else {
        lines.push(`${prefix}${connector}${name}/`);
        lines.push(this._renderTree(child as TreeNode, childPrefix, false));
      }
    }

    return lines.filter(Boolean).join('\n');
  }

  private _logAccess(query: string, activeFile: string | undefined, layerResults: Record<string, LayerResult>): void {
    try {
      if (activeFile) {
        const fileRecord = this._store.getFileByPath(activeFile);
        if (fileRecord) {
          this._store.logAccess(fileRecord.id, query);
        }
      }

      if (layerResults['associative']?.items) {
        const loggedPaths = new Set<string>();
        for (const item of layerResults['associative'].items) {
          if (!item.path || loggedPaths.has(item.path)) continue;
          loggedPaths.add(item.path);
          const fileRecord = this._store.getFileByPath(item.path);
          if (fileRecord) {
            this._store.logAccess(fileRecord.id, query);
          }
        }
      }
    } catch {
      // Access log failure is non-fatal
    }
  }
}
