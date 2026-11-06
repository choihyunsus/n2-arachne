// Owner-scoped, checksummed SQLite snapshots with transactional restore.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { Store } from './store';
import { acquireBackup, acquireIndex } from './index-lock';
import { LegacyBackups } from './legacy-backup';
import {
  hashFile,
  readSnapshotHeader,
  restoreSnapshot,
  writeSnapshot,
  type SnapshotHeader,
} from './snapshot';
import { chunkRow, integer, text } from './store-values';
import type {
  BackupConfig,
  BackupEntry,
  BackupCreateResult,
  BackupRestoreResult,
  BackupListItem,
  ChunkRow,
} from '../types';

type CatalogEntry = BackupEntry & { sha256: string };
type AvailableEntry = BackupEntry & { sha256?: string; legacy?: boolean };
const SNAPSHOT_FILE =
  /^context-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.db$/;

export class Backup {
  readonly directory: string;
  private readonly legacy: LegacyBackups;
  constructor(
    private readonly store: Store,
    private readonly config: BackupConfig,
  ) {
    this.directory = config.dir
      ? path.resolve(config.dir, path.basename(store.backupDir))
      : store.backupDir;
    this.legacy = new LegacyBackups(store);
  }

  async create(label?: string, trigger = 'manual'): Promise<BackupCreateResult> {
    if (label !== undefined && text(label, 'backup label').length > 4096)
      throw new Error('Backup label is too long');
    if (!text(trigger, 'backup trigger') || trigger.length > 128)
      throw new Error('Invalid backup trigger');
    const release = acquireBackup(this.store);
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const id = randomUUID();
      const filename = `context-${id}.db`;
      const dest = path.join(this.directory, filename);
      const temporary = dest + '.partial';
      const header: SnapshotHeader = {
        version: 1,
        id,
        project: this.store.project,
        agent: this.store.agent,
        root: this.store.projectRoot,
        label: label ?? null,
        trigger,
        created_at: new Date().toISOString(),
      };
      try {
        const counts = writeSnapshot(this.store.db, temporary, this.store, header);
        const digest = hashFile(temporary);
        fs.renameSync(temporary, dest);
        this.register(header, dest, counts, digest);
        const exportedTo = this.exportCreated(id);
        this.collect(this.config.maxAgeDays, this.config.maxBackups);
        return { id, filename, size: digest.size, ...counts, exportedTo };
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    } finally {
      release();
    }
  }

  async restore(backupId?: string): Promise<BackupRestoreResult> {
    const releaseBackup = acquireBackup(this.store);
    try {
      const releaseIndex = acquireIndex(this.store);
      try {
        const entry = this.entry(backupId);
        if (entry.legacy) return this.legacy.restore(entry);
        const source = this.open(entry as CatalogEntry);
        try {
          const counts = restoreSnapshot(source, this.store);
          return {
            restored: entry.id,
            label: entry.label,
            files: counts.files,
          };
        } finally {
          source.close();
        }
      } finally {
        releaseIndex();
      }
    } finally {
      releaseBackup();
    }
  }

  list(): BackupListItem[] {
    return this.availableEntries().map((entry) => ({
      id: entry.id,
      label: entry.label,
      trigger: entry.trigger,
      created_at: entry.created_at,
      files: entry.file_count,
      chunks: entry.chunk_count,
      sizeMB: (entry.size_bytes / 1024 ** 2).toFixed(2),
    }));
  }

  searchBackup(backupId: string, query: string, limit = 10): ChunkRow[] {
    integer(limit, 'backup search limit', 100);
    if (text(query, 'backup query').length > 4096) throw new Error('Backup query is too long');
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!terms.length || limit === 0) return [];
    if (terms.length > 64) throw new Error('Too many backup search terms');
    const entry = this.entry(backupId);
    const source = entry.legacy ? this.legacy.open(entry) : this.open(entry as CatalogEntry);
    try {
      const predicates = terms
        .map(() => "LOWER(COALESCE(c.search_text,c.content)) LIKE ? ESCAPE '\\'")
        .join(' AND ');
      const args = terms.map((term) => '%' + term.replace(/[\\%_]/g, '\\$&') + '%');
      const sql = entry.legacy
        ? `SELECT c.*,f.path AS file_path,f.language FROM chunks c JOIN files f ON f.id=c.file_id WHERE ${predicates} ORDER BY f.path,c.start_line,c.id LIMIT ?`
        : `SELECT c.*,f.path AS file_path,f.language FROM arachne_chunks c JOIN arachne_files f ON f.id=c.file_id WHERE f.project=? AND f.agent=? AND ${predicates} ORDER BY f.path,c.start_line,c.id LIMIT ?`;
      const owner = entry.legacy ? [] : [this.store.project, this.store.agent];
      const rows = source.prepare(sql).all(...owner, ...args, limit);
      return rows.map((row) => ({ ...chunkRow(row), backup_id: entry.id }));
    } finally {
      source.close();
    }
  }

  async gc(
    maxAgeDays = this.config.maxAgeDays,
    maxCount = this.config.maxBackups,
  ): Promise<number> {
    const release = acquireBackup(this.store);
    try {
      return this.collect(maxAgeDays, maxCount);
    } finally {
      release();
    }
  }

  exportTo(externalDir: string | null): { exported: string; dest: string } | null {
    if (!externalDir) return null;
    const release = acquireBackup(this.store);
    try {
      const entry = this.entries().at(-1);
      if (!entry) return null;
      return this.exportEntry(entry, externalDir);
    } finally {
      release();
    }
  }

  private exportCreated(id: string): string | undefined {
    if (!this.config.externalBackupDir) return undefined;
    try {
      return this.exportEntry(this.entry(id) as CatalogEntry, this.config.externalBackupDir).dest;
    } catch (error) {
      throw new Error(
        `Backup ${id} is saved locally. External export failed. ${(error as Error).message}`,
      );
    }
  }

  private exportEntry(entry: CatalogEntry, directory: string): { exported: string; dest: string } {
    const source = this.open(entry);
    source.close();
    fs.mkdirSync(directory, { recursive: true });
    const dest = path.resolve(directory, path.basename(entry.filename));
    if (path.resolve(entry.filename) === dest)
      throw new Error('Export destination equals the snapshot source');
    fs.copyFileSync(entry.filename, dest, fs.constants.COPYFILE_EXCL);
    const descriptor = fs.openSync(dest, 'r+');
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    if (hashFile(dest).sha256 !== entry.sha256)
      throw new Error('Exported snapshot checksum differs');
    return { exported: entry.id, dest };
  }

  /** Recover a committed snapshot after a crash between rename and catalog insertion. */
  recover(): number {
    const release = acquireBackup(this.store);
    try {
      if (!fs.existsSync(this.directory)) return 0;
      let recovered = 0;
      let scanned = 0;
      const directory = fs.opendirSync(this.directory);
      try {
        let item: fs.Dirent | null;
        while ((item = directory.readSync()) !== null) {
          if (++scanned > 10000) throw new Error('Snapshot directory entry limit reached');
          const match = SNAPSHOT_FILE.exec(item.name);
          if (!match || !item.isFile() || this.hasEntry(match[1]!)) continue;
          this.recoverFile(path.join(this.directory, item.name), match[1]!);
          recovered++;
        }
      } finally {
        directory.closeSync();
      }
      return recovered;
    } finally {
      release();
    }
  }

  private recoverFile(filename: string, id: string): void {
    const digest = hashFile(filename);
    const source = new Database(filename, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const header = readSnapshotHeader(source, this.store);
      if (header.id !== id || source.pragma('quick_check', { simple: true }) !== 'ok')
        throw new Error('Invalid orphan snapshot');
      const counts = source
        .prepare(
          'SELECT (SELECT COUNT(*) FROM arachne_files) AS files,(SELECT COUNT(*) FROM arachne_chunks) AS chunks',
        )
        .get() as { files: number; chunks: number };
      this.register(header, filename, counts, digest);
    } finally {
      source.close();
    }
  }

  private hasEntry(id: string): boolean {
    return Boolean(this.store.db.prepare('SELECT 1 FROM arachne_backups WHERE id=?').get(id));
  }

  private register(
    header: SnapshotHeader,
    filename: string,
    counts: { files: number; chunks: number },
    digest: { sha256: string; size: number },
  ): void {
    this.store.db
      .prepare(
        'INSERT INTO arachne_backups(id,project,agent,filename,label,trigger,created_at,file_count,chunk_count,size_bytes,sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        header.id,
        this.store.project,
        this.store.agent,
        filename,
        header.label,
        header.trigger,
        header.created_at,
        counts.files,
        counts.chunks,
        digest.size,
        digest.sha256,
      );
  }

  private entries(): CatalogEntry[] {
    return this.store.db
      .prepare('SELECT * FROM arachne_backups WHERE project=? AND agent=? ORDER BY created_at,id')
      .all(this.store.project, this.store.agent) as CatalogEntry[];
  }

  private availableEntries(): AvailableEntry[] {
    return [
      ...this.entries(),
      ...this.legacy.entries().map((entry) => ({ ...entry, legacy: true })),
    ].sort(
      (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id),
    );
  }

  private entry(id?: string): AvailableEntry {
    if (id !== undefined) text(id, 'backup ID');
    const entry =
      id === undefined
        ? this.availableEntries().at(-1)
        : this.availableEntries().find((item) => item.id === id);
    if (!entry) throw new Error(`Backup not found: ${id ?? 'latest'}`);
    return entry;
  }

  private checkedPath(entry: CatalogEntry): string {
    const filename = path.resolve(entry.filename);
    if (
      !SNAPSHOT_FILE.test(path.basename(filename)) ||
      path.dirname(filename) !== this.directory ||
      path.basename(filename) !== `context-${entry.id}.db`
    )
      throw new Error('Invalid snapshot catalog path');
    return filename;
  }

  private open(entry: CatalogEntry): Database.Database {
    const filename = this.checkedPath(entry);
    if (fs.lstatSync(filename).isSymbolicLink())
      throw new Error('Snapshot symbolic links are unsupported');
    const digest = hashFile(filename);
    if (digest.sha256 !== entry.sha256 || digest.size !== entry.size_bytes)
      throw new Error('Snapshot checksum differs from the catalog');
    const source = new Database(filename, {
      readonly: true,
      fileMustExist: true,
      timeout: 5000,
    });
    try {
      if (readSnapshotHeader(source, this.store).id !== entry.id)
        throw new Error('Snapshot ID differs from the catalog');
      return source;
    } catch (error) {
      source.close();
      throw error;
    }
  }

  private collect(maxAgeDays: number, maxCount: number): number {
    integer(maxAgeDays, 'backup age', 36500);
    integer(maxCount, 'backup count', 10000);
    const entries = this.entries();
    const cutoff = Date.now() - maxAgeDays * 86400000;
    const keep = entries.filter((entry) => Date.parse(entry.created_at) >= cutoff).slice(-maxCount);
    const retained = new Set(maxCount === 0 ? [] : keep.map((entry) => entry.id));
    let removed = 0;
    for (const entry of entries) {
      if (retained.has(entry.id)) continue;
      const filename = this.checkedPath(entry);
      try {
        fs.unlinkSync(filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      this.store.db
        .prepare('DELETE FROM arachne_backups WHERE id=? AND project=? AND agent=?')
        .run(entry.id, this.store.project, this.store.agent);
      removed++;
    }
    return removed;
  }
}
