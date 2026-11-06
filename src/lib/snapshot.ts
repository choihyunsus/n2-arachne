// Copy one Arachne owner between databases without copying Soul or other owners.
import fs from 'node:fs';
export { hashFile } from './file-hash';
import { MAX_SNAPSHOT_BYTES } from './file-hash';
import Database from 'better-sqlite3';
import type { Store } from './store';
import { initializeSchema, ARACHNE_SCHEMA_VERSION } from './schema';
import { fileRow, chunkRow, integer } from './store-values';

type Row = Record<string, unknown>;
type Scope = Pick<Store, 'project' | 'agent' | 'projectRoot'>;
export interface SnapshotHeader {
  version: 1;
  id: string;
  project: string;
  agent: string;
  root: string;
  label: string | null;
  trigger: string;
  created_at: string;
}
const FILE_COLUMNS = [
  'project',
  'agent',
  'path',
  'hash',
  'language',
  'size_bytes',
  'chunk_count',
  'content',
  'indexed_at',
  'modified_at',
];
const CHUNK_COLUMNS = [
  'file_id',
  'chunk_type',
  'name',
  'start_line',
  'end_line',
  'content',
  'token_count',
  'search_text',
  'created_at',
];
const CHILD_TABLES = [
  {
    name: 'arachne_dependencies',
    columns: ['source_file_id', 'target_path', 'target_file_id', 'dep_type'],
    owner: 'source_file_id',
  },
  {
    name: 'arachne_access_log',
    columns: ['file_id', 'query', 'accessed_at'],
    owner: 'file_id',
  },
  {
    name: 'arachne_embeddings',
    columns: ['chunk_id', 'model', 'dimensions', 'vector', 'source_hash', 'created_at'],
    owner: 'chunk_id',
  },
] as const;
const OWNER_TABLES = [
  { name: 'arachne_metadata', columns: ['project', 'agent', 'key', 'value'] },
  {
    name: 'arachne_sessions',
    columns: ['project', 'agent', 'payload_json', 'updated_at'],
  },
] as const;

function inserter(
  db: Database.Database,
  table: string,
  columns: readonly string[],
): Database.Statement {
  return db.prepare(
    `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
  );
}

/** Call inside a read transaction on source and a write transaction on destination. */
export function copyScope(
  source: Database.Database,
  dest: Database.Database,
  scope: Scope,
  limitDatabaseSize = false,
): { files: number; chunks: number } {
  const files = new Map<number, number>();
  const chunks = new Map<number, number>();
  const budget = copyBudget(dest, limitDatabaseSize);
  const fileInsert = inserter(dest, 'arachne_files', FILE_COLUMNS);
  for (const value of source
    .prepare('SELECT * FROM arachne_files WHERE project=? AND agent=? ORDER BY id')
    .iterate(scope.project, scope.agent)) {
    const row = value as Row;
    budget.check(row);
    fileRow(row);
    const id = Number(fileInsert.run(...FILE_COLUMNS.map((key) => row[key])).lastInsertRowid);
    files.set(integer(row.id, 'snapshot file ID'), integer(id, 'restored file ID'));
  }
  const chunkInsert = inserter(dest, 'arachne_chunks', CHUNK_COLUMNS);
  for (const value of source
    .prepare(
      `SELECT c.* FROM arachne_chunks c JOIN arachne_files f ON f.id=c.file_id WHERE f.project=? AND f.agent=? ORDER BY c.id`,
    )
    .iterate(scope.project, scope.agent)) {
    const row = value as Row;
    budget.check(row);
    chunkRow(row);
    const oldId = integer(row.id, 'snapshot chunk ID');
    row.file_id = mapped(files, row.file_id);
    const id = Number(chunkInsert.run(...CHUNK_COLUMNS.map((key) => row[key])).lastInsertRowid);
    chunks.set(oldId, integer(id, 'restored chunk ID'));
  }
  copyChildren(source, dest, scope, files, chunks, budget.check);
  for (const table of OWNER_TABLES) {
    const insert = inserter(dest, table.name, table.columns);
    for (const value of source
      .prepare(`SELECT * FROM ${table.name} WHERE project=? AND agent=?`)
      .iterate(scope.project, scope.agent)) {
      const row = value as Row;
      budget.check(row);
      insert.run(...table.columns.map((key) => row[key]));
    }
  }
  copySourceHashes(source, dest, scope, files);
  budget.finish();
  return { files: files.size, chunks: chunks.size };
}

function copyBudget(dest: Database.Database, limitDatabaseSize: boolean) {
  const deadline = Date.now() + 120000;
  const pageSize = integer(dest.pragma('page_size', { simple: true }), 'SQLite page size');
  let copied = 0,
    bytes = 0,
    nextCheck = 8 * 1048576;
  const finish = () => {
    if (Date.now() > deadline) throw new Error('Snapshot copy time limit reached');
    if (
      limitDatabaseSize &&
      integer(dest.pragma('page_count', { simple: true }), 'SQLite page count') * pageSize >
        MAX_SNAPSHOT_BYTES
    )
      throw new Error('Snapshot database exceeds 2 GiB');
  };
  return {
    check(row: Row) {
      if (++copied > 1000000 || Date.now() > deadline)
        throw new Error('Snapshot copy limit reached');
      for (const value of Object.values(row)) {
        if (typeof value === 'string') bytes += Buffer.byteLength(value);
        else if (Buffer.isBuffer(value)) bytes += value.length;
        else bytes += 8;
      }
      if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('Snapshot copied content exceeds 2 GiB');
      if (bytes >= nextCheck) {
        finish();
        nextCheck = bytes + 8 * 1048576;
      }
    },
    finish,
  };
}

function copySourceHashes(
  source: Database.Database,
  dest: Database.Database,
  scope: Scope,
  files: Map<number, number>,
): void {
  const columns = source.pragma('table_info(arachne_files)') as {
    name: string;
  }[];
  if (!columns.some((column) => column.name === 'source_hash')) return;
  const update = dest.prepare('UPDATE arachne_files SET source_hash=? WHERE id=?');
  for (const value of source
    .prepare(
      'SELECT id,source_hash FROM arachne_files WHERE project=? AND agent=? AND source_hash IS NOT NULL',
    )
    .iterate(scope.project, scope.agent)) {
    const row = value as Row;
    update.run(row.source_hash, mapped(files, row.id));
  }
}

function mapped(ids: Map<number, number>, value: unknown): number {
  const id = ids.get(integer(value, 'snapshot reference'));
  if (id === undefined) throw new Error('Snapshot refers to a missing or foreign row');
  return id;
}

function copyChildren(
  source: Database.Database,
  dest: Database.Database,
  scope: Scope,
  files: Map<number, number>,
  chunks: Map<number, number>,
  check: (row: Row) => void,
): void {
  for (const table of CHILD_TABLES) {
    const join =
      table.owner === 'chunk_id'
        ? 'JOIN arachne_chunks c ON c.id=r.chunk_id JOIN arachne_files f ON f.id=c.file_id'
        : `JOIN arachne_files f ON f.id=r.${table.owner}`;
    const insert = inserter(dest, table.name, table.columns);
    for (const value of source
      .prepare(`SELECT r.* FROM ${table.name} r ${join} WHERE f.project=? AND f.agent=?`)
      .iterate(scope.project, scope.agent)) {
      const row = value as Row;
      check(row);
      row[table.owner] = mapped(table.owner === 'chunk_id' ? chunks : files, row[table.owner]);
      if (table.name === 'arachne_dependencies' && row.target_file_id !== null)
        row.target_file_id = mapped(files, row.target_file_id);
      insert.run(...table.columns.map((key) => row[key]));
    }
  }
}

export function writeSnapshot(
  source: Database.Database,
  filename: string,
  scope: Scope,
  header: SnapshotHeader,
): { files: number; chunks: number } {
  fs.closeSync(fs.openSync(filename, 'wx', 0o600));
  const dest = new Database(filename);
  try {
    dest.pragma('foreign_keys=ON');
    dest.pragma('synchronous=FULL');
    initializeSchema(dest);
    return source
      .transaction(() =>
        dest
          .transaction(() => {
            dest
              .prepare('INSERT INTO arachne_scope_state(project,agent,root) VALUES(?,?,?)')
              .run(scope.project, scope.agent, scope.projectRoot);
            const counts = copyScope(source, dest, scope, true);
            dest
              .prepare("INSERT INTO meta(key,value) VALUES('arachne_backup',?)")
              .run(JSON.stringify(header));
            return counts;
          })
          .immediate(),
      )
      .deferred();
  } finally {
    dest.close();
  }
}

export function readSnapshotHeader(db: Database.Database, scope: Scope): SnapshotHeader {
  const moduleVersion = db
    .prepare("SELECT value FROM meta WHERE key='arachne_schema_version'")
    .get() as { value: unknown } | undefined;
  const row = db.prepare("SELECT value FROM meta WHERE key='arachne_backup'").get() as
    | { value: unknown }
    | undefined;
  if (moduleVersion?.value !== ARACHNE_SCHEMA_VERSION || typeof row?.value !== 'string')
    throw new Error('Unsupported snapshot schema');
  const header = JSON.parse(row.value) as SnapshotHeader;
  if (
    header.version !== 1 ||
    header.project !== scope.project ||
    header.agent !== scope.agent ||
    header.root !== scope.projectRoot
  )
    throw new Error('Snapshot ownership or source root differs');
  if (
    typeof header.id !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(header.id) ||
    typeof header.trigger !== 'string' ||
    !(header.label === null || typeof header.label === 'string') ||
    !Number.isFinite(Date.parse(header.created_at))
  )
    throw new Error('Invalid snapshot header');
  return header;
}

export function restoreSnapshot(
  source: Database.Database,
  store: Store,
): { files: number; chunks: number } {
  return source
    .transaction(() => {
      readSnapshotHeader(source, store);
      const violations = source.pragma('foreign_key_check') as unknown[];
      if (source.pragma('quick_check', { simple: true }) !== 'ok' || violations.length)
        throw new Error('Snapshot integrity check failed');
      return replaceScope(store, () => copyScope(source, store.db, store));
    })
    .deferred();
}

export function replaceScope<T>(store: Store, copy: () => T): T {
  return store.db
    .transaction(() => {
      protectExternalReferences(store);
      store.db
        .prepare('DELETE FROM arachne_files WHERE project=? AND agent=?')
        .run(store.project, store.agent);
      for (const table of OWNER_TABLES)
        store.db
          .prepare(`DELETE FROM ${table.name} WHERE project=? AND agent=?`)
          .run(store.project, store.agent);
      const result = copy();
      store.db
        .prepare('UPDATE arachne_scope_state SET revision=revision+1 WHERE project=? AND agent=?')
        .run(store.project, store.agent);
      return result;
    })
    .immediate();
}

function identifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

/** Unknown module references must survive restore, including cascading foreign keys. */
function protectExternalReferences(store: Store): void {
  const internal = new Set(['arachne_chunks', ...CHILD_TABLES.map((table) => table.name)]);
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
    name: string;
  }[];
  for (const table of tables) {
    if (internal.has(table.name)) continue;
    const keys = store.db.pragma(`foreign_key_list(${identifier(table.name)})`) as {
      table: string;
      from: string;
      to: string | null;
    }[];
    for (const key of keys) {
      if (key.table !== 'arachne_files' && key.table !== 'arachne_chunks') continue;
      const join = key.table === 'arachne_chunks' ? 'JOIN arachne_files f ON f.id=p.file_id' : '';
      const owner = key.table === 'arachne_chunks' ? 'f' : 'p';
      const hit = store.db
        .prepare(
          `SELECT 1 FROM ${identifier(table.name)} r JOIN ${identifier(key.table)} p ON r.${identifier(key.from)}=p.${identifier(key.to ?? 'id')} ${join} WHERE ${owner}.project=? AND ${owner}.agent=? LIMIT 1`,
        )
        .get(store.project, store.agent);
      if (hit) throw new Error(`Restore would invalidate references from ${table.name}`);
    }
  }
}
