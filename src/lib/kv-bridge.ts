// KV-Cache bridge for cross-session memory persistence
// Saves/restores Arachne indexing state, search history, and hot file tracking
import * as fs from 'fs';
import * as path from 'path';
import type { Store } from './store';
import type {
  ArachneKVData,
  SearchHistoryEntry,
  KVBridgeConfig,
  AccessLogRow,
} from '../types';

/** Default KV-Cache configuration */
const DEFAULT_CONFIG: KVBridgeConfig = {
  enabled: true,
  maxSearchHistory: 100,
  maxHotFiles: 30,
  autoSaveOnExit: true,
};

/**
 * KVBridge — Optional persistence layer for Arachne session state.
 * Saves search history, hot file access patterns, and indexing metadata
 * to a local JSON file. Soul can consume this for cross-session memory.
 */
export class KVBridge {
  private readonly _store: Store;
  private readonly _config: KVBridgeConfig;
  private readonly _kvPath: string;
  private readonly _projectDir: string;
  private _searchHistory: SearchHistoryEntry[] = [];

  constructor(store: Store, dataDir: string, projectDir: string, config?: Partial<KVBridgeConfig>) {
    this._store = store;
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._kvPath = path.join(dataDir, 'arachne-kv.json');
    this._projectDir = projectDir;
  }

  /** Record a search or assemble query for session history */
  recordSearch(query: string, resultCount: number): void {
    if (!query || query.trim().length === 0) return;

    this._searchHistory.push({
      query: query.trim(),
      timestamp: new Date().toISOString(),
      resultCount,
    });

    // Cap to max history size
    if (this._searchHistory.length > this._config.maxSearchHistory) {
      this._searchHistory = this._searchHistory.slice(-this._config.maxSearchHistory);
    }
  }

  /** Get search history (copy) */
  getSearchHistory(): SearchHistoryEntry[] {
    return [...this._searchHistory];
  }

  /** Get recent unique queries (for context recall) */
  getRecentQueries(limit = 10): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (let i = this._searchHistory.length - 1; i >= 0 && result.length < limit; i--) {
      const entry = this._searchHistory[i];
      if (!entry) continue;
      const normalized = entry.query.toLowerCase().trim();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        result.push(entry.query);
      }
    }

    return result;
  }

  /** Export current state as a serializable object */
  exportState(): ArachneKVData {
    const stats = this._store.getStats();
    const hotFiles = this._getHotFiles();

    return {
      version: '4.0.0',
      lastSavedAt: new Date().toISOString(),
      projectDir: this._projectDir,
      fileCount: stats.fileCount,
      chunkCount: stats.chunkCount,
      totalTokens: stats.totalTokens,
      hotFiles,
      searchHistory: this.getSearchHistory(),
    };
  }

  /** Save state to disk (non-fatal on error) */
  save(): boolean {
    try {
      const state = this.exportState();
      const dir = path.dirname(this._kvPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this._kvPath, JSON.stringify(state, null, 2), 'utf-8');
      return true;
    } catch {
      // KV save failure is non-fatal — server continues running
      return false;
    }
  }

  /** Load state from disk (non-fatal on error) */
  load(): ArachneKVData | null {
    try {
      if (!fs.existsSync(this._kvPath)) return null;
      const raw = fs.readFileSync(this._kvPath, 'utf-8');
      const data = JSON.parse(raw) as Partial<ArachneKVData>;

      // Validate version compatibility
      if (!data.version || !data.lastSavedAt) return null;

      // Restore search history
      if (Array.isArray(data.searchHistory)) {
        this._searchHistory = data.searchHistory
          .filter((e): e is SearchHistoryEntry =>
            typeof e === 'object' && e !== null &&
            typeof e.query === 'string' &&
            typeof e.timestamp === 'string' &&
            typeof e.resultCount === 'number'
          )
          .slice(-this._config.maxSearchHistory);
      }

      return data as ArachneKVData;
    } catch {
      // Corrupted KV file — start fresh, non-fatal
      return null;
    }
  }

  /** Get file path of KV data */
  get kvPath(): string {
    return this._kvPath;
  }

  /** Whether KV bridge is enabled */
  get isEnabled(): boolean {
    return this._config.enabled;
  }

  /** Get hot files (most frequently accessed) from Store access log */
  private _getHotFiles(): string[] {
    try {
      const files: AccessLogRow[] = this._store.getMostAccessedFiles(this._config.maxHotFiles);
      return files.map(f => f.path).filter((p): p is string => typeof p === 'string');
    } catch {
      return [];
    }
  }
}
