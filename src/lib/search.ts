// BM25 keyword search (lightweight version of QLN router)
// Adapted from QLN Router._stage2BM25 logic, optimized for code search
import type { Store } from './store';
import type { VectorStore } from './vector-store';
import type { ChunkRow, SearchResult, HybridSearchResult, SearchOptions, HybridSearchOptions, SearchConfig } from '../types';

export class BM25Search {
  private readonly _store: Store;
  private readonly _k1: number;
  private readonly _b: number;
  private readonly _topK: number;
  private _vectorStore: VectorStore | null = null;

  constructor(store: Store, config: SearchConfig) {
    this._store = store;
    this._k1 = config.bm25?.k1 ?? 1.2;
    this._b = config.bm25?.b ?? 0.75;
    this._topK = config.topK ?? 10;
  }

  /**
   * Execute BM25 search
   */
  search(query: string, options: SearchOptions = {}): SearchResult[] {
    if (!query || typeof query !== 'string') return [];
    const topK = options.topK ?? this._topK;
    const terms = this._tokenize(query);
    if (terms.length === 0) return [];

    // Load all chunks (with language filter)
    const chunks = this._loadChunks(options.language);
    if (chunks.length === 0) return [];

    // Calculate document statistics
    const N = chunks.length;
    const avgDl = chunks.reduce((sum, c) => sum + (c.search_text ?? '').length, 0) / N;

    // Calculate DF (document frequency)
    const df: Record<string, number> = {};
    for (const term of terms) {
      df[term] = chunks.filter(c => (c.search_text ?? '').toLowerCase().includes(term)).length;
    }

    // Calculate BM25 scores
    const scored: SearchResult[] = [];
    for (const chunk of chunks) {
      const doc = (chunk.search_text ?? '').toLowerCase();
      const dl = doc.length;
      let score = 0;

      for (const term of terms) {
        const tf = this._countOccurrences(doc, term);
        if (tf === 0) continue;
        const termDf = df[term] ?? 0;
        const idf = Math.log((N - termDf + 0.5) / (termDf + 0.5) + 1);
        const numerator = tf * (this._k1 + 1);
        const denominator = tf + this._k1 * (1 - this._b + this._b * (dl / avgDl));
        score += idf * (numerator / denominator);
      }

      if (score > 0) {
        score = this._applyBonuses(score, chunk, terms);
        scored.push({ chunk, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** Apply filename/function name matching bonuses */
  private _applyBonuses(score: number, chunk: ChunkRow, terms: string[]): number {
    let result = score;
    const filePath = (chunk.file_path ?? '').toLowerCase();
    for (const term of terms) {
      if (filePath.includes(term)) result *= 1.3;
    }
    if (chunk.name) {
      const chunkName = chunk.name.toLowerCase();
      for (const term of terms) {
        if (chunkName.includes(term)) result *= 1.5;
      }
    }
    return result;
  }

  /** Load chunks (with optional language filter) */
  private _loadChunks(language?: string): ChunkRow[] {
    const sql = language
      ? `SELECT c.*, f.path as file_path, f.language FROM chunks c JOIN files f ON c.file_id = f.id WHERE f.language = ?`
      : `SELECT c.*, f.path as file_path, f.language FROM chunks c JOIN files f ON c.file_id = f.id`;
    return (language
      ? this._store.db.prepare(sql).all(language)
      : this._store.db.prepare(sql).all()) as ChunkRow[];
  }

  /** Tokenize text */
  private _tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\u3131-\uD79D_\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2);
  }

  /** Count term occurrences in text */
  private _countOccurrences(text: string, term: string): number {
    let count = 0;
    let pos = 0;
    while ((pos = text.indexOf(term, pos)) !== -1) {
      count++;
      pos += term.length;
    }
    return count;
  }

  /**
   * Connect VectorStore (Phase 3)
   */
  setVectorStore(vectorStore: VectorStore): void {
    this._vectorStore = vectorStore;
  }

  /**
   * Hybrid search: BM25 + semantic weighted merge
   */
  async hybridSearch(query: string, options: HybridSearchOptions = {}): Promise<HybridSearchResult[]> {
    if (!query || typeof query !== 'string') return [];
    const topK = options.topK ?? 10;
    const alpha = options.alpha ?? 0.5;

    // BM25 search
    const bm25Results = this.search(query, { topK: topK * 2 });

    // No VectorStore → BM25-only fallback
    if (!this._vectorStore || !this._vectorStore.isReady) {
      return bm25Results.map(r => ({
        chunk: r.chunk,
        score: r.score,
        bm25Score: r.score,
        semanticScore: 0,
      })).slice(0, topK);
    }

    // Semantic search
    const vecResults = await this._vectorStore.search(query, topK * 2);

    // Normalize BM25 scores (0~1)
    const maxBm25 = bm25Results.length > 0 ? bm25Results[0]!.score : 1;
    const bm25Map = new Map<number, { chunk: ChunkRow; normalizedScore: number; rawScore: number }>();
    for (const r of bm25Results) {
      bm25Map.set(r.chunk.id, {
        chunk: r.chunk,
        normalizedScore: maxBm25 > 0 ? r.score / maxBm25 : 0,
        rawScore: r.score,
      });
    }

    // Semantic distance → similarity
    const maxDist = vecResults.length > 0 ? Math.max(...vecResults.map(v => v.distance), 1) : 1;
    const vecMap = new Map<number, number>();
    for (const v of vecResults) {
      vecMap.set(v.chunkId, maxDist > 0 ? 1 - (v.distance / maxDist) : 0);
    }

    // Merge: collect all candidates
    const allIds = new Set<number>([...bm25Map.keys(), ...vecMap.keys()]);
    const merged: HybridSearchResult[] = [];

    for (const id of allIds) {
      const bm25Entry = bm25Map.get(id);
      const semanticScore = vecMap.get(id) ?? 0;
      const bm25Normalized = bm25Entry ? bm25Entry.normalizedScore : 0;

      const hybridScore = (1 - alpha) * bm25Normalized + alpha * semanticScore;

      let chunk = bm25Entry ? bm25Entry.chunk : null;
      if (!chunk) {
        const row = this._store.db.prepare(
          `SELECT c.*, f.path as file_path, f.language
           FROM chunks c JOIN files f ON c.file_id = f.id
           WHERE c.id = ?`
        ).get(id) as ChunkRow | undefined;
        if (!row) continue;
        chunk = row;
      }

      merged.push({
        chunk,
        score: hybridScore,
        bm25Score: bm25Entry ? bm25Entry.rawScore : 0,
        semanticScore,
      });
    }

    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, topK);
  }
}
