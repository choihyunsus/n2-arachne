// Legacy snapshots remain in place. Explicit restore copies their index into one owner.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Store } from './store';
import { copyLegacyContents, validateLegacySource } from './legacy-import';
import { replaceScope } from './snapshot';
import { integer, optionalText, text } from './store-values';
import type { BackupEntry, BackupRestoreResult } from '../types';
const MEBIBYTE = 1048576;

export class LegacyBackups {
  readonly directory: string;
  constructor(private readonly store: Store) {
    this.directory = path.join(path.dirname(store.legacyPath), 'backups');
  }

  entries(): BackupEntry[] {
    if (!this.available()) return [];
    const filename = path.join(this.directory, 'backups.json');
    if (!fs.existsSync(filename)) return [];
    if (fs.lstatSync(filename).isSymbolicLink() || fs.statSync(filename).size > MEBIBYTE)
      throw new Error('Invalid legacy backup catalog');
    const parsed = JSON.parse(fs.readFileSync(filename, 'utf8')) as {
      backups: unknown[];
    };
    if (!Array.isArray(parsed.backups) || parsed.backups.length > 10000)
      throw new Error('Invalid legacy backup catalog');
    return parsed.backups.map((value) => this.entry(value));
  }

  open(entry: BackupEntry): Database.Database {
    if (!this.available()) throw new Error('Legacy snapshots belong to another owner');
    const filename = path.join(this.directory, entry.filename);
    if (fs.lstatSync(filename).isSymbolicLink() || fs.statSync(filename).size > 2048 * MEBIBYTE)
      throw new Error('Invalid legacy snapshot file');
    const source = new Database(filename, {
      readonly: true,
      fileMustExist: true,
      timeout: 5000,
    });
    try {
      validateLegacySource(source, this.store);
      return source;
    } catch (error) {
      source.close();
      throw error;
    }
  }

  restore(entry: BackupEntry): BackupRestoreResult {
    const source = this.open(entry);
    try {
      const counts = source
        .transaction(() =>
          replaceScope(this.store, () => {
            if (!this.available()) throw new Error('Legacy snapshots belong to another owner');
            const result = copyLegacyContents(source, this.store);
            this.store.db
              .prepare(
                'INSERT OR IGNORE INTO arachne_legacy_imports(source_path,project,agent) VALUES(?,?,?)',
              )
              .run(path.resolve(this.directory), this.store.project, this.store.agent);
            return result;
          }),
        )
        .deferred();
      return { restored: entry.id, label: entry.label, files: counts.files };
    } finally {
      source.close();
    }
  }

  private available(): boolean {
    const paths = [path.resolve(this.directory), path.resolve(this.store.legacyPath)];
    for (const filename of paths) {
      const receipt = this.store.db
        .prepare('SELECT project,agent FROM arachne_legacy_imports WHERE source_path=?')
        .get(filename) as { project: string; agent: string } | undefined;
      if (receipt && (receipt.project !== this.store.project || receipt.agent !== this.store.agent))
        return false;
    }
    return true;
  }

  private entry(value: unknown): BackupEntry {
    if (!value || typeof value !== 'object') throw new Error('Invalid legacy backup entry');
    const row = value as Record<string, unknown>;
    const id = text(row.id, 'legacy backup ID');
    if (!/^\d{4}-\d{2}-\d{2}-\d{6}$/.test(id) || row.filename !== `context-${id}.db`)
      throw new Error('Invalid legacy backup path');
    const timestamp = text(row.created_at, 'legacy backup timestamp');
    if (!Number.isFinite(Date.parse(timestamp))) throw new Error('Invalid legacy backup timestamp');
    return {
      id,
      filename: row.filename,
      label: optionalText(row.label, 'legacy backup label'),
      trigger: text(row.trigger, 'legacy backup trigger'),
      created_at: timestamp,
      file_count: integer(row.file_count, 'legacy backup files'),
      chunk_count: integer(row.chunk_count, 'legacy backup chunks'),
      size_bytes: integer(row.size_bytes, 'legacy backup size'),
    };
  }
}
