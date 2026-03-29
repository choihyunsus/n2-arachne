// Ollama embedding engine (adapted from QLN embedding.js)
// Generates vectors via local Ollama nomic-embed-text, graceful degradation if unavailable
import http from 'http';
import type { EmbeddingConfig, OllamaEmbeddingResponse } from '../types';

export class Embedding {
  readonly model: string;
  readonly endpoint: string;
  dimensions: number | null = null;
  private _available: boolean | null = null;

  constructor(config: Partial<EmbeddingConfig> = {}) {
    this.model = config.model ?? 'nomic-embed-text';
    this.endpoint = config.endpoint ?? 'http://127.0.0.1:11434';
  }

  /**
   * Check Ollama availability (cached, checked once)
   */
  async isAvailable(): Promise<boolean> {
    if (this._available !== null) return this._available;
    try {
      const vec = await this.embed('test');
      this._available = vec.length > 0;
      this.dimensions = vec.length;
      return this._available;
    } catch {
      this._available = false;
      return false;
    }
  }

  /** Reset availability cache (for reconnection attempts) */
  resetAvailability(): void {
    this._available = null;
    this.dimensions = null;
  }

  /**
   * Generate vector embedding from text
   */
  async embed(text: string): Promise<number[]> {
    if (!text || text.trim().length === 0) return [];
    const input = text.length > 2000 ? text.slice(0, 2000) : text;

    for (const apiPath of ['/api/embeddings', '/api/embed']) {
      try {
        const body = apiPath === '/api/embeddings'
          ? { model: this.model, prompt: input }
          : { model: this.model, input: input };
        const result = await this._post(apiPath, body) as OllamaEmbeddingResponse;

        if (result.embedding && Array.isArray(result.embedding)) {
          this.dimensions = result.embedding.length;
          return result.embedding;
        }
        if (result.embeddings && Array.isArray(result.embeddings) && result.embeddings[0]) {
          this.dimensions = result.embeddings[0].length;
          return result.embeddings[0];
        }
      } catch { continue; }
    }
    return [];
  }

  /**
   * Batch embedding generation
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }

  /**
   * Cosine similarity calculation
   */
  cosineSimilarity(a: number[], b: number[]): number {
    if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  /** HTTP POST to Ollama API */
  private _post(apiPath: string, body: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.endpoint);
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || 11434,
        path: apiPath,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      };
      const req = http.request(options, res => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`Ollama ${res.statusCode ?? 'unknown'}: ${data.slice(0, 200)}`));
            return;
          }
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Invalid JSON: ${data.slice(0, 100)}`)); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(JSON.stringify(body));
      req.end();
    });
  }
}
