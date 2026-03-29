// Project file scanner with incremental indexing
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { IgnoreFilter } from './ignore';
import { chunkCode, setTokenMultiplier } from './chunker';
import { indexFileDependencies } from './dependency';
import type { Store } from './store';
import type { ArachneConfig, IndexOptions, IndexResult, FileMeta, FileRow } from '../types';

export class Indexer {
  private readonly _store: Store;
  private readonly _config: ArachneConfig;
  private _ignoreFilter: IgnoreFilter | null = null;

  constructor(store: Store, config: ArachneConfig) {
    this._store = store;
    this._config = config;

    // Apply token multiplier from config
    if (config.indexing.tokenMultiplier) {
      setTokenMultiplier(config.indexing.tokenMultiplier);
    }
  }

  /**
   * Index project (incremental — only changed files)
   */
  async index(projectDir: string, options: IndexOptions = {}): Promise<IndexResult> {
    const startTime = Date.now();
    const scanDir = options.subPath
      ? path.resolve(projectDir, options.subPath)
      : projectDir;

    // Initialize ignore filter
    this._ignoreFilter = new IgnoreFilter(this._config.ignore, projectDir);

    // 1. Scan file list
    const files = await this._scanFiles(scanDir, projectDir);

    // Max file count check
    const maxFiles = this._config.indexing.maxFiles || 50000;
    if (files.length > maxFiles) {
      console.error(`[n2-context] Warning: ${files.length} files found, limiting to ${maxFiles}`);
      files.length = maxFiles;
    }

    // 2. Clear existing data for full re-indexing
    if (options.force) {
      this._store.db.exec('DELETE FROM chunks');
      this._store.db.exec('DELETE FROM files');
    }

    // 3. Incremental indexing
    let indexed = 0;
    let skipped = 0;

    for (const fileMeta of files) {
      if ((indexed + skipped) % 500 === 0 && (indexed + skipped) > 0) {
        await new Promise(r => setImmediate(r));
      }
      const result = this._indexFile(fileMeta, projectDir);
      if (result === 'indexed') indexed++;
      else skipped++;
    }

    // 4. Clean stale files
    const removed = this._store.cleanStaleFiles(projectDir);

    // 5. Update metadata
    this._store._setMeta('last_indexed_at', new Date().toISOString());
    this._store._setMeta('project_dir', projectDir);
    this._store._setMeta('file_count', String(indexed + skipped));

    const elapsed = Date.now() - startTime;
    return { indexed, skipped, removed, elapsed, total: files.length };
  }

  /**
   * Recursive directory scan
   */
  private async _scanFiles(dir: string, projectRoot: string): Promise<FileMeta[]> {
    const results: FileMeta[] = [];
    const maxFileSize = this._config.indexing.maxFileSize || 1024 * 1024;
    const supported = new Set([...(this._config.indexing.supportedLanguages || []), ...(this._config.indexing.alsoIndexAsText || [])]);
    let scannedCount = 0;

    const scan = async (currentDir: string): Promise<void> => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); } catch { return; }

      for (const entry of entries) {
        if (++scannedCount % 500 === 0) await new Promise(r => setImmediate(r));
        const fullPath = path.join(currentDir, entry.name);
        if (!this._ignoreFilter) continue;
        const rel = path.relative(projectRoot, fullPath);
        if (this._ignoreFilter.isIgnored(rel)) continue;

        if (entry.isDirectory()) {
          if (!this._ignoreFilter.isIgnored(rel + '/')) await scan(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).slice(1).toLowerCase();
          if (!supported.has(ext)) continue;
          try { 
            const stat = fs.statSync(fullPath); 
            if (stat.size > 0 && stat.size <= maxFileSize) results.push({ absolutePath: fullPath, relativePath: rel.replace(/\\/g, '/'), stat });
          } catch {}
        }
      }
    };
    await scan(dir);
    return results;
  }

  /**
   * Index individual file
   */
  private _indexFile(fileMeta: FileMeta, _projectDir: string): 'indexed' | 'skipped' {
    const { absolutePath, relativePath, stat } = fileMeta;

    let content: string;
    try {
      content = fs.readFileSync(absolutePath, 'utf-8');
    } catch {
      return 'skipped';
    }

    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    const ext = path.extname(absolutePath).slice(1).toLowerCase();
    const modifiedAt = stat.mtime.toISOString();

    const { action, fileId } = this._store.upsertFile(
      relativePath, hash, ext, stat.size, modifiedAt
    );

    if (action === 'skipped') return 'skipped';

    // Chunking
    const chunks = chunkCode(content, ext);

    if (chunks.length > 0) {
      this._store.insertChunks(fileId, chunks);
    }

    // Extract dependencies
    try {
      indexFileDependencies(this._store, fileId, content, ext, relativePath);
    } catch {
      // Dependency extraction failure is non-fatal
    }

    return 'indexed';
  }

  /** Get indexed file list */
  getFiles(options: { language?: string } = {}): FileRow[] {
    return this._store.getAllFiles(options.language);
  }

  /** Get index statistics */
  getStats() {
    return this._store.getStats();
  }
}
