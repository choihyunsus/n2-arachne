// Scoped SQLite access for Arachne in the distribution Soul database.
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { initializeSchema, ARACHNE_SCHEMA_VERSION } from './schema';
import { importLegacy, type LegacyImportResult } from './legacy-import';
import {
  integer,
  text,
  relativePath,
  scopeName,
  fileRow,
  chunkRow,
  validateChunk,
  dependencyRow,
  accessRow,
} from './store-values';
import type {
  ChunkRecord,
  ChunkRow,
  FileRow,
  UpsertResult,
  DependencyRow,
  AccessLogRow,
  StoreStats,
  ResolvedDep,
} from '../types';

export interface StoreOptions {
  dbPath?: string;
  project?: string;
  agent?: string;
  projectRoot?: string;
  importLegacy?: boolean;
}
const CHUNKS =
  'SELECT c.*,f.path AS file_path,f.language FROM arachne_chunks c JOIN arachne_files f ON f.id=c.file_id';
const MAX_QUERY_ITEMS = 10_000;
const FILES =
  'SELECT id,project,agent,path,hash,source_hash,language,size_bytes,chunk_count,indexed_at,modified_at FROM arachne_files';

export class Store {
  readonly project: string;
  readonly agent: string;
  readonly projectRoot: string;
  readonly dbPath: string;
  readonly backupDir: string;
  readonly legacyPath: string;
  legacyImport: LegacyImportResult | null = null;
  private readonly autoImportLegacy: boolean;
  private connection: Database.Database | null = null;

  constructor(dataDir: string, options: StoreOptions = {}) {
    this.projectRoot = fs.realpathSync(path.resolve(options.projectRoot ?? process.cwd()));
    this.project = scopeName(
      options.project ?? process.env.N2_PROJECT ?? path.basename(this.projectRoot),
    );
    this.agent = scopeName(options.agent ?? process.env.N2_AGENT_NAME ?? 'assistant');
    this.dbPath = path.resolve(options.dbPath ?? path.join(dataDir, 'mimir.db'));
    this.legacyPath = path.resolve(dataDir, 'context.db');
    this.autoImportLegacy = options.importLegacy ?? true;
    const scope = createHash('sha256')
      .update(JSON.stringify([this.project, this.agent]))
      .digest('hex')
      .slice(0, 32);
    this.backupDir = path.resolve(dataDir, 'arachne-backups', scope);
  }

  async init(): Promise<void> {
    if (this.connection) return;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const db = new Database(this.dbPath, { timeout: 5000 });
    try {
      db.pragma('foreign_keys=ON');
      initializeSchema(db);
      db.pragma('journal_mode=WAL');
      db.pragma('synchronous=FULL');
      db.transaction(() => {
        db.prepare(
          'INSERT OR IGNORE INTO arachne_scope_state(project,agent,root) VALUES(?,?,?)',
        ).run(this.project, this.agent, this.projectRoot);
        const row = db
          .prepare('SELECT root FROM arachne_scope_state WHERE project=? AND agent=?')
          .get(this.project, this.agent) as { root: unknown };
        if (row.root !== this.projectRoot)
          throw new Error('This project and agent already belong to a different source root');
      }).immediate();
      this.connection = db;
      if (this.autoImportLegacy) this.legacyImport = importLegacy(this, this.legacyPath);
    } catch (error) {
      db.close();
      this.connection = null;
      throw error;
    }
  }

  migrateLegacy(filename = this.legacyPath, allowRootChange = false): LegacyImportResult {
    this.legacyImport = importLegacy(this, filename, allowRootChange);
    return this.legacyImport;
  }

  get db(): Database.Database {
    if (!this.connection) throw new Error('Store not initialized. Call init() first.');
    return this.connection;
  }

  get revision(): string {
    const row = this.db
      .prepare('SELECT revision FROM arachne_scope_state WHERE project=? AND agent=?')
      .get(this.project, this.agent) as { revision: unknown };
    return `${integer(row.revision, 'scope revision')}:${this.db.pragma('data_version', { simple: true })}`;
  }

  _setMeta(key: string, value: string): void {
    text(key, 'metadata key');
    text(value, 'metadata value');
    if (key === 'schema_version') throw new Error('Schema version is managed by initialization');
    if (key === 'project_dir' && fs.realpathSync(path.resolve(value)) !== this.projectRoot)
      throw new Error('Source root differs from the stored scope');
    this.db
      .prepare(
        `INSERT INTO arachne_metadata(project,agent,key,value) VALUES(?,?,?,?)
      ON CONFLICT(project,agent,key) DO UPDATE SET value=excluded.value`,
      )
      .run(this.project, this.agent, key, value);
  }

  getMeta(key: string): string | null {
    if (key === 'schema_version') return ARACHNE_SCHEMA_VERSION;
    if (key === 'project_dir') return this.projectRoot;
    const row = this.db
      .prepare('SELECT value FROM arachne_metadata WHERE project=? AND agent=? AND key=?')
      .get(this.project, this.agent, key) as { value: unknown } | undefined;
    return row ? text(row.value, 'metadata value') : null;
  }

  upsertFile(
    filename: string,
    hash: string,
    language: string,
    sizeBytes: number,
    modifiedAt: string,
    force = false,
  ): UpsertResult {
    filename = relativePath(filename);
    text(hash, 'file hash');
    text(language, 'file language');
    integer(sizeBytes, 'file size');
    text(modifiedAt, 'file timestamp');
    return this.db
      .transaction((): UpsertResult => {
        const existing = this.getFileByPath(filename);
        if (!force && existing?.hash === hash) return { action: 'skipped', fileId: existing.id };
        if (existing) {
          this.db.prepare('DELETE FROM arachne_chunks WHERE file_id=?').run(existing.id);
          this.db
            .prepare('DELETE FROM arachne_dependencies WHERE source_file_id=?')
            .run(existing.id);
          this.db
            .prepare(
              `UPDATE arachne_files SET hash=?,language=?,size_bytes=?,modified_at=?,chunk_count=0,
          content=NULL,indexed_at=datetime('now') WHERE id=?`,
            )
            .run(hash, language, sizeBytes, modifiedAt, existing.id);
          return { action: 'updated', fileId: existing.id };
        }
        const result = this.db
          .prepare(
            'INSERT INTO arachne_files(project,agent,path,hash,language,size_bytes,modified_at) VALUES(?,?,?,?,?,?,?)',
          )
          .run(this.project, this.agent, filename, hash, language, sizeBytes, modifiedAt);
        return {
          action: 'inserted',
          fileId: integer(Number(result.lastInsertRowid), 'file ID'),
        };
      })
      .immediate();
  }

  insertChunks(fileId: number, chunks: ChunkRecord[]): void {
    this.requireFile(fileId);
    if (!Array.isArray(chunks) || chunks.length > 100_000) throw new Error('Invalid chunk batch');
    chunks.forEach(validateChunk);
    this.db
      .transaction(() => {
        const statement = this.db
          .prepare(`INSERT INTO arachne_chunks(file_id,chunk_type,name,start_line,end_line,content,token_count,search_text)
        VALUES(?,?,?,?,?,?,?,?)`);
        for (const chunk of chunks)
          statement.run(
            fileId,
            chunk.type,
            chunk.name,
            chunk.startLine,
            chunk.endLine,
            chunk.content,
            chunk.tokenCount,
            chunk.searchText,
          );
        this.db
          .prepare(
            'UPDATE arachne_files SET chunk_count=(SELECT count(*) FROM arachne_chunks WHERE file_id=?) WHERE id=?',
          )
          .run(fileId, fileId);
      })
      .immediate();
  }

  removeFile(filename: string): Database.RunResult {
    return this.db
      .prepare('DELETE FROM arachne_files WHERE project=? AND agent=? AND path=?')
      .run(this.project, this.agent, relativePath(filename));
  }

  getFileByPath(filename: string): FileRow | undefined {
    const row = this.db
      .prepare(`${FILES} WHERE project=? AND agent=? AND path=?`)
      .get(this.project, this.agent, relativePath(filename));
    return row ? fileRow(row) : undefined;
  }

  requireFile(id: number): FileRow {
    integer(id, 'file ID');
    const row = this.db
      .prepare(`${FILES} WHERE id=? AND project=? AND agent=?`)
      .get(id, this.project, this.agent);
    if (!row) throw new Error('File does not belong to this project and agent');
    return fileRow(row);
  }

  getAllFiles(language?: string): FileRow[] {
    return this.db
      .prepare(`${FILES} WHERE project=? AND agent=? AND (? IS NULL OR language=?) ORDER BY path`)
      .all(this.project, this.agent, language ?? null, language ?? null)
      .map(fileRow);
  }

  getChunksByFileId(fileId: number): ChunkRow[] {
    integer(fileId, 'file ID');
    return this.db
      .prepare(`${CHUNKS} WHERE f.project=? AND f.agent=? AND f.id=? ORDER BY c.start_line,c.id`)
      .all(this.project, this.agent, fileId)
      .map(chunkRow);
  }

  *iterateChunksByFileId(fileId: number): Generator<ChunkRow> {
    integer(fileId, 'file ID');
    const rows = this.db.prepare(
      `${CHUNKS} WHERE f.project=? AND f.agent=? AND f.id=? ORDER BY c.start_line,c.id`,
    );
    for (const value of rows.iterate(this.project, this.agent, fileId)) yield chunkRow(value);
  }

  getChunksByFileIds(fileIds: number[]): ChunkRow[] {
    if (!Array.isArray(fileIds) || fileIds.length > MAX_QUERY_ITEMS)
      throw new Error('Invalid file ID list');
    if (!fileIds.length) return [];
    fileIds.forEach((id) => integer(id, 'file ID'));
    return this.db
      .prepare(
        `${CHUNKS} WHERE f.project=? AND f.agent=? AND f.id IN (${fileIds.map(() => '?').join(',')}) ORDER BY f.path,c.start_line,c.id`,
      )
      .all(this.project, this.agent, ...fileIds)
      .map(chunkRow);
  }

  getChunk(id: number): ChunkRow | undefined {
    integer(id, 'chunk ID');
    const row = this.db
      .prepare(`${CHUNKS} WHERE f.project=? AND f.agent=? AND c.id=?`)
      .get(this.project, this.agent, id);
    return row ? chunkRow(row) : undefined;
  }

  allChunks(language?: string): ChunkRow[] {
    return this.db
      .prepare(
        `${CHUNKS} WHERE f.project=? AND f.agent=? AND (? IS NULL OR f.language=?) ORDER BY c.id`,
      )
      .all(this.project, this.agent, language ?? null, language ?? null)
      .map(chunkRow);
  }

  searchChunks(query: string, limit = 10): ChunkRow[] {
    integer(limit, 'search limit', MAX_QUERY_ITEMS);
    text(query, 'search query');
    if (query.length > 4096) throw new Error('Search query exceeds 4096 characters');
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length || limit === 0) return [];
    const conditions = terms
      .map(() => "instr(lower(COALESCE(c.search_text,'')),?)>0")
      .join(' AND ');
    return this.db
      .prepare(
        `${CHUNKS} WHERE f.project=? AND f.agent=? AND ${conditions} ORDER BY c.token_count,c.id LIMIT ?`,
      )
      .all(this.project, this.agent, ...terms, limit)
      .map(chunkRow);
  }

  getStats(): StoreStats {
    return this.db
      .transaction(() => {
        const totals = this.db
          .prepare(
            `SELECT count(*) AS chunks,COALESCE(SUM(c.token_count),0) AS tokens,
        COALESCE(SUM(CASE WHEN typeof(c.token_count)!='integer' OR c.token_count<0 THEN 1 ELSE 0 END),0) AS invalid
        FROM arachne_chunks c JOIN arachne_files f ON f.id=c.file_id WHERE f.project=? AND f.agent=?`,
          )
          .get(this.project, this.agent) as {
          chunks: unknown;
          tokens: unknown;
          invalid: unknown;
        };
        if (totals.invalid !== 0) throw new Error('Invalid stored token count');
        const groups = this.db
          .prepare(
            `SELECT language,count(*) AS cnt FROM arachne_files
        WHERE project=? AND agent=? GROUP BY language ORDER BY cnt DESC,language`,
          )
          .all(this.project, this.agent) as Array<{
          language: unknown;
          cnt: unknown;
        }>;
        const languages = groups.map((row) => ({
          language: row.language === null ? null : text(row.language, 'file language'),
          cnt: integer(row.cnt, 'file count'),
        }));
        const size = fs.statSync(this.dbPath).size;
        return {
          fileCount: languages.reduce((sum, row) => sum + row.cnt, 0),
          chunkCount: integer(totals.chunks, 'chunk count'),
          totalTokens: integer(totals.tokens, 'total tokens'),
          languages,
          dbSizeBytes: size,
          dbSizeMB: (size / 1048576).toFixed(2),
          lastIndexed: this.getMeta('last_indexed_at'),
          schemaVersion: ARACHNE_SCHEMA_VERSION,
        };
      })
      .deferred();
  }

  cleanStaleFiles(projectDir: string, within = ''): number {
    if (fs.realpathSync(projectDir) !== this.projectRoot)
      throw new Error('Cleanup root differs from the stored scope');
    return this.db
      .transaction(() => {
        let removed = 0;
        for (const file of this.getAllFiles()) {
          if (within && file.path !== within && !file.path.startsWith(within + '/')) continue;
          try {
            fs.statSync(path.join(this.projectRoot, file.path));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            removed += this.removeFile(file.path).changes;
          }
        }
        return removed;
      })
      .immediate();
  }

  insertDependencies(fileId: number, dependencies: ResolvedDep[]): void {
    this.requireFile(fileId);
    this.db
      .transaction(() => {
        const statement = this.db
          .prepare(`INSERT INTO arachne_dependencies(source_file_id,target_path,target_file_id,dep_type) VALUES(?,?,?,?)
        ON CONFLICT(source_file_id,target_path) DO UPDATE SET target_file_id=excluded.target_file_id,dep_type=excluded.dep_type`);
        for (const dependency of dependencies) {
          text(dependency.targetPath, 'dependency path');
          const targetId = dependency.targetFileId ?? null;
          if (targetId !== null) this.requireFile(targetId);
          statement.run(fileId, dependency.targetPath, targetId, dependency.depType || 'import');
        }
      })
      .immediate();
  }

  clearDependencies(fileId: number): void {
    this.requireFile(fileId);
    this.db.prepare('DELETE FROM arachne_dependencies WHERE source_file_id=?').run(fileId);
  }

  getDirectDependencies(fileId: number): DependencyRow[] {
    this.requireFile(fileId);
    return this.db
      .prepare(
        `SELECT d.*,f.path AS target_resolved_path FROM arachne_dependencies d
      LEFT JOIN arachne_files f ON f.id=d.target_file_id WHERE d.source_file_id=? ORDER BY d.target_path`,
      )
      .all(fileId)
      .map(dependencyRow);
  }

  getReverseDependencies(fileId: number): DependencyRow[] {
    this.requireFile(fileId);
    return this.db
      .prepare(
        `SELECT d.*,f.path AS source_path FROM arachne_dependencies d JOIN arachne_files f ON f.id=d.source_file_id
      WHERE d.target_file_id=? AND f.project=? AND f.agent=? ORDER BY f.path`,
      )
      .all(fileId, this.project, this.agent)
      .map(dependencyRow);
  }

  getTransitiveDependencies(
    fileId: number,
    maxDepth = 2,
  ): Array<DependencyRow & { depth: number }> {
    integer(maxDepth, 'dependency depth', 20);
    this.requireFile(fileId);
    const visited = new Set<number>();
    const result: Array<DependencyRow & { depth: number }> = [];
    const queue = [{ fileId, depth: 0 }];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      if (queue.length > MAX_QUERY_ITEMS || result.length > 100_000)
        throw new Error('Dependency traversal limit reached');
      const item = queue[cursor]!;
      if (visited.has(item.fileId) || item.depth >= maxDepth) continue;
      visited.add(item.fileId);
      for (const dependency of this.getDirectDependencies(item.fileId)) {
        result.push({ ...dependency, depth: item.depth + 1 });
        if (dependency.target_file_id !== null && !visited.has(dependency.target_file_id))
          queue.push({
            fileId: dependency.target_file_id,
            depth: item.depth + 1,
          });
      }
    }
    return result;
  }

  logAccess(fileId: number, query: string | null): void {
    this.requireFile(fileId);
    if (query !== null) text(query, 'access query');
    this.db.prepare('INSERT INTO arachne_access_log(file_id,query) VALUES(?,?)').run(fileId, query);
  }

  getRecentFiles(limit = 10): AccessLogRow[] {
    integer(limit, 'recent file limit', MAX_QUERY_ITEMS);
    return this.db
      .prepare(
        `SELECT a.file_id,f.path,MAX(a.accessed_at) AS last_access FROM arachne_access_log a
      JOIN arachne_files f ON f.id=a.file_id WHERE f.project=? AND f.agent=? GROUP BY a.file_id ORDER BY last_access DESC,f.path LIMIT ?`,
      )
      .all(this.project, this.agent, limit)
      .map(accessRow);
  }

  getMostAccessedFiles(limit = 5): AccessLogRow[] {
    integer(limit, 'frequent file limit', MAX_QUERY_ITEMS);
    return this.db
      .prepare(
        `SELECT a.file_id,f.path,COUNT(*) AS access_count FROM arachne_access_log a
      JOIN arachne_files f ON f.id=a.file_id WHERE f.project=? AND f.agent=? GROUP BY a.file_id ORDER BY access_count DESC,f.path LIMIT ?`,
      )
      .all(this.project, this.agent, limit)
      .map(accessRow);
  }

  cleanAccessLog(maxAgeDays = 30): number {
    integer(maxAgeDays, 'access retention days', 365000);
    return this.db
      .prepare(
        `DELETE FROM arachne_access_log WHERE accessed_at<datetime('now',?)
      AND file_id IN (SELECT id FROM arachne_files WHERE project=? AND agent=?)`,
      )
      .run(`-${maxAgeDays} days`, this.project, this.agent).changes;
  }

  close(): void {
    this.connection?.close();
    this.connection = null;
  }
}
