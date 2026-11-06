// Portable scoped vector storage, restart-safe embedding batches and cosine search.
import { createHash } from 'node:crypto';
import type { Store } from './store';
import type { Embedding } from './embedding';
import type { VectorSearchResult, EmbedResult } from '../types';
import { integer, optionalText, text } from './store-values';
import { encodeVector, decodeVector, cosine } from './vectors';

interface Candidate {
  id: number;
  input: string;
  sourceHash: string;
}
interface Plan {
  candidates: Candidate[];
  pending: number;
  valid: number;
}
const INPUT_COLUMNS = 'c.id,c.name,c.chunk_type,substr(c.content,1,65537) AS content';

export class VectorStore {
  private initialized = false;
  private dimensions: number | null = null;
  private lastError: string | null = null;
  private initialization: Promise<boolean> | null = null;
  private embeddingRunning = false;

  constructor(
    private readonly store: Store,
    private readonly embedding: Embedding,
  ) {}
  get isReady(): boolean {
    return this.initialized;
  }
  get isInitializing(): boolean {
    return this.initialization !== null;
  }
  get isEmbedding(): boolean {
    return this.embeddingRunning;
  }
  getLastError(): string | null {
    return this.lastError ?? this.embedding.getLastError();
  }

  async init(force = false): Promise<boolean> {
    if (this.initialization) return this.initialization;
    if (this.initialized && !force) return true;
    const initialization = this.initialize(force);
    this.initialization = initialization;
    try {
      return await initialization;
    } finally {
      if (this.initialization === initialization) this.initialization = null;
    }
  }

  private async initialize(force: boolean): Promise<boolean> {
    if (force) this.embedding.resetAvailability();
    this.initialized = await this.embedding.isAvailable();
    this.dimensions = this.embedding.dimensions;
    this.lastError = this.initialized ? null : this.embedding.getLastError();
    return this.initialized;
  }

  async embedNewChunks(limit = 64): Promise<EmbedResult> {
    integer(limit, 'embedding batch limit', 256);
    if (!limit) throw new Error('Embedding batch limit must be positive');
    if (this.embeddingRunning) throw new Error('An embedding batch is already running');
    this.embeddingRunning = true;
    try {
      return await this.runEmbeddingBatch(limit);
    } finally {
      this.embeddingRunning = false;
    }
  }

  private async runEmbeddingBatch(limit: number): Promise<EmbedResult> {
    if (!(await this.init(true)))
      throw new Error(this.getLastError() ?? 'Embedding service is unavailable');
    const plan = this.plan(limit);
    const result: EmbedResult = {
      embedded: 0,
      skipped: plan.valid,
      errors: 0,
      remaining: plan.pending,
      complete: false,
    };
    const deadline = Date.now() + 20000;
    for (const candidate of plan.candidates) {
      if (Date.now() > deadline) break;
      try {
        const values = await this.embedding.embed(candidate.input);
        const written = this.storeEmbedding(candidate, values);
        if (written) result.embedded++;
      } catch (error) {
        result.errors++;
        this.lastError = (error as Error).message;
        result.lastError = this.lastError;
        this.initialized = false;
        break;
      }
    }
    result.remaining = this.plan(0).pending;
    result.complete = result.remaining === 0 && result.errors === 0;
    return result;
  }

  private storeEmbedding(candidate: Candidate, values: number[]): boolean {
    return this.store.db
      .transaction(() => {
        const current = this.store.getChunk(candidate.id);
        if (!current || sourceHash(embeddingText(current)) !== candidate.sourceHash) return false;
        this.store.db
          .prepare(
            `INSERT INTO arachne_embeddings(chunk_id,model,dimensions,vector,source_hash) VALUES(?,?,?,?,?)
            ON CONFLICT(chunk_id,model) DO UPDATE SET dimensions=excluded.dimensions,vector=excluded.vector,
            source_hash=excluded.source_hash,created_at=datetime('now')`,
          )
          .run(
            candidate.id,
            this.embedding.model,
            values.length,
            encodeVector(values),
            candidate.sourceHash,
          );
        return true;
      })
      .immediate();
  }

  async search(query: string, topK = 10, language?: string): Promise<VectorSearchResult[]> {
    integer(topK, 'vector result limit', 10000);
    text(query, 'vector query');
    if (query.length > 4096) throw new Error('Vector query exceeds 4096 characters');
    if (!topK || !query.trim()) return [];
    if (!this.initialized && !(await this.init(true)))
      throw new Error(this.getLastError() ?? 'Embedding service is unavailable');
    let vector: number[];
    try {
      vector = await this.embedding.embed(query);
    } catch (error) {
      this.initialized = false;
      this.lastError = (error as Error).message;
      throw error;
    }
    return this.store.db.transaction(() => this.searchSnapshot(vector, topK, language)).deferred();
  }

  private searchSnapshot(vector: number[], topK: number, language?: string): VectorSearchResult[] {
    const rows = this.store.db
      .prepare(
        `SELECT ${INPUT_COLUMNS},e.vector,e.source_hash FROM arachne_embeddings e
    JOIN arachne_chunks c ON c.id=e.chunk_id JOIN arachne_files f ON f.id=c.file_id
    WHERE f.project=? AND f.agent=? AND e.model=? AND e.dimensions=? AND (? IS NULL OR f.language=?) ORDER BY c.id`,
      )
      .iterate(
        this.store.project,
        this.store.agent,
        this.embedding.model,
        vector.length,
        language ?? null,
        language ?? null,
      );
    const results: VectorSearchResult[] = [];
    const deadline = Date.now() + 30000;
    for (const value of rows) {
      if (Date.now() > deadline) throw new Error('Vector search time budget exceeded');
      const row = value as Record<string, unknown>;
      if (text(row.source_hash, 'vector source hash') !== sourceHash(embeddingText(row))) continue;
      const stored = decodeVector(row.vector, vector.length);
      results.push({
        chunkId: integer(row.id, 'vector chunk ID'),
        distance: 1 - cosine(vector, stored),
        sourceHash: text(row.source_hash, 'vector source hash'),
      });
      if (results.length >= Math.max(512, topK * 2)) {
        results.sort(
          (left, right) => left.distance - right.distance || left.chunkId - right.chunkId,
        );
        results.length = topK;
      }
    }
    return results
      .sort((left, right) => left.distance - right.distance || left.chunkId - right.chunkId)
      .slice(0, topK);
  }

  getEmbeddedCount(): number {
    const row = this.store.db
      .prepare(
        `SELECT count(*) AS count FROM arachne_embeddings e JOIN arachne_chunks c ON c.id=e.chunk_id
      JOIN arachne_files f ON f.id=c.file_id WHERE f.project=? AND f.agent=? AND e.model=?`,
      )
      .get(this.store.project, this.store.agent, this.embedding.model) as {
      count: unknown;
    };
    return integer(row.count, 'stored vector count');
  }

  deleteByChunkIds(ids: number[]): void {
    if (!Array.isArray(ids) || ids.length > 10000) throw new Error('Invalid vector deletion batch');
    this.store.db
      .transaction(() => {
        for (const id of ids) {
          integer(id, 'chunk ID');
          if (!this.store.getChunk(id))
            throw new Error('Chunk does not belong to this project and agent');
          this.store.db
            .prepare('DELETE FROM arachne_embeddings WHERE chunk_id=? AND model=?')
            .run(id, this.embedding.model);
        }
      })
      .immediate();
  }

  private plan(limit: number): Plan {
    return this.store.db
      .transaction(() => {
        const plan: Plan = { candidates: [], pending: 0, valid: 0 };
        const rows = this.store.db
          .prepare(
            `SELECT ${INPUT_COLUMNS},e.model,e.dimensions,e.vector,e.source_hash FROM arachne_chunks c
        JOIN arachne_files f ON f.id=c.file_id LEFT JOIN arachne_embeddings e ON e.chunk_id=c.id AND e.model=?
        WHERE f.project=? AND f.agent=? ORDER BY c.id`,
          )
          .iterate(this.embedding.model, this.store.project, this.store.agent);
        for (const value of rows) {
          const row = value as Record<string, unknown>;
          const input = embeddingText(row),
            hash = sourceHash(input);
          if (this.validStored(row, hash)) {
            plan.valid++;
            continue;
          }
          plan.pending++;
          if (plan.candidates.length < limit)
            plan.candidates.push({
              id: integer(row.id, 'chunk ID'),
              input,
              sourceHash: hash,
            });
        }
        return plan;
      })
      .deferred();
  }

  private validStored(row: Record<string, unknown>, hash: string): boolean {
    if (row.model === null) return false;
    const dimensions = integer(row.dimensions, 'stored vector dimensions', 8192);
    if (dimensions < 1) throw new Error('Stored vector dimensions must be positive');
    const source = text(row.source_hash, 'stored vector source hash');
    if (dimensions !== this.dimensions || source !== hash) return false;
    try {
      decodeVector(row.vector, dimensions);
      return true;
    } catch {
      return false;
    }
  }
}

function embeddingText(row: { name?: unknown; chunk_type?: unknown; content?: unknown }): string {
  const name = optionalText(row.name, 'embedding chunk name');
  const kind = text(row.chunk_type, 'embedding chunk type');
  const input = `${name ?? ''} [${kind}] ${text(row.content, 'embedding content')}`.trim();
  if (input.length > 65536)
    throw new Error(
      'Legacy chunk exceeds the embedding input limit. Re-index the source to create bounded chunks.',
    );
  return input;
}
function sourceHash(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function embeddingSourceHash(chunk: {
  name?: unknown;
  chunk_type?: unknown;
  content?: unknown;
}): string {
  return sourceHash(embeddingText(chunk));
}
