// sqlite-vec based vector storage and KNN search
// Stores chunk embeddings in SQLite and performs semantic similarity search
import sqliteVec from 'sqlite-vec';
import type { Store } from './store';
import type { Embedding } from './embedding';
import type { VectorSearchResult, EmbedResult } from '../types';

export class VectorStore {
  private readonly _store: Store;
  private readonly _embedding: Embedding;
  private _dimensions: number | null = null;
  private _initialized = false;

  constructor(store: Store, embedding: Embedding) {
    this._store = store;
    this._embedding = embedding;
  }

  /**
   * Load sqlite-vec extension + create vec0 table
   */
  async init(): Promise<boolean> {
    if (this._initialized) return true;

    try {
      // 1. Load sqlite-vec extension
      sqliteVec.load(this._store.db);

      // 2. Check embedding availability (detect dimensions)
      const available = await this._embedding.isAvailable();
      if (!available) {
        console.error('[vector-store] Ollama unavailable, vector search disabled');
        return false;
      }
      this._dimensions = this._embedding.dimensions;

      // 3. Create vec0 virtual table
      this._store.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks
        USING vec0(embedding float[${this._dimensions}])
      `);

      this._initialized = true;
      console.error(`[vector-store] Initialized: ${this._dimensions}D vectors`);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[vector-store] Init failed: ${message}`);
      return false;
    }
  }

  /** Whether the store is initialized and ready */
  get isReady(): boolean {
    return this._initialized;
  }

  /**
   * Embed only chunks that haven't been embedded yet
   */
  async embedNewChunks(): Promise<EmbedResult> {
    if (!this._initialized) return { embedded: 0, skipped: 0, errors: 0 };

    const unembedded = this._store.db.prepare(`
      SELECT c.id, c.content, c.name, c.chunk_type
      FROM chunks c
      LEFT JOIN vec_chunks vc ON vc.rowid = c.id
      WHERE vc.rowid IS NULL
    `).all() as Array<{ id: number; content: string; name: string | null; chunk_type: string }>;

    let embedded = 0;
    let errors = 0;

    const insertStmt = this._store.db.prepare(
      'INSERT INTO vec_chunks(rowid, embedding) VALUES (?, ?)'
    );

    for (const chunk of unembedded) {
      try {
        const text = this._buildEmbeddingText(chunk);
        const vector = await this._embedding.embed(text);
        if (vector.length === 0) { errors++; continue; }

        insertStmt.run(BigInt(chunk.id), new Float32Array(vector));
        embedded++;
      } catch {
        errors++;
      }
    }

    return { embedded, skipped: unembedded.length - embedded - errors, errors };
  }

  /**
   * KNN vector search (sqlite-vec fallback)
   */
  async search(query: string, topK = 10): Promise<VectorSearchResult[]> {
    if (!this._initialized) return [];

    const queryVector = await this._embedding.embed(query);
    if (queryVector.length === 0) return [];

    const rows = this._store.db.prepare(`
      SELECT rowid, distance
      FROM vec_chunks
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(new Float32Array(queryVector), topK) as Array<{ rowid: number | bigint; distance: number }>;

    return rows.map(r => ({
      chunkId: Number(r.rowid),
      distance: r.distance,
    }));
  }



  /**
   * Get count of embedded chunks
   */
  getEmbeddedCount(): number {
    if (!this._initialized) return 0;
    try {
      return (this._store.db.prepare('SELECT COUNT(*) as cnt FROM vec_chunks').get() as { cnt: number }).cnt;
    } catch {
      return 0;
    }
  }

  /**
   * Delete embeddings for specific chunk IDs (for re-indexing)
   */
  deleteByChunkIds(chunkIds: number[]): void {
    if (!this._initialized || chunkIds.length === 0) return;
    const del = this._store.db.prepare('DELETE FROM vec_chunks WHERE rowid = ?');
    const tx = this._store.db.transaction((ids: number[]) => {
      for (const id of ids) del.run(BigInt(id));
    });
    tx(chunkIds);
  }

  /**
   * Build text for embedding (chunk metadata + content)
   */
  private _buildEmbeddingText(chunk: { name: string | null; chunk_type: string; content: string }): string {
    const parts: string[] = [];
    if (chunk.name) parts.push(chunk.name);
    if (chunk.chunk_type) parts.push(`[${chunk.chunk_type}]`);
    parts.push(chunk.content);
    return parts.join(' ').slice(0, 2000);
  }
}
