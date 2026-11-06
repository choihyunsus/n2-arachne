// Bounded Ollama embedding requests with retryable availability and checked vector spaces.
import type { EmbeddingConfig, OllamaEmbeddingResponse } from '../types';
import { httpUrl, readResponseText } from './http';
import { vectorValues, cosine } from './vectors';

export class Embedding {
  readonly model: string;
  readonly endpoint: string;
  dimensions: number | null = null;
  private available: boolean | null = null;
  private checkedAt = 0;
  private lastError: string | null = null;
  private readonly timeout: number;
  private readonly apiKey?: string;

  constructor(config: Partial<EmbeddingConfig> = {}) {
    if (config.provider && config.provider !== 'ollama')
      throw new Error('Configure the supported Ollama embedding provider');
    this.model = config.model ?? 'nomic-embed-text';
    this.endpoint = httpUrl(config.endpoint ?? 'http://127.0.0.1:11434').toString();
    this.timeout = config.timeoutMs ?? 10000;
    this.apiKey = config.apiKey;
    if (
      !this.model.trim() ||
      this.model.length > 512 ||
      !Number.isSafeInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 60000
    )
      throw new Error('Invalid embedding configuration');
  }

  getLastError(): string | null {
    return this.lastError;
  }

  async isAvailable(): Promise<boolean> {
    if (this.available !== null && Date.now() - this.checkedAt < 30000) return this.available;
    try {
      await this.embed('availability probe');
      return true;
    } catch {
      return false;
    }
  }

  resetAvailability(): void {
    this.available = null;
    this.dimensions = null;
    this.checkedAt = 0;
  }

  async embed(text: string): Promise<number[]> {
    if (typeof text !== 'string' || text.length > 65536)
      throw new Error('Embedding input exceeds 65536 characters');
    if (!text.trim()) return [];
    try {
      const data = await this.request(text);
      const vector = vectorValues(data.embedding ?? data.embeddings?.[0]);
      const model = (data as OllamaEmbeddingResponse & { model?: unknown }).model;
      if (
        model !== undefined &&
        (typeof model !== 'string' ||
          model.replace(/:latest$/, '') !== this.model.replace(/:latest$/, ''))
      )
        throw new Error('Embedding response model differs from the configured model');
      if (this.dimensions !== null && this.dimensions !== vector.length)
        throw new Error('Embedding model changed its vector dimensions');
      this.dimensions = vector.length;
      this.available = true;
      this.lastError = null;
      this.checkedAt = Date.now();
      return vector;
    } catch (error) {
      this.available = false;
      this.dimensions = null;
      this.checkedAt = Date.now();
      this.lastError = (error as Error).message;
      throw error;
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!Array.isArray(texts) || texts.length > 256)
      throw new Error('Embedding batch must contain at most 256 texts');
    const vectors: number[][] = [];
    for (const text of texts) vectors.push(await this.embed(text));
    return vectors;
  }

  cosineSimilarity(left: number[], right: number[]): number {
    if (!left?.length || !right?.length || left.length !== right.length) return 0;
    return cosine(vectorValues(left), vectorValues(right));
  }

  private async request(input: string): Promise<OllamaEmbeddingResponse> {
    const signal = AbortSignal.timeout(this.timeout);
    let response = await this.post(
      'embed',
      {
        model: this.model,
        input,
        truncate: false,
      },
      signal,
    );
    if ([404, 405].includes(response.status)) {
      void response.body?.cancel().catch(() => undefined);
      response = await this.post(
        'embeddings',
        {
          model: this.model,
          prompt: input,
        },
        signal,
      );
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(`Embedding service returned HTTP ${response.status}`);
    }
    const data: unknown = JSON.parse(await readResponseText(response, 4 * 1048576, signal));
    if (!data || typeof data !== 'object') throw new Error('Invalid embedding response');
    return data as OllamaEmbeddingResponse;
  }

  private post(action: string, body: object, signal: AbortSignal): Promise<Response> {
    const endpoint = httpUrl(this.endpoint);
    const base = endpoint.pathname.replace(/\/+$/, '');
    endpoint.pathname = `${base.endsWith('/api') ? base : base + '/api'}/${action}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
      signal,
    });
  }
}
