// Four scoped context layers with bounded reads and rendered token estimates.
import path from 'node:path';
import fs from 'node:fs';
import type { Store } from './store';
import type { BM25Search } from './search';
import type { VectorStore } from './vector-store';
import { integer, relativePath, text } from './store-values';
import { readSource } from './scan-files';
import { LayerWriter, estimateTokens } from './layer-writer';
import type {
  AssemblyConfig,
  LayerWeights,
  LayerResult,
  LayerItem,
  AssembleOptions,
  AssembleResult,
  ChunkRow,
  SearchResult,
} from '../types';

export { estimateTokens } from './layer-writer';
const TITLES = {
  fixed: 'Project Structure',
  shortTerm: 'Current Work Context',
  associative: 'Related Code',
  spare: 'Frequently Referenced Code',
};
type LayerName = keyof typeof TITLES;
interface Selection {
  chunks: Set<number>;
  files: Set<string>;
  warnings: string[];
}

export class Assembler {
  private readonly budget: number;
  private readonly weights: LayerWeights;
  private readonly depth: number;
  private readonly multiplier: number;

  constructor(
    private readonly store: Store,
    private readonly search: BM25Search,
    config: Partial<AssemblyConfig> = {},
  ) {
    this.budget = integer(config.defaultBudget ?? 40000, 'default context budget', 1000000);
    this.weights = {
      ...(config.layers ?? {
        fixed: 0.1,
        shortTerm: 0.3,
        associative: 0.4,
        spare: 0.2,
      }),
    };
    this.depth = integer(config.dependencyDepth ?? 2, 'dependency depth', 20);
    this.multiplier = config.tokenMultiplier ?? 3.5;
    estimateTokens('', this.multiplier);
    const weights = Object.keys(TITLES).map((name) => this.weights[name as LayerName]);
    if (
      weights.some((value) => !Number.isFinite(value) || value < 0) ||
      weights.reduce((sum, value) => sum + value, 0) > 1
    )
      throw new Error('Context layer weights must be nonnegative and sum to at most one');
  }

  setVectorStore(vectorStore: VectorStore): void {
    this.search.setVectorStore(vectorStore);
  }

  async assemble(query: string, options: AssembleOptions = {}): Promise<AssembleResult> {
    text(query, 'context query');
    if (query.length > 4096) throw new Error('Context query exceeds 4096 characters');
    const budget = integer(options.budget ?? this.budget, 'context budget', 1000000);
    const layers = this.enabledLayers(options.layers);
    if (
      options.projectDir &&
      fs.realpathSync(path.resolve(options.projectDir)) !== this.store.projectRoot
    )
      throw new Error('Context project root differs from the Store');
    const active = options.activeFile === undefined ? undefined : relativePath(options.activeFile);
    const selection: Selection = {
      chunks: new Set(),
      files: new Set(),
      warnings: [],
    };
    const shouldSearch =
      budget > 0 && layers.includes('associative') && this.weights.associative > 0;
    const hits = shouldSearch ? await this.search.hybridSearch(query, { topK: 20 }) : [];
    if (shouldSearch && this.search.getLastSemanticError())
      selection.warnings.push(`Semantic search unavailable. ${this.search.getLastSemanticError()}`);
    const results = this.store.db
      .transaction(() => this.buildLayers(layers, budget, active, hits, selection))
      .deferred();
    this.logAccess(query, results, selection.warnings);
    const context = ['fixed', 'associative', 'spare', 'shortTerm']
      .map((name) => results[name]?.text ?? '')
      .join('');
    const used = estimateTokens(context, this.multiplier);
    return {
      context,
      metadata: {
        query,
        budget,
        tokensUsed: used,
        tokensRemaining: budget - used,
        layers: Object.fromEntries(
          Object.entries(results).map(([name, layer]) => [
            name,
            { tokens: layer.tokens, itemCount: layer.items.length },
          ]),
        ),
        warnings: selection.warnings,
      },
    };
  }

  private enabledLayers(layers = Object.keys(TITLES)): LayerName[] {
    if (
      !Array.isArray(layers) ||
      layers.length > 4 ||
      layers.some((name) => !Object.hasOwn(TITLES, name))
    )
      throw new Error('Invalid context layers');
    return [...new Set(layers)] as LayerName[];
  }

  private buildLayers(
    layers: LayerName[],
    budget: number,
    active: string | undefined,
    hits: SearchResult[],
    selection: Selection,
  ): Record<string, LayerResult> {
    const results: Record<string, LayerResult> = {};
    for (const name of Object.keys(TITLES) as LayerName[]) {
      if (!layers.includes(name)) continue;
      const writer = new LayerWriter(
        TITLES[name],
        Math.floor(budget * this.weights[name]),
        this.multiplier,
      );
      if (writer.remaining > 0) this.fillLayer(name, writer, active, hits, selection);
      results[name] = writer.result();
    }
    return results;
  }

  private fillLayer(
    name: LayerName,
    writer: LayerWriter,
    active: string | undefined,
    hits: SearchResult[],
    selection: Selection,
  ): void {
    switch (name) {
      case 'fixed':
        this.addTree(writer);
        break;
      case 'shortTerm':
        if (active) this.addActive(writer, active, selection);
        for (const file of this.store.getRecentFiles(5))
          this.addFileChunks(writer, file.file_id, 'recentFile', selection, true);
        break;
      case 'associative':
        for (const hit of hits) {
          const current = this.store.getChunk(hit.chunk.id);
          if (current)
            this.addChunk(writer, current, { type: 'search', score: hit.score }, selection);
        }
        if (active) this.addDependencies(writer, active, selection);
        break;
      case 'spare':
        for (const file of this.store.getMostAccessedFiles(5))
          this.addFileChunks(writer, file.file_id, 'frequent', selection, true);
        break;
    }
  }

  private addTree(writer: LayerWriter): void {
    const rows = this.store.db
      .prepare('SELECT path FROM arachne_files WHERE project=? AND agent=? ORDER BY path')
      .iterate(this.store.project, this.store.agent);
    let listing = '';
    for (const value of rows) {
      const filename = relativePath(text((value as { path: unknown }).path, 'indexed path'));
      listing += JSON.stringify(filename) + '\n';
      if (listing.length > writer.remaining) break;
    }
    writer.addText(listing || '(no indexed files)\n');
  }

  private addActive(writer: LayerWriter, filename: string, selection: Selection): void {
    const file = this.store.getFileByPath(filename);
    if (!file) return;
    try {
      const content = readSource(
        this.store.projectRoot,
        path.join(this.store.projectRoot, filename),
        10 * 1024 * 1024,
      );
      if (
        writer.addSnippet(`Active File ${JSON.stringify(filename)}`, file.language, content, {
          type: 'activeFile',
          path: filename,
        })
      )
        selection.files.add(filename);
    } catch (error) {
      selection.warnings.push(
        `Active file ${JSON.stringify(filename)} could not be read. ${(error as Error).message}. Indexed chunks were considered.`,
      );
      this.addFileChunks(writer, file.id, 'activeFileChunks', selection);
    }
  }

  private addDependencies(writer: LayerWriter, active: string, selection: Selection): void {
    const file = this.store.getFileByPath(active);
    if (!file) return;
    const dependencies = this.store.getTransitiveDependencies(file.id, this.depth);
    for (const dependency of dependencies) {
      if (writer.remaining < 100) break;
      if (dependency.target_file_id !== null)
        this.addFileChunks(writer, dependency.target_file_id, 'dependency', selection);
    }
  }

  private addFileChunks(
    writer: LayerWriter,
    fileId: number,
    type: string,
    selection: Selection,
    firstOnly = false,
  ): void {
    for (const chunk of this.store.iterateChunksByFileId(fileId)) {
      if (writer.remaining < 100) break;
      const added = this.addChunk(writer, chunk, { type }, selection);
      if (added && firstOnly) break;
    }
  }

  private addChunk(
    writer: LayerWriter,
    chunk: ChunkRow,
    item: LayerItem,
    selection: Selection,
  ): boolean {
    const filename = chunk.file_path ?? '';
    if (selection.chunks.has(chunk.id) || selection.files.has(filename)) return false;
    const label = `${JSON.stringify(filename)} L${chunk.start_line}-${chunk.end_line} [${chunk.name ?? chunk.chunk_type}]`;
    const added = writer.addSnippet(label, chunk.language, chunk.content, {
      ...item,
      path: filename,
      chunk: chunk.name ?? chunk.chunk_type,
    });
    if (added) selection.chunks.add(chunk.id);
    return added;
  }

  private logAccess(query: string, results: Record<string, LayerResult>, warnings: string[]): void {
    const paths = new Set(
      Object.values(results).flatMap((layer) =>
        layer.items
          .map((item) => item.path)
          .filter((filename): filename is string => filename !== undefined),
      ),
    );
    try {
      this.store.db
        .transaction(() => {
          for (const filename of paths) {
            const file = this.store.getFileByPath(filename);
            if (file) this.store.logAccess(file.id, query);
          }
        })
        .immediate();
    } catch (error) {
      warnings.push(`Access history could not be saved. ${(error as Error).message}`);
    }
  }
}
