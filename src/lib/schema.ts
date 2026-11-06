// Additive module-owned tables alongside the common Soul memory schema.
import type Database from 'better-sqlite3';
import { SOUL_SCHEMA_SQL } from './soul-schema';

export const ARACHNE_SCHEMA_VERSION = '1';

export function initializeSchema(db: Database.Database): void {
  const runtime = db.prepare('SELECT sqlite_version() AS version').get() as {
    version: string;
  };
  const [major = 0, minor = 0, patch = 0] = runtime.version.split('.').map(Number);
  if (major < 3 || (major === 3 && (minor < 51 || (minor === 51 && patch < 3)))) {
    throw new Error('SQLite 3.51.3 or newer is required for WAL-reset durability fixes');
  }
  db.transaction(() => {
    validateVersions(db);
    const files = db.pragma('table_info(arachne_files)') as Array<{
      name: string;
    }>;
    if (files.length && !files.some((column) => column.name === 'source_hash'))
      db.exec('ALTER TABLE arachne_files ADD COLUMN source_hash TEXT');
    db.exec(SOUL_SCHEMA_SQL);
    db.exec(ARACHNE_SCHEMA_SQL);
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version','2')").run();
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('arachne_schema_version',?)").run(
      ARACHNE_SCHEMA_VERSION,
    );
  }).immediate();
}

function validateVersions(db: Database.Database): void {
  const hasMeta = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
    .get();
  const read = (key: string) =>
    hasMeta
      ? (db.prepare('SELECT value FROM meta WHERE key=?').get(key) as
          | { value: unknown }
          | undefined)
      : undefined;
  const common = read('schema_version');
  if (common && common.value !== '1' && common.value !== '2')
    throw new Error('Unsupported common Soul schema version');
  const moduleVersion = read('arachne_schema_version');
  if (moduleVersion && moduleVersion.value !== ARACHNE_SCHEMA_VERSION)
    throw new Error('Unsupported Arachne schema version');
  const hasFiles = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='arachne_files'")
    .get();
  if (hasFiles && !moduleVersion)
    throw new Error('Legacy Arachne tables require explicit ownership migration');
}

const ARACHNE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS arachne_scope_state (
  project TEXT NOT NULL, agent TEXT NOT NULL, root TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(project,agent)
);
CREATE TABLE IF NOT EXISTS arachne_metadata (
  project TEXT NOT NULL, agent TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY(project,agent,key),
  FOREIGN KEY(project,agent) REFERENCES arachne_scope_state(project,agent)
);
CREATE TABLE IF NOT EXISTS arachne_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL, agent TEXT NOT NULL, path TEXT NOT NULL,
  hash TEXT NOT NULL, source_hash TEXT, language TEXT, size_bytes INTEGER CHECK(size_bytes>=0),
  chunk_count INTEGER NOT NULL DEFAULT 0 CHECK(chunk_count>=0), content TEXT,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')), modified_at TEXT,
  UNIQUE(project,agent,path),
  FOREIGN KEY(project,agent) REFERENCES arachne_scope_state(project,agent)
);
CREATE TABLE IF NOT EXISTS arachne_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES arachne_files(id) ON DELETE CASCADE,
  chunk_type TEXT NOT NULL, name TEXT,
  start_line INTEGER NOT NULL CHECK(start_line>=0),
  end_line INTEGER NOT NULL CHECK(end_line>=start_line),
  content TEXT NOT NULL, token_count INTEGER NOT NULL CHECK(token_count>=0), search_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS arachne_dependencies (
  source_file_id INTEGER NOT NULL REFERENCES arachne_files(id) ON DELETE CASCADE,
  target_path TEXT NOT NULL,
  target_file_id INTEGER REFERENCES arachne_files(id) ON DELETE SET NULL,
  dep_type TEXT NOT NULL DEFAULT 'import', PRIMARY KEY(source_file_id,target_path)
);
CREATE TABLE IF NOT EXISTS arachne_access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES arachne_files(id) ON DELETE CASCADE,
  query TEXT, accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS arachne_embeddings (
  chunk_id INTEGER NOT NULL REFERENCES arachne_chunks(id) ON DELETE CASCADE,
  model TEXT NOT NULL, dimensions INTEGER NOT NULL CHECK(dimensions BETWEEN 1 AND 8192),
  vector BLOB NOT NULL CHECK(typeof(vector)='blob' AND length(vector)=dimensions*4), source_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(chunk_id,model)
);
CREATE TABLE IF NOT EXISTS arachne_sessions (
  project TEXT NOT NULL, agent TEXT NOT NULL, payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(project,agent),
  FOREIGN KEY(project,agent) REFERENCES arachne_scope_state(project,agent)
);
CREATE TABLE IF NOT EXISTS arachne_backups (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, agent TEXT NOT NULL, filename TEXT NOT NULL UNIQUE,
  label TEXT, trigger TEXT NOT NULL, created_at TEXT NOT NULL,
  file_count INTEGER NOT NULL, chunk_count INTEGER NOT NULL, size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  FOREIGN KEY(project,agent) REFERENCES arachne_scope_state(project,agent)
);
CREATE TABLE IF NOT EXISTS arachne_legacy_imports (
  source_path TEXT PRIMARY KEY, project TEXT NOT NULL, agent TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS arachne_index_jobs (
  project TEXT NOT NULL, agent TEXT NOT NULL, lease_id TEXT NOT NULL,
  process_id INTEGER NOT NULL, started_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(project,agent)
);
CREATE TABLE IF NOT EXISTS arachne_backup_jobs (
  project TEXT NOT NULL, agent TEXT NOT NULL, lease_id TEXT NOT NULL,
  process_id INTEGER NOT NULL, started_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(project,agent)
);
CREATE INDEX IF NOT EXISTS idx_arachne_files_scope ON arachne_files(project,agent,language,path);
CREATE INDEX IF NOT EXISTS idx_arachne_chunks_file ON arachne_chunks(file_id,start_line,id);
CREATE INDEX IF NOT EXISTS idx_arachne_deps_target ON arachne_dependencies(target_file_id);
CREATE INDEX IF NOT EXISTS idx_arachne_access_file ON arachne_access_log(file_id,accessed_at);
CREATE TRIGGER IF NOT EXISTS arachne_dependency_insert BEFORE INSERT ON arachne_dependencies
WHEN new.target_file_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM arachne_files source JOIN arachne_files target
    ON source.project=target.project AND source.agent=target.agent
    WHERE source.id=new.source_file_id AND target.id=new.target_file_id)
  THEN RAISE(ABORT,'Dependency target belongs to another scope') END;
END;
CREATE TRIGGER IF NOT EXISTS arachne_dependency_update BEFORE UPDATE ON arachne_dependencies
WHEN new.target_file_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM arachne_files source JOIN arachne_files target
    ON source.project=target.project AND source.agent=target.agent
    WHERE source.id=new.source_file_id AND target.id=new.target_file_id)
  THEN RAISE(ABORT,'Dependency target belongs to another scope') END;
END;
CREATE VIRTUAL TABLE IF NOT EXISTS arachne_chunks_fts USING fts5(name,content,search_text,content=arachne_chunks,content_rowid=id);
CREATE TRIGGER IF NOT EXISTS arachne_chunks_insert AFTER INSERT ON arachne_chunks BEGIN
  INSERT INTO arachne_chunks_fts(rowid,name,content,search_text) VALUES(new.id,new.name,new.content,new.search_text);
  UPDATE arachne_scope_state SET revision=revision+1 WHERE (project,agent)=(SELECT project,agent FROM arachne_files WHERE id=new.file_id);
END;
CREATE TRIGGER IF NOT EXISTS arachne_chunks_delete AFTER DELETE ON arachne_chunks BEGIN
  INSERT INTO arachne_chunks_fts(arachne_chunks_fts,rowid,name,content,search_text) VALUES('delete',old.id,old.name,old.content,old.search_text);
  UPDATE arachne_scope_state SET revision=revision+1 WHERE (project,agent)=(SELECT project,agent FROM arachne_files WHERE id=old.file_id);
END;
CREATE TRIGGER IF NOT EXISTS arachne_chunks_update AFTER UPDATE ON arachne_chunks BEGIN
  INSERT INTO arachne_chunks_fts(arachne_chunks_fts,rowid,name,content,search_text) VALUES('delete',old.id,old.name,old.content,old.search_text);
  INSERT INTO arachne_chunks_fts(rowid,name,content,search_text) VALUES(new.id,new.name,new.content,new.search_text);
  UPDATE arachne_scope_state SET revision=revision+1 WHERE (project,agent) IN
    (SELECT project,agent FROM arachne_files WHERE id IN (old.file_id,new.file_id));
END;
CREATE TRIGGER IF NOT EXISTS arachne_files_insert AFTER INSERT ON arachne_files BEGIN
  UPDATE arachne_scope_state SET revision=revision+1 WHERE project=new.project AND agent=new.agent;
END;
CREATE TRIGGER IF NOT EXISTS arachne_files_update AFTER UPDATE ON arachne_files BEGIN
  UPDATE arachne_scope_state SET revision=revision+1 WHERE (project,agent) IN ((old.project,old.agent),(new.project,new.agent));
END;
CREATE TRIGGER IF NOT EXISTS arachne_files_delete AFTER DELETE ON arachne_files BEGIN
  UPDATE arachne_scope_state SET revision=revision+1 WHERE project=old.project AND agent=old.agent;
END;
CREATE TRIGGER IF NOT EXISTS arachne_source_content AFTER UPDATE OF content,hash ON arachne_files
WHEN new.source_hash IS NOT NULL AND (old.content IS NOT new.content OR old.hash IS NOT new.hash) BEGIN
  UPDATE arachne_files SET source_hash=NULL WHERE id=new.id;
END;
CREATE TRIGGER IF NOT EXISTS arachne_source_chunk_insert AFTER INSERT ON arachne_chunks BEGIN
  UPDATE arachne_files SET source_hash=NULL WHERE id=new.file_id AND source_hash IS NOT NULL;
END;
CREATE TRIGGER IF NOT EXISTS arachne_source_chunk_delete AFTER DELETE ON arachne_chunks BEGIN
  UPDATE arachne_files SET source_hash=NULL WHERE id=old.file_id AND source_hash IS NOT NULL;
END;
CREATE TRIGGER IF NOT EXISTS arachne_source_chunk_update AFTER UPDATE ON arachne_chunks BEGIN
  UPDATE arachne_files SET source_hash=NULL WHERE id IN (old.file_id,new.file_id) AND source_hash IS NOT NULL;
END;
`;
