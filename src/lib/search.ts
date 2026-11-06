// Owner-scoped lexical search with bounded native caches and a SQLite FTS fallback.
import type { Store } from './store';
import { embeddingSourceHash, type VectorStore } from './vector-store';
import type {
  ChunkRow,
  SearchResult,
  HybridSearchResult,
  SearchOptions,
  HybridSearchOptions,
  SearchConfig,
  VectorSearchResult,
} from '../types';
import { getNative, type NativeModule } from './native-bridge';
import { integer, text } from './store-values';

/** Lightweight row for Rust cache loading (no content/metadata) */
interface SearchDataRow {
  id: number;
  search_text: string | null;
}

/** Lightweight cache metadata (no ChunkRow[] in memory) */
interface CacheMeta {
  version: string;
  language?: string;
  count: number;
}

export class BM25Search {
  private readonly _store: Store;
  private readonly _k1: number;
  private readonly _b: number;
  private readonly _topK: number;
  private readonly cacheLimit: number;
  private useFts = false;
  private _vectorStore: VectorStore | null = null;
  private semanticError: string | null = null;
  getLastSemanticError(): string | null {
    return this.semanticError;
  }

  // ── Lightweight cache state ──────────────────────────────────────
  private _cacheMeta: CacheMeta | null = null;
  private _cacheVersion = 0;
  private nativeIndex: InstanceType<NativeModule['Bm25Index']> | null = null;

  constructor(store: Store, config: SearchConfig) {
    this._store = store;
    this._k1 = config.bm25?.k1 ?? 1.2;
    this._b = config.bm25?.b ?? 0.75;
    this._topK = integer(config.topK ?? 10, 'search limit', 10000);
    this.cacheLimit = integer(
      config.maxCacheBytes ?? 64 * 1048576,
      'search cache bytes',
      64 * 1048576,
    );
    if (
      !Number.isFinite(this._k1) ||
      this._k1 <= 0 ||
      this._k1 > 10 ||
      !Number.isFinite(this._b) ||
      this._b < 0 ||
      this._b > 1
    )
      throw new Error('Invalid BM25 score parameters');
  }

  /** Invalidate cache (call after indexing/re-indexing) */
  invalidateCache(): void {
    this._cacheVersion++;
    this._cacheMeta = null;
    this.nativeIndex = null;
  }

  /** Load one scope snapshot, using FTS when its text exceeds the cache budget. */
  warmCache(language?: string): number {
    try {
      return this._store.db.transaction(() => this.loadCache(language)).deferred();
    } catch (error) {
      this.invalidateCache();
      throw error;
    }
  }

  private loadCache(language?: string): number {
    const sizes = this._store.db
      .prepare(
        `SELECT count(*) AS count,COALESCE(SUM(length(CAST(c.search_text AS BLOB))),0) AS bytes
      FROM arachne_chunks c JOIN arachne_files f ON f.id=c.file_id WHERE f.project=? AND f.agent=? AND (? IS NULL OR f.language=?)`,
      )
      .get(this._store.project, this._store.agent, language ?? null, language ?? null) as {
      count: unknown;
      bytes: unknown;
    };
    const count = integer(sizes.count, 'search chunk count');
    this.useFts = integer(sizes.bytes, 'search text bytes') > this.cacheLimit;
    this.nativeIndex = null;
    this._cacheMeta = {
      version: `${this._store.revision}:${this._cacheVersion}`,
      language,
      count,
    };
    if (this.useFts) return count;
    const rows = this._loadSearchData(language);

    const chunkIds = new Array<number>(rows.length);
    const searchTexts = new Array<string>(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      chunkIds[i] = row.id;
      searchTexts[i] = row.search_text ?? '';
    }

    // Each native index owns its bounded search text.
    const native = getNative();
    if (native) this.nativeIndex = new native.Bm25Index(chunkIds, searchTexts);
    this._cacheMeta = {
      version: `${this._store.revision}:${this._cacheVersion}`,
      language,
      count: rows.length,
    };
    return rows.length;
  }

  /** Execute BM25 search */
  search(query: string, options: SearchOptions = {}): SearchResult[] {
    text(query, 'search query');
    if (query.length > 4096) throw new Error('Search query exceeds 4096 characters');
    if (!query.trim()) return [];
    const topK = integer(options.topK ?? this._topK, 'search limit', 10000);
    if (topK === 0) return [];
    const terms = this._tokenize(query);
    if (terms.length === 0) return [];

    return this._store.db
      .transaction(() => this.searchSnapshot(terms, topK, options.language))
      .deferred();
  }

  private searchSnapshot(terms: string[], topK: number, language?: string): SearchResult[] {
    // Ensure cache is warm
    this._ensureCache(language);
    if (this.useFts) return this.ftsSearch(terms, topK, language);

    if (this.nativeIndex) {
      const hits = this.nativeIndex.search(
        terms.join(' '),
        Math.min(10000, topK * 3),
        this._k1,
        this._b,
      );
      return this._lookupAndBoost(hits, terms, topK);
    }

    // ── Path 3: Pure TypeScript fallback ────────────────────────────
    const chunks = this._loadFullChunks(language);
    return this._searchTS(chunks, terms, topK);
  }

  private ftsSearch(terms: string[], topK: number, language?: string): SearchResult[] {
    const query = terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(' OR ');
    const hits = this._store.db
      .prepare(
        `SELECT c.id AS chunkId,-bm25(arachne_chunks_fts) AS score FROM arachne_chunks_fts
      JOIN arachne_chunks c ON c.id=arachne_chunks_fts.rowid JOIN arachne_files f ON f.id=c.file_id
      WHERE arachne_chunks_fts MATCH ? AND f.project=? AND f.agent=? AND (? IS NULL OR f.language=?)
      ORDER BY bm25(arachne_chunks_fts),c.id LIMIT ?`,
      )
      .all(
        query,
        this._store.project,
        this._store.agent,
        language ?? null,
        language ?? null,
        Math.min(10000, topK * 3),
      ) as Array<{ chunkId: number; score: number }>;
    return this._lookupAndBoost(hits, terms, topK);
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

    const scored: SearchResult[] = [];
    for (const hit of hits) {
      const chunk = this._store.getChunk(hit.chunkId);
      if (!chunk) continue;
      scored.push({
        chunk,
        score: this._applyBonuses(hit.score, chunk, terms),
      });
    }
    scored.sort((a, b) => b.score - a.score || a.chunk.id - b.chunk.id);
    return scored.slice(0, topK);
  }

  /** Ensure cache is warm for the given language filter */
  private _ensureCache(language?: string): void {
    if (
      this._cacheMeta &&
      this._cacheMeta.version === `${this._store.revision}:${this._cacheVersion}` &&
      this._cacheMeta.language === language
    ) {
      return; // Cache valid
    }
    this.warmCache(language);
  }

  /** Load only id + search_text (lightweight, no content/metadata) */
  private _loadSearchData(language?: string): SearchDataRow[] {
    return this._store.db
      .prepare(
        `SELECT c.id,c.search_text FROM arachne_chunks c JOIN arachne_files f ON f.id=c.file_id
      WHERE f.project=? AND f.agent=? AND (? IS NULL OR f.language=?) ORDER BY c.id`,
      )
      .all(this._store.project, this._store.agent, language ?? null, language ?? null)
      .map((value) => {
        const row = value as Record<string, unknown>;
        return {
          id: integer(row.id, 'search chunk ID'),
          search_text: row.search_text === null ? null : text(row.search_text, 'search text'),
        };
      });
  }

  /** Load checked chunks belonging to the current owner scope. */
  private _loadFullChunks(language?: string): ChunkRow[] {
    return this._store.allChunks(language);
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
    const avgDl =
      chunks.reduce((sum, c) => sum + (c.search_text ?? '').toLowerCase().length, 0) /
      Math.max(N, 1);

    const df = new Map<string, number>();
    for (const term of terms) {
      df.set(term, chunks.filter((c) => (c.search_text ?? '').toLowerCase().includes(term)).length);
    }

    const scored: SearchResult[] = [];
    for (const chunk of chunks) {
      const doc = (chunk.search_text ?? '').toLowerCase();
      const dl = doc.length;
      let score = 0;

      for (const term of terms) {
        const tf = this._countOccurrences(doc, term);
        if (tf === 0) continue;
        const termDf = df.get(term) ?? 0;
        const idf = Math.log((N - termDf + 0.5) / (termDf + 0.5) + 1);
        score +=
          (idf * (tf * (this._k1 + 1))) / (tf + this._k1 * (1 - this._b + this._b * (dl / avgDl)));
      }

      if (score > 0) {
        scored.push({ chunk, score });
      }
    }

    scored.sort((a, b) => b.score - a.score || a.chunk.id - b.chunk.id);
    const candidates = scored
      .slice(0, Math.min(10000, topK * 3))
      .map((result) => ({ chunkId: result.chunk.id, score: result.score }));
    return this._lookupAndBoost(candidates, terms, topK);
  }

  /** Tokenize text */
  private _tokenize(text: string): string[] {
    return [
      ...new Set(
        text
          .toLowerCase()
          .replace(/[^\p{L}\p{N}_\s]/gu, ' ')
          .split(/\s+/)
          .filter((term) => term.length >= 2),
      ),
    ];
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
  async hybridSearch(
    query: string,
    options: HybridSearchOptions = {},
  ): Promise<HybridSearchResult[]> {
    text(query, 'search query');
    const topK = integer(options.topK ?? 10, 'hybrid result limit', 10000);
    const alpha = options.alpha ?? 0.5;
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1)
      throw new Error('Hybrid weight must be between zero and one');
    this.semanticError = null;
    const keywordResults = () =>
      this.search(query, {
        topK: Math.min(10000, topK * 2),
        language: options.language,
      });
    const fallback = () =>
      keywordResults()
        .map((result) => ({
          chunk: result.chunk,
          score: result.score,
          bm25Score: result.score,
          semanticScore: 0,
        }))
        .slice(0, topK);
    if (!topK || !query.trim()) return [];
    if (!this._vectorStore?.isReady) {
      this.semanticError = this._vectorStore?.isInitializing
        ? 'Embedding service initialization is in progress'
        : (this._vectorStore?.getLastError() ?? null);
      return fallback();
    }
    try {
      const vectors = await this._vectorStore.search(
        query,
        Math.min(10000, topK * 2),
        options.language,
      );
      return this._store.db
        .transaction(() => this._mergeHybridResults(keywordResults(), vectors, alpha, topK))
        .deferred();
    } catch (error) {
      this.semanticError = (error as Error).message;
      return fallback();
    }
  }

  /** Normalize BM25 + vector scores and merge into hybrid results */
  private _mergeHybridResults(
    bm25Results: SearchResult[],
    vecResults: VectorSearchResult[],
    alpha: number,
    topK: number,
  ): HybridSearchResult[] {
    const maxBm25 = bm25Results.length > 0 ? bm25Results[0]!.score : 1;
    const bm25Map = new Map<number, { chunk: ChunkRow; norm: number; raw: number }>();
    for (const r of bm25Results) {
      bm25Map.set(r.chunk.id, {
        chunk: r.chunk,
        norm: maxBm25 > 0 ? r.score / maxBm25 : 0,
        raw: r.score,
      });
    }

    const vecMap = new Map<number, number>();
    for (const v of vecResults) {
      const current = this._store.getChunk(v.chunkId);
      if (!current || (v.sourceHash && embeddingSourceHash(current) !== v.sourceHash)) continue;
      vecMap.set(v.chunkId, Math.max(0, 1 - v.distance));
    }

    const merged: HybridSearchResult[] = [];
    for (const id of new Set([...bm25Map.keys(), ...vecMap.keys()])) {
      const bm25 = bm25Map.get(id);
      const sem = vecMap.get(id) ?? 0;
      const hybrid = (1 - alpha) * (bm25?.norm ?? 0) + alpha * sem;
      if (hybrid <= 0) continue;

      let chunk = bm25?.chunk ?? null;
      if (!chunk) {
        chunk = this._store.getChunk(id) ?? null;
        if (!chunk) continue;
      }

      merged.push({
        chunk,
        score: hybrid,
        bm25Score: bm25?.raw ?? 0,
        semanticScore: sem,
      });
    }

    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, topK);
  }
}
