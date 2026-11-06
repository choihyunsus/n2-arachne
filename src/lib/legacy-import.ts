// One-time, copy-only import of the standalone v1-v3 context database.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Store } from './store';
import { chunkRow, dependencyRow, fileRow, integer, optionalText, text } from './store-values';

export interface LegacyImportResult {
  status: 'absent' | 'imported' | 'already-imported' | 'owned-by-another-agent';
  files: number;
  chunks: number;
}

export function importLegacy(
  store: Store,
  filename: string,
  allowRootChange = false,
): LegacyImportResult {
  if (!fs.existsSync(filename)) return { status: 'absent', files: 0, chunks: 0 };
  const sourcePath = fs.realpathSync(filename);
  if (sourcePath === fs.realpathSync(store.dbPath))
    throw new Error('Legacy source must differ from the shared database');
  const prior = priorImport(store, sourcePath);
  if (prior) return prior;
  const source = new Database(sourcePath, {
    readonly: true,
    fileMustExist: true,
    timeout: 5000,
  });
  try {
    return source
      .transaction(() =>
        store.db
          .transaction(() => {
            const committed = priorImport(store, sourcePath);
            if (committed) return committed;
            const counts = copyLegacyContents(source, store, allowRootChange);
            store.db
              .prepare(
                'INSERT INTO arachne_legacy_imports(source_path,project,agent) VALUES(?,?,?)',
              )
              .run(sourcePath, store.project, store.agent);
            return { status: 'imported' as const, ...counts };
          })
          .immediate(),
      )
      .deferred();
  } finally {
    source.close();
  }
}

/** Caller owns the source read snapshot and destination transaction. */
export function copyLegacyContents(
  source: Database.Database,
  store: Store,
  allowRootChange = false,
): { files: number; chunks: number } {
  validateLegacySource(source, store, allowRootChange);
  if (store.getStats().fileCount)
    throw new Error('Legacy import requires an empty target Arachne scope');
  const files = copyFiles(source, store);
  const chunks = copyChunks(source, store, files);
  copyDependencies(source, store, files);
  copyAccess(source, store, files);
  copyMetadata(source, store);
  return { files: files.size, chunks };
}

function priorImport(store: Store, sourcePath: string): LegacyImportResult | null {
  const receipt = store.db
    .prepare('SELECT project,agent FROM arachne_legacy_imports WHERE source_path=?')
    .get(sourcePath) as { project: string; agent: string } | undefined;
  if (receipt)
    return {
      status:
        receipt.project === store.project && receipt.agent === store.agent
          ? 'already-imported'
          : 'owned-by-another-agent',
      files: 0,
      chunks: 0,
    };
  return null;
}

function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name),
  );
}

export function validateLegacySource(
  source: Database.Database,
  store: Store,
  allowRootChange = false,
): void {
  if (!hasTable(source, 'files') || !hasTable(source, 'chunks') || !hasTable(source, 'meta'))
    throw new Error('Unsupported legacy context database');
  const version = source.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
    | { value: unknown }
    | undefined;
  if (version && !['1', '2', '3'].includes(text(version.value, 'legacy schema version')))
    throw new Error('Unsupported legacy context schema version');
  const count = source.prepare('SELECT COUNT(*) AS count FROM files').get() as {
    count: unknown;
  };
  if (integer(count.count, 'legacy file count', 100000) === 0 || allowRootChange) return;
  const root = source.prepare("SELECT value FROM meta WHERE key='project_dir'").get() as
    | { value: unknown }
    | undefined;
  if (
    !root ||
    fs.realpathSync(path.resolve(text(root.value, 'legacy root'))) !== store.projectRoot
  ) {
    throw new Error(
      'Legacy project root differs or is unknown. Explicitly review ownership before importing with allowRootChange.',
    );
  }
}

function copyFiles(source: Database.Database, store: Store): Map<number, number> {
  const ids = new Map<number, number>();
  const insert = store.db
    .prepare(`INSERT INTO arachne_files(project,agent,path,hash,language,size_bytes,chunk_count,indexed_at,modified_at)
    VALUES(?,?,?,?,?,?,0,?,?)`);
  for (const value of source.prepare('SELECT * FROM files ORDER BY id').iterate()) {
    const row = fileRow(value);
    const result = insert.run(
      store.project,
      store.agent,
      row.path,
      row.hash,
      row.language,
      row.size_bytes,
      row.indexed_at,
      row.modified_at,
    );
    ids.set(row.id, integer(Number(result.lastInsertRowid), 'imported file ID'));
  }
  return ids;
}

function copyChunks(source: Database.Database, store: Store, files: Map<number, number>): number {
  const insert = store.db
    .prepare(`INSERT INTO arachne_chunks(file_id,chunk_type,name,start_line,end_line,content,token_count,search_text,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  let count = 0;
  for (const value of source.prepare('SELECT * FROM chunks ORDER BY id').iterate()) {
    if (++count > 1000000) throw new Error('Legacy chunk import limit reached');
    const row = chunkRow(value);
    const fileId = files.get(row.file_id);
    if (fileId === undefined) throw new Error('Legacy chunk refers to a missing file');
    insert.run(
      fileId,
      row.chunk_type,
      row.name,
      row.start_line,
      row.end_line,
      row.content,
      row.token_count,
      [row.search_text ?? '', row.content].join(' ').toLowerCase(),
      row.created_at,
    );
  }
  store.db
    .prepare(
      `UPDATE arachne_files SET chunk_count=(SELECT count(*) FROM arachne_chunks WHERE file_id=arachne_files.id)
    WHERE project=? AND agent=?`,
    )
    .run(store.project, store.agent);
  return count;
}

function copyDependencies(
  source: Database.Database,
  store: Store,
  files: Map<number, number>,
): void {
  if (!hasTable(source, 'dependencies')) return;
  for (const value of source
    .prepare('SELECT * FROM dependencies ORDER BY source_file_id,target_path')
    .iterate()) {
    const row = dependencyRow(value);
    const sourceId = files.get(row.source_file_id);
    const targetId = row.target_file_id === null ? null : files.get(row.target_file_id);
    if (sourceId === undefined || targetId === undefined)
      throw new Error('Legacy dependency refers to a missing file');
    store.db
      .prepare(
        'INSERT INTO arachne_dependencies(source_file_id,target_path,target_file_id,dep_type) VALUES(?,?,?,?)',
      )
      .run(sourceId, row.target_path, targetId, row.dep_type);
  }
}

function copyAccess(source: Database.Database, store: Store, files: Map<number, number>): void {
  if (!hasTable(source, 'access_log')) return;
  const insert = store.db.prepare(
    'INSERT INTO arachne_access_log(file_id,query,accessed_at) VALUES(?,?,?)',
  );
  for (const value of source.prepare('SELECT * FROM access_log ORDER BY id').iterate()) {
    const row = value as Record<string, unknown>;
    const fileId = files.get(integer(row.file_id, 'legacy access file'));
    if (fileId === undefined) throw new Error('Legacy access record refers to a missing file');
    insert.run(
      fileId,
      optionalText(row.query, 'legacy query'),
      text(row.accessed_at, 'legacy access timestamp'),
    );
  }
}

function copyMetadata(source: Database.Database, store: Store): void {
  for (const value of source.prepare('SELECT key,value FROM meta ORDER BY key').iterate()) {
    const row = value as Record<string, unknown>;
    const key = text(row.key, 'legacy metadata key');
    if (key === 'schema_version' || key === 'project_dir' || row.value === null) continue;
    store._setMeta(key, text(row.value, 'legacy metadata value'));
  }
}
