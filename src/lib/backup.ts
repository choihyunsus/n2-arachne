// Backup/restore/GC (following Soul's n2_kv_backup pattern)
import fs from 'fs';
import path from 'path';
import type { Store } from './store';
import type {
  BackupConfig, BackupEntry, BackupMeta,
  BackupCreateResult, BackupRestoreResult, BackupListItem, ChunkRow,
} from '../types';

export class Backup {
  private readonly _store: Store;
  private readonly _config: BackupConfig;
  private readonly _metaPath: string;

  constructor(store: Store, config: BackupConfig) {
    this._store = store;
    this._config = config;
    this._metaPath = path.join(store.backupDir, 'backups.json');
  }

  /**
   * Backup current DB
   */
  async create(label?: string, trigger = 'manual'): Promise<BackupCreateResult> {
    fs.mkdirSync(this._store.backupDir, { recursive: true });

    const id = this._generateId();
    const filename = `context-${id}.db`;
    const dest = path.join(this._store.backupDir, filename);

    await this._store.db.backup(dest);

    const size = fs.statSync(dest).size;
    const stats = this._store.getStats();

    const meta = this._loadMeta();
    meta.backups.push({
      id,
      filename,
      label: label ?? null,
      trigger,
      created_at: new Date().toISOString(),
      file_count: stats.fileCount,
      chunk_count: stats.chunkCount,
      size_bytes: size,
    });
    this._saveMeta(meta);

    await this.gc();

    return { id, filename, size, files: stats.fileCount, chunks: stats.chunkCount };
  }

  /**
   * Restore from backup
   */
  async restore(backupId?: string): Promise<BackupRestoreResult> {
    const meta = this._loadMeta();
    let entry: BackupEntry | undefined;

    if (backupId) {
      entry = meta.backups.find(b => b.id === backupId);
    } else {
      entry = meta.backups[meta.backups.length - 1];
    }

    if (!entry) {
      throw new Error(`Backup not found: ${backupId ?? 'latest'}`);
    }

    const src = path.join(this._store.backupDir, entry.filename);
    if (!fs.existsSync(src)) {
      throw new Error(`Backup file missing: ${entry.filename}`);
    }

    this._store.close();
    fs.copyFileSync(src, this._store.dbPath);

    return { restored: entry.id, label: entry.label, files: entry.file_count };
  }

  /** List backups */
  list(): BackupListItem[] {
    const meta = this._loadMeta();
    return meta.backups.map(b => ({
      id: b.id,
      label: b.label,
      trigger: b.trigger,
      created_at: b.created_at,
      files: b.file_count,
      chunks: b.chunk_count,
      sizeMB: (b.size_bytes / 1024 / 1024).toFixed(2),
    }));
  }

  /**
   * Search within backup DB (ATTACH DATABASE)
   */
  searchBackup(backupId: string, query: string, limit = 10): ChunkRow[] {
    const meta = this._loadMeta();
    const entry = meta.backups.find(b => b.id === backupId);
    if (!entry) throw new Error(`Backup not found: ${backupId}`);

    const backupPath = path.join(this._store.backupDir, entry.filename);
    if (!fs.existsSync(backupPath)) throw new Error(`Backup file missing: ${entry.filename}`);

    const db = this._store.db;
    const safeAlias = 'bk_' + backupId.replace(/[^a-z0-9]/gi, '_');

    db.exec(`ATTACH DATABASE '${backupPath.replace(/'/g, "''")}' AS ${safeAlias}`);
    try {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      if (terms.length === 0) return [];

      const conditions = terms.map(() => `LOWER(search_text) LIKE ?`).join(' AND ');
      const params = terms.map(t => `%${t}%`);

      return db.prepare(`
        SELECT *, '${backupId}' as backup_id
        FROM ${safeAlias}.chunks
        WHERE ${conditions}
        LIMIT ?
      `).all(...params, limit) as ChunkRow[];
    } finally {
      db.exec(`DETACH DATABASE ${safeAlias}`);
    }
  }

  /**
   * GC: Delete old/excess backups
   */
  async gc(maxAgeDays?: number, maxCount?: number): Promise<number> {
    const maxAge = maxAgeDays ?? this._config.maxAgeDays ?? 30;
    const maxBackups = maxCount ?? this._config.maxBackups ?? 10;
    const meta = this._loadMeta();
    let removed = 0;
    const cutoff = Date.now() - maxAge * 86400000;

    meta.backups = meta.backups.filter(b => {
      const age = new Date(b.created_at).getTime();
      if (age < cutoff) {
        this._deleteBackupFile(b.filename);
        removed++;
        return false;
      }
      return true;
    });

    while (meta.backups.length > maxBackups) {
      const oldest = meta.backups.shift();
      if (oldest) {
        this._deleteBackupFile(oldest.filename);
        removed++;
      }
    }

    this._saveMeta(meta);
    return removed;
  }

  /** Export backup to external path */
  exportTo(externalDir: string | null): { exported: string; dest: string } | null {
    if (!externalDir) return null;
    fs.mkdirSync(externalDir, { recursive: true });

    const meta = this._loadMeta();
    if (meta.backups.length === 0) return null;

    const latest = meta.backups[meta.backups.length - 1]!;
    const src = path.join(this._store.backupDir, latest.filename);
    const dest = path.join(externalDir, latest.filename);

    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      fs.copyFileSync(this._metaPath, path.join(externalDir, 'backups.json'));
      return { exported: latest.id, dest };
    }
    return null;
  }

  // ── Private ──

  private _generateId(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }

  private _loadMeta(): BackupMeta {
    if (!fs.existsSync(this._metaPath)) {
      return { backups: [] };
    }
    return JSON.parse(fs.readFileSync(this._metaPath, 'utf-8')) as BackupMeta;
  }

  private _saveMeta(meta: BackupMeta): void {
    fs.writeFileSync(this._metaPath, JSON.stringify(meta, null, 2));
  }

  private _deleteBackupFile(filename: string): void {
    const filePath = path.join(this._store.backupDir, filename);
    try { fs.unlinkSync(filePath); } catch { /* ignore if already gone */ }
  }
}
