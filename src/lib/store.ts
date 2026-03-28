// SQLite DB management (schema creation, migration, basic queries)
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import type {
  ChunkRecord, ChunkRow, FileRow, UpsertResult,
  DependencyRow, AccessLogRow, StoreStats, ResolvedDep,
} from '../types';

const SCHEMA_VERSION = 3;

const SCHEMA_SQL = `
-- Meta information (version, project path, etc.)
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- File index
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    hash TEXT NOT NULL,
    language TEXT,
    size_bytes INTEGER,
    chunk_count INTEGER DEFAULT 0,
    indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    modified_at DATETIME
);

-- Code chunks (function/class/block level)
CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    chunk_type TEXT NOT NULL,
    name TEXT,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    content TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    search_text TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Search indexes
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
`;

const SCHEMA_V2_SQL = `
-- Dependency graph (import/require relationships)
CREATE TABLE IF NOT EXISTS dependencies (
    source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    target_path TEXT NOT NULL,
    target_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
    dep_type TEXT DEFAULT 'import',
    PRIMARY KEY (source_file_id, target_path)
);

-- Access history (track frequently used files)
CREATE TABLE IF NOT EXISTS access_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    query TEXT,
    accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_deps_source ON dependencies(source_file_id);
CREATE INDEX IF NOT EXISTS idx_deps_target ON dependencies(target_file_id);
CREATE INDEX IF NOT EXISTS idx_access_file ON access_log(file_id);
CREATE INDEX IF NOT EXISTS idx_access_time ON access_log(accessed_at);
`;

const SCHEMA_V3_SQL = `
CREATE TABLE IF NOT EXISTS embeddings_meta (
    chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    model TEXT DEFAULT 'nomic-embed-text',
    dimensions INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export class Store {
  private readonly _dataDir: string;
  private readonly _dbPath: string;
  private readonly _backupDir: string;
  private _db: Database.Database | null = null;

  constructor(dataDir: string) {
    this._dataDir = dataDir;
    this._dbPath = path.join(dataDir, 'context.db');
    this._backupDir = path.join(dataDir, 'backups');
  }

  /** Initialize DB (create directories + apply schema) */
  async init(): Promise<void> {
    fs.mkdirSync(this._dataDir, { recursive: true });
    fs.mkdirSync(this._backupDir, { recursive: true });

    this._db = new Database(this._dbPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('foreign_keys = ON');
    this._db.exec(SCHEMA_SQL);
    this._migrate();
    this._setMeta('schema_version', String(SCHEMA_VERSION));
    this._setMeta('created_at', new Date().toISOString());
  }

  /** Migration (v1→v2→v3) */
  private _migrate(): void {
    const currentVersion = Number(this.getMeta('schema_version') ?? '1');
    if (currentVersion < 2) {
      this._getDb().exec(SCHEMA_V2_SQL);
    }
    if (currentVersion < 3) {
      this._getDb().exec(SCHEMA_V3_SQL);
    }
  }

  /** Safe DB accessor — throws if not initialized */
  private _getDb(): Database.Database {
    if (!this._db) throw new Error('Store not initialized. Call init() first.');
    return this._db;
  }

  /** DB instance */
  get db(): Database.Database { return this._getDb(); }

  /** DB file path */
  get dbPath(): string { return this._dbPath; }

  /** Backup directory */
  get backupDir(): string { return this._backupDir; }

  // ── Meta ──

  _setMeta(key: string, value: string): void {
    this._getDb().prepare(`
      INSERT INTO meta (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this._getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  // ── Files ──

  /**
   * File upsert (compare hash if exists, then update)
   */
  upsertFile(relativePath: string, hash: string, language: string, sizeBytes: number, modifiedAt: string): UpsertResult {
    const db = this._getDb();
    const existing = db.prepare('SELECT id, hash FROM files WHERE path = ?').get(relativePath) as { id: number; hash: string } | undefined;

    if (existing) {
      if (existing.hash === hash) {
        return { action: 'skipped', fileId: existing.id };
      }
      db.prepare('DELETE FROM chunks WHERE file_id = ?').run(existing.id);
      db.prepare(`
        UPDATE files SET hash = ?, language = ?, size_bytes = ?,
            chunk_count = 0, indexed_at = datetime('now'), modified_at = ?
        WHERE id = ?
      `).run(hash, language, sizeBytes, modifiedAt, existing.id);
      return { action: 'updated', fileId: existing.id };
    }

    const result = db.prepare(`
      INSERT INTO files (path, hash, language, size_bytes, modified_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(relativePath, hash, language, sizeBytes, modifiedAt);
    return { action: 'inserted', fileId: Number(result.lastInsertRowid) };
  }

  /** Insert chunks for a file */
  insertChunks(fileId: number, chunks: ChunkRecord[]): void {
    const db = this._getDb();
    const stmt = db.prepare(`
      INSERT INTO chunks (file_id, chunk_type, name, start_line, end_line, content, token_count, search_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((items: ChunkRecord[]) => {
      for (const c of items) {
        stmt.run(fileId, c.type, c.name, c.startLine, c.endLine, c.content, c.tokenCount, c.searchText);
      }
    });

    insertMany(chunks);
    db.prepare('UPDATE files SET chunk_count = ? WHERE id = ?').run(chunks.length, fileId);
  }

  /** Delete file (CASCADE deletes chunks) */
  removeFile(relativePath: string): Database.RunResult {
    return this._getDb().prepare('DELETE FROM files WHERE path = ?').run(relativePath);
  }

  /** Get file by path */
  getFileByPath(relativePath: string): FileRow | undefined {
    return this._getDb().prepare('SELECT * FROM files WHERE path = ?').get(relativePath) as FileRow | undefined;
  }

  /** Get all indexed files */
  getAllFiles(language?: string): FileRow[] {
    if (language) {
      return this._getDb().prepare('SELECT * FROM files WHERE language = ? ORDER BY path').all(language) as FileRow[];
    }
    return this._getDb().prepare('SELECT * FROM files ORDER BY path').all() as FileRow[];
  }

  /** Get chunks belonging to a file */
  getChunksByFileId(fileId: number): ChunkRow[] {
    return this._getDb().prepare('SELECT * FROM chunks WHERE file_id = ? ORDER BY start_line').all(fileId) as ChunkRow[];
  }

  // ── Search ──

  /** LIKE search in search_text (simple keyword search) */
  searchChunks(query: string, limit = 10): ChunkRow[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const conditions = terms.map(() => "LOWER(c.search_text) LIKE ?").join(' AND ');
    const params = terms.map(t => `%${t}%`);

    return this._getDb().prepare(`
      SELECT c.*, f.path as file_path, f.language
      FROM chunks c
      JOIN files f ON c.file_id = f.id
      WHERE ${conditions}
      ORDER BY c.token_count ASC
      LIMIT ?
    `).all(...params, limit) as ChunkRow[];
  }

  // ── Stats ──

  getStats(): StoreStats {
    const db = this._getDb();
    const fileCount = (db.prepare('SELECT COUNT(*) as cnt FROM files').get() as { cnt: number }).cnt;
    const chunkCount = (db.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number }).cnt;
    const totalTokens = (db.prepare('SELECT COALESCE(SUM(token_count), 0) as total FROM chunks').get() as { total: number }).total;
    const languages = db.prepare('SELECT language, COUNT(*) as cnt FROM files GROUP BY language ORDER BY cnt DESC').all() as Array<{ language: string | null; cnt: number }>;

    let dbSize = 0;
    try { dbSize = fs.statSync(this._dbPath).size; } catch { /* ignore */ }

    return {
      fileCount,
      chunkCount,
      totalTokens,
      languages,
      dbSizeBytes: dbSize,
      dbSizeMB: (dbSize / 1024 / 1024).toFixed(2),
      lastIndexed: this.getMeta('last_indexed_at'),
      schemaVersion: this.getMeta('schema_version'),
    };
  }

  // ── Stale file cleanup ──

  cleanStaleFiles(projectDir: string): number {
    const db = this._getDb();
    const allFiles = db.prepare('SELECT id, path FROM files').all() as Array<{ id: number; path: string }>;
    let removed = 0;

    const deleteStmt = db.prepare('DELETE FROM files WHERE id = ?');
    const cleanTransaction = db.transaction((files: Array<{ id: number; path: string }>) => {
      for (const f of files) {
        const fullPath = path.join(projectDir, f.path);
        if (!fs.existsSync(fullPath)) {
          deleteStmt.run(f.id);
          removed++;
        }
      }
    });

    cleanTransaction(allFiles);
    return removed;
  }

  // ── Dependencies ──

  insertDependencies(fileId: number, deps: ResolvedDep[]): void {
    const db = this._getDb();
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO dependencies (source_file_id, target_path, target_file_id, dep_type)
      VALUES (?, ?, ?, ?)
    `);
    const insertMany = db.transaction((items: ResolvedDep[]) => {
      for (const d of items) {
        stmt.run(fileId, d.targetPath, d.targetFileId ?? null, d.depType || 'import');
      }
    });
    insertMany(deps);
  }

  clearDependencies(fileId: number): void {
    this._getDb().prepare('DELETE FROM dependencies WHERE source_file_id = ?').run(fileId);
  }

  getDirectDependencies(fileId: number): DependencyRow[] {
    return this._getDb().prepare(`
      SELECT d.*, f.path as target_resolved_path
      FROM dependencies d
      LEFT JOIN files f ON d.target_file_id = f.id
      WHERE d.source_file_id = ?
    `).all(fileId) as DependencyRow[];
  }

  /** Recursive dependency traversal (depth-limited BFS) */
  getTransitiveDependencies(fileId: number, maxDepth = 2): Array<DependencyRow & { depth: number }> {
    const visited = new Set<number>();
    const result: Array<DependencyRow & { depth: number }> = [];
    const queue: Array<{ fileId: number; depth: number }> = [{ fileId, depth: 0 }];

    while (queue.length > 0) {
      const item = queue.shift()!;
      if (visited.has(item.fileId) || item.depth >= maxDepth) continue;
      visited.add(item.fileId);

      const deps = this.getDirectDependencies(item.fileId);
      for (const dep of deps) {
        result.push({ ...dep, depth: item.depth + 1 });
        if (dep.target_file_id && !visited.has(dep.target_file_id)) {
          queue.push({ fileId: dep.target_file_id, depth: item.depth + 1 });
        }
      }
    }
    return result;
  }

  getReverseDependencies(fileId: number): DependencyRow[] {
    return this._getDb().prepare(`
      SELECT d.*, f.path as source_path
      FROM dependencies d
      JOIN files f ON d.source_file_id = f.id
      WHERE d.target_file_id = ?
    `).all(fileId) as DependencyRow[];
  }

  // ── Access Log ──

  logAccess(fileId: number, query: string | null): void {
    this._getDb().prepare(`
      INSERT INTO access_log (file_id, query) VALUES (?, ?)
    `).run(fileId, query ?? null);
  }

  getRecentFiles(limit = 10): AccessLogRow[] {
    return this._getDb().prepare(`
      SELECT DISTINCT a.file_id, f.path, MAX(a.accessed_at) as last_access
      FROM access_log a
      JOIN files f ON a.file_id = f.id
      GROUP BY a.file_id
      ORDER BY last_access DESC
      LIMIT ?
    `).all(limit) as AccessLogRow[];
  }

  getMostAccessedFiles(limit = 5): AccessLogRow[] {
    return this._getDb().prepare(`
      SELECT a.file_id, f.path, COUNT(*) as access_count
      FROM access_log a
      JOIN files f ON a.file_id = f.id
      GROUP BY a.file_id
      ORDER BY access_count DESC
      LIMIT ?
    `).all(limit) as AccessLogRow[];
  }

  getChunksByFileIds(fileIds: number[]): ChunkRow[] {
    if (!fileIds || fileIds.length === 0) return [];
    const placeholders = fileIds.map(() => '?').join(',');
    return this._getDb().prepare(`
      SELECT c.*, f.path as file_path, f.language
      FROM chunks c
      JOIN files f ON c.file_id = f.id
      WHERE c.file_id IN (${placeholders})
      ORDER BY c.file_id, c.start_line
    `).all(...fileIds) as ChunkRow[];
  }

  cleanAccessLog(maxAgeDays = 30): number {
    const result = this._getDb().prepare(`
      DELETE FROM access_log
      WHERE accessed_at < datetime('now', '-' || ? || ' days')
    `).run(maxAgeDays);
    return result.changes;
  }

  /** Close DB connection */
  close(): void {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }
}
