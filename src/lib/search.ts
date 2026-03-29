// BM25 keyword search — memory-optimized with Rust zero-marshal cache
// JS holds only cache metadata. Rust holds search data. Top-K lookup from DB.
import type { Store } from './store';
import type { VectorStore } from './vector-store';
import type { ChunkRow, SearchResult, HybridSearchResult, SearchOptions, HybridSearchOptions, SearchConfig, VectorSearchResult } from '../types';
import { getNative } from './native-bridge';

/** Lightweight row for Rust cache loading (no content/metadata) */
interface SearchDataRow {
  id: number;
  search_text: string | null;
}

/** Lightweight cache metadata (no ChunkRow[] in memory) */
interface CacheMeta {
  version: number;
  language?: string;
  count: number;
}

export class BM25Search {
  private readonly _store: Store;
  private readonly _k1: number;
  private readonly _b: number;
  private readonly _topK: number;
  private _vectorStore: VectorStore | null = null;

  // ── Lightweight cache state ──────────────────────────────────────
  private _cacheMeta: CacheMeta | null = null;
  private _cacheVersion = 0;
  private _rustCacheReady = false;

  // Prepared statements (reusable, avoids re-compile per query)
  private _stmtChunkById: ReturnType<Store['db']['prepare']> | null = null;

  constructor(store: Store, config: SearchConfig) {
    this._store = store;
    this._k1 = config.bm25?.k1 ?? 1.2;
    this._b = config.bm25?.b ?? 0.75;
    this._topK = config.topK ?? 10;
  }

  /** Invalidate cache (call after indexing/re-indexing) */
  invalidateCache(): void {
    this._cacheVersion++;
    this._cacheMeta = null;
    this._rustCacheReady = false;
  }

  /**
   * Pre-warm: loads chunk IDs + search text → sends to Rust → discards from JS.
   * JS memory: ~0. Rust memory: search data only.
   */
  warmCache(language?: string): number {
    // Load only id + search_text (lightweight query)
    const rows = this._loadSearchData(language);
    if (rows.length === 0) return 0;

    const chunkIds = new Array<number>(rows.length);
    const searchTexts = new Array<string>(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      chunkIds[i] = row.id;
      searchTexts[i] = row.search_text ?? '';
    }

    // Send to Rust heap (pre-lowercased, stored permanently)
    const native = getNative();
    if (native && typeof native.bm25InitStore === 'function') {
      try {
        native.bm25InitStore(chunkIds, searchTexts);
        this._rustCacheReady = true;
      } catch {
        this._rustCacheReady = false;
      }
    }

    // JS keeps only metadata — rows/arrays are GC'd
    this._cacheMeta = { version: this._cacheVersion, language, count: rows.length };
    return rows.length;
  }

  /** Execute BM25 search */
  search(query: string, options: SearchOptions = {}): SearchResult[] {
    if (!query || typeof query !== 'string') return [];
    const topK = options.topK ?? this._topK;
    const terms = this._tokenize(query);
    if (terms.length === 0) return [];

    // Ensure cache is warm
    this._ensureCache(options.language);

    const native = getNative();

    // ── Path 1: Rust cached (zero marshal, best) ───────────────────
    if (native && this._rustCacheReady && typeof native.bm25SearchCached === 'function') {
      try {
        const hits = native.bm25SearchCached(terms.join(' '), topK * 3, this._k1, this._b);
        return this._lookupAndBoost(hits, terms, topK);
      } catch {
        // Fall through to TS
      }
    }

    // ── Path 2: Rust per-call (has marshal overhead) ───────────────
    if (native) {
      const rows = this._loadSearchData(options.language);
      const ids = rows.map(r => r.id);
      const texts = rows.map(r => r.search_text ?? '');
      const hits = native.bm25Search(query, ids, texts, topK * 3, this._k1, this._b);
      return this._lookupAndBoost(hits, terms, topK);
    }

    // ── Path 3: Pure TypeScript fallback ────────────────────────────
    const chunks = this._loadFullChunks(options.language);
    return this._searchTS(chunks, terms, topK);
  }

  /**
   * Lookup top-K chunk metadata from DB + apply bonuses.
   * Only fetches the result chunks (10-30 rows), not all 50K.
   */
  private _lookupAndBoost(
    hits: Array<{ chunkId: number; score: number }>,
    terms: string[],
    topK: number,
  ): SearchResult[] {
    if (hits.length === 0) return [];

    // Lazily prepare statement
    if (!this._stmtChunkById) {
      this._stmtChunkById = this._store.db.prepare(
        `SELECT c.*, f.path as file_path, f.language
         FROM chunks c JOIN files f ON c.file_id = f.id
         WHERE c.id = ?`
      );
    }

    const scored: SearchResult[] = [];
    for (const hit of hits) {
      const chunk = this._stmtChunkById.get(hit.chunkId) as ChunkRow | undefined;
      if (!chunk) continue;
      scored.push({ chunk, score: this._applyBonuses(hit.score, chunk, terms) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** Ensure cache is warm for the given language filter */
  private _ensureCache(language?: string): void {
    if (this._cacheMeta && this._cacheMeta.version === this._cacheVersion && this._cacheMeta.language === language) {
      return; // Cache valid
    }
    this.warmCache(language);
  }

  /** Load only id + search_text (lightweight, no content/metadata) */
  private _loadSearchData(language?: string): SearchDataRow[] {
    const sql = language
      ? `SELECT c.id, c.search_text FROM chunks c JOIN files f ON c.file_id = f.id WHERE f.language = ?`
      : `SELECT c.id, c.search_text FROM chunks c`;
    return (language
      ? this._store.db.prepare(sql).all(language)
      : this._store.db.prepare(sql).all()) as SearchDataRow[];
  }

  /** Load full chunk rows (TS fallback only) */
  private _loadFullChunks(language?: string): ChunkRow[] {
    const sql = language
      ? `SELECT c.*, f.path as file_path, f.language FROM chunks c JOIN files f ON c.file_id = f.id WHERE f.language = ?`
      : `SELECT c.*, f.path as file_path, f.language FROM chunks c JOIN files f ON c.file_id = f.id`;
    return (language
      ? this._store.db.prepare(sql).all(language)
      : this._store.db.prepare(sql).all()) as ChunkRow[];
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

  /** TypeScript BM25 fallback */
  private _searchTS(chunks: ChunkRow[], terms: string[], topK: number): SearchResult[] {
    const N = chunks.length;
    const avgDl = chunks.reduce((sum, c) => sum + (c.search_text ?? '').length, 0) / N;

    const df: Record<string, number> = {};
    for (const term of terms) {
      df[term] = chunks.filter(c => (c.search_text ?? '').toLowerCase().includes(term)).length;
    }

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
        score += idf * (tf * (this._k1 + 1)) / (tf + this._k1 * (1 - this._b + this._b * (dl / avgDl)));
      }

      if (score > 0) {
        scored.push({ chunk, score: this._applyBonuses(score, chunk, terms) });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** Tokenize text */
  private _tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\u3131-\uD79D_\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2);
  }

  /** Count term occurrences */
  private _countOccurrences(text: string, term: string): number {
    let count = 0;
    let pos = 0;
    while ((pos = text.indexOf(term, pos)) !== -1) {
      count++;
      pos += term.length;
    }
    return count;
  }

  /** Connect VectorStore */
  setVectorStore(vectorStore: VectorStore): void {
    this._vectorStore = vectorStore;
  }

  /** Hybrid search: BM25 + semantic weighted merge */
  async hybridSearch(query: string, options: HybridSearchOptions = {}): Promise<HybridSearchResult[]> {
    if (!query || typeof query !== 'string') return [];
    const topK = options.topK ?? 10;
    const alpha = options.alpha ?? 0.5;

    const bm25Results = this.search(query, { topK: topK * 2 });

    if (!this._vectorStore || !this._vectorStore.isReady) {
      return bm25Results.map(r => ({
        chunk: r.chunk, score: r.score, bm25Score: r.score, semanticScore: 0,
      })).slice(0, topK);
    }

    const vecResults = await this._vectorStore.search(query, topK * 2);

    return this._mergeHybridResults(bm25Results, vecResults, alpha, topK);
  }

  /** Normalize BM25 + vector scores and merge into hybrid results */
  private _mergeHybridResults(
    bm25Results: SearchResult[], vecResults: VectorSearchResult[],
    alpha: number, topK: number,
  ): HybridSearchResult[] {
    const maxBm25 = bm25Results.length > 0 ? bm25Results[0]!.score : 1;
    const bm25Map = new Map<number, { chunk: ChunkRow; norm: number; raw: number }>();
    for (const r of bm25Results) {
      bm25Map.set(r.chunk.id, { chunk: r.chunk, norm: maxBm25 > 0 ? r.score / maxBm25 : 0, raw: r.score });
    }

    const maxDist = vecResults.length > 0 ? Math.max(...vecResults.map(v => v.distance), 1) : 1;
    const vecMap = new Map<number, number>();
    for (const v of vecResults) {
      vecMap.set(v.chunkId, maxDist > 0 ? 1 - (v.distance / maxDist) : 0);
    }

    const merged: HybridSearchResult[] = [];
    for (const id of new Set([...bm25Map.keys(), ...vecMap.keys()])) {
      const bm25 = bm25Map.get(id);
      const sem = vecMap.get(id) ?? 0;
      const hybrid = (1 - alpha) * (bm25?.norm ?? 0) + alpha * sem;

      let chunk = bm25?.chunk ?? null;
      if (!chunk) {
        chunk = this._store.db.prepare(
          `SELECT c.*, f.path as file_path, f.language FROM chunks c JOIN files f ON c.file_id = f.id WHERE c.id = ?`
        ).get(id) as ChunkRow | undefined ?? null;
        if (!chunk) continue;
      }

      merged.push({ chunk, score: hybrid, bm25Score: bm25?.raw ?? 0, semanticScore: sem });
    }

    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, topK);
  }
}
