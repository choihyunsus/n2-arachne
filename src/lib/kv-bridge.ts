// Scope-aware session history in the common Soul SQLite database.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Store } from './store';
import type { ArachneKVData, SearchHistoryEntry, KVBridgeConfig } from '../types';
import { integer, text } from './store-values';
import { historyEntry, MAX_SESSION_BYTES, mergeHistory, readSession } from './session-values';

const DEFAULT_CONFIG: KVBridgeConfig = {
  enabled: true,
  maxSearchHistory: 100,
  maxHotFiles: 30,
  autoSaveOnExit: true,
};

export class KVBridge {
  private readonly config: KVBridgeConfig;
  private readonly legacyPath: string;
  private pending: SearchHistoryEntry[] = [];
  private history: SearchHistoryEntry[] = [];
  private lastError: string | null = null;

  constructor(
    private readonly store: Store,
    dataDir: string,
    projectDir: string,
    config?: Partial<KVBridgeConfig>,
  ) {
    if (fs.realpathSync(path.resolve(projectDir)) !== store.projectRoot)
      throw new Error('Session project root differs from the Store');
    this.config = { ...DEFAULT_CONFIG, ...config };
    integer(this.config.maxSearchHistory, 'search history limit', 1000);
    integer(this.config.maxHotFiles, 'hot file limit', 10000);
    this.legacyPath = path.resolve(dataDir, 'arachne-kv.json');
  }

  recordSearch(query: string, resultCount: number): void {
    if (!this.isEnabled || !text(query, 'search history query').trim()) return;
    const entry = historyEntry({
      id: randomUUID(),
      query,
      resultCount,
      timestamp: new Date().toISOString(),
    });
    this.pending = mergeHistory(this.pending, [entry], this.config.maxSearchHistory);
    this.history = mergeHistory(this.history, [entry], this.config.maxSearchHistory);
    this.save();
  }

  getSearchHistory(): SearchHistoryEntry[] {
    return this.history.map((entry) => ({ ...entry }));
  }

  getRecentQueries(limit = 10): string[] {
    integer(limit, 'recent query limit', 1000);
    const seen = new Set<string>();
    const result: string[] = [];
    for (const entry of [...this.history].reverse()) {
      if (result.length === limit) break;
      const key = entry.query.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(entry.query);
    }
    return result;
  }

  exportState(): ArachneKVData {
    const stats = this.store.getStats();
    return {
      version: '5.0.0',
      lastSavedAt: new Date().toISOString(),
      projectDir: this.store.projectRoot,
      project: this.store.project,
      agent: this.store.agent,
      fileCount: stats.fileCount,
      chunkCount: stats.chunkCount,
      totalTokens: stats.totalTokens,
      hotFiles: this.store.getMostAccessedFiles(this.config.maxHotFiles).map((file) => file.path),
      searchHistory: this.getSearchHistory(),
    };
  }

  /** Retain pending events on failure so the caller can retry with the same IDs. */
  save(): boolean {
    if (!this.isEnabled) return false;
    try {
      const state = this.store.db
        .transaction(() => {
          const existing = this.readCurrent() ?? this.readLegacy();
          const state = this.exportState();
          state.searchHistory = mergeHistory(
            existing?.searchHistory ?? [],
            this.pending,
            this.config.maxSearchHistory,
          );
          this.write(state);
          return state;
        })
        .immediate();
      this.history = state.searchHistory;
      this.pending = [];
      this.lastError = null;
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  load(): ArachneKVData | null {
    if (!this.isEnabled) return null;
    try {
      const state = this.store.db
        .transaction(() => {
          const existing = this.readCurrent();
          if (existing) return existing;
          const legacy = this.readLegacy();
          if (legacy) this.write({ ...legacy, version: '5.0.0' });
          return legacy;
        })
        .immediate();
      this.history = mergeHistory(
        state?.searchHistory ?? [],
        this.pending,
        this.config.maxSearchHistory,
      );
      this.lastError = null;
      return state ? { ...state, searchHistory: this.getSearchHistory() } : null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  get kvPath(): string {
    return this.store.dbPath;
  }
  get isEnabled(): boolean {
    return this.config.enabled;
  }
  getLastError(): string | null {
    return this.lastError;
  }

  private readCurrent(): ArachneKVData | null {
    const row = this.store.db
      .prepare('SELECT payload_json FROM arachne_sessions WHERE project=? AND agent=?')
      .get(this.store.project, this.store.agent) as { payload_json: string } | undefined;
    return row ? readSession(row.payload_json, this.store) : null;
  }

  private write(state: ArachneKVData): void {
    const payload = JSON.stringify(state);
    if (Buffer.byteLength(payload) > MAX_SESSION_BYTES)
      throw new Error('Session data exceeds 8 MiB');
    this.store.db
      .prepare(
        `INSERT INTO arachne_sessions(project,agent,payload_json) VALUES(?,?,?) ON CONFLICT(project,agent) DO UPDATE SET payload_json=excluded.payload_json,updated_at=datetime('now')`,
      )
      .run(this.store.project, this.store.agent, payload);
  }

  private readLegacy(): ArachneKVData | null {
    if (!fs.existsSync(this.legacyPath)) return null;
    const filename = fs.realpathSync(this.legacyPath);
    for (const source of [filename, path.resolve(this.store.legacyPath)]) {
      const receipt = this.store.db
        .prepare('SELECT project,agent FROM arachne_legacy_imports WHERE source_path=?')
        .get(source) as { project: string; agent: string } | undefined;
      if (receipt) {
        if (
          receipt.project !== this.store.project ||
          receipt.agent !== this.store.agent ||
          source === filename
        )
          return null;
      }
    }
    const fd = fs.openSync(filename, 'r');
    let raw: string;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_SESSION_BYTES)
        throw new Error('Legacy session file exceeds 8 MiB');
      const buffer = Buffer.alloc(stat.size + 1);
      let offset = 0;
      let count: number;
      while ((count = fs.readSync(fd, buffer, offset, buffer.length - offset, null)) > 0)
        offset += count;
      if (offset > stat.size) throw new Error('Legacy session changed during read');
      raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
    } finally {
      fs.closeSync(fd);
    }
    const state = readSession(raw, this.store, true);
    this.store.db
      .prepare('INSERT INTO arachne_legacy_imports(source_path,project,agent) VALUES(?,?,?)')
      .run(filename, this.store.project, this.store.agent);
    return { ...state, version: '5.0.0' };
  }
}
