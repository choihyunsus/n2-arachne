const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { Store } = require('../dist/lib/store');
const { Backup } = require('../dist/lib/backup');
const { BM25Search } = require('../dist/lib/search');
const { acquireIndex, acquireBackup } = require('../dist/lib/index-lock');
const { hashFile } = require('../dist/lib/snapshot');

const config = {
  enabled: true,
  dir: '',
  maxBackups: 10,
  maxAgeDays: 30,
  autoBackupOnReindex: true,
  externalBackupDir: null,
};
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-backup-'));
  const store = new Store(root, {
    projectRoot: root,
    project: 'demo',
    agent: 'one',
  });
  const other = new Store(root, {
    projectRoot: root,
    project: 'demo',
    agent: 'two',
  });
  await store.init();
  await other.init();
  return {
    root,
    store,
    other,
    backup: new Backup(store, config),
    close() {
      store.close();
      other.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}
function insert(store, filename, content) {
  const { fileId } = store.upsertFile(filename, content, 'ts', content.length, '2026-11-07', true);
  store.insertChunks(fileId, [
    {
      type: 'module',
      name: null,
      startLine: 1,
      endLine: 1,
      content,
      tokenCount: 4,
      searchText: content,
    },
  ]);
  store.db.prepare('UPDATE arachne_files SET content=? WHERE id=?').run(content, fileId);
  return fileId;
}
function file(f, id) {
  return f.store.db.prepare('SELECT filename FROM arachne_backups WHERE id=?').get(id).filename;
}

test('backup and live restore isolate owners, preserve Soul, remap references and refresh search', async () => {
  const f = await fixture();
  try {
    const first = insert(f.store, 'a.ts', 'original keyword');
    const target = insert(f.store, 'b.ts', 'target');
    const foreign = insert(f.other, 'secret.ts', 'private-other-agent');
    f.store.insertDependencies(first, [
      { targetPath: 'b.ts', targetFileId: target, depType: 'import' },
    ]);
    f.store.logAccess(first, 'lookup');
    f.store._setMeta('fixture', 'original');
    f.store.db.exec(
      "CREATE TABLE unrelated(id TEXT PRIMARY KEY,content TEXT); INSERT INTO unrelated VALUES('private','Soul memory must survive')",
    );
    f.store.db
      .prepare('INSERT INTO arachne_sessions(project,agent,payload_json) VALUES(?,?,?)')
      .run('demo', 'one', '{"searchHistory":[]}');
    const oldChunk = f.store.getChunksByFileId(first)[0].id;
    f.store.db
      .prepare(
        'INSERT INTO arachne_embeddings(chunk_id,model,dimensions,vector,source_hash) VALUES(?,?,?,?,?)',
      )
      .run(oldChunk, 'fixture', 2, Buffer.from(new Float32Array([1, 0]).buffer), 'source');
    const snapshot = await f.backup.create('before');
    const db = new Database(file(f, snapshot.id), { readonly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM arachne_files').get().n, 2);
      assert.equal(
        db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='unrelated'").get().n,
        0,
      );
      assert.equal(db.prepare('SELECT COUNT(*) n FROM experiences').get().n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM arachne_backups').get().n, 0);
    } finally {
      db.close();
    }
    assert.equal(f.backup.searchBackup(snapshot.id, 'original')[0].file_path, 'a.ts');
    assert.equal(f.backup.searchBackup(snapshot.id, '%').length, 0);
    insert(f.store, 'a.ts', 'replacement keyword');
    insert(f.store, 'new.ts', 'created later');
    const search = new BM25Search(f.store, {
      topK: 10,
      k1: 1.5,
      b: 0.75,
      recencyBoost: 0,
      importanceBoost: 0,
    });
    assert.equal(search.search('replacement').length, 1);
    await f.backup.restore(snapshot.id);
    assert.equal(f.store.db.open, true);
    assert.equal(f.store.getStats().fileCount, 2);
    assert.equal(search.search('replacement').length, 0);
    assert.equal(search.search('original').length, 1);
    assert.equal(f.other.getFileByPath('secret.ts').id, foreign);
    assert.equal(
      f.store.db.prepare('SELECT content FROM unrelated').get().content,
      'Soul memory must survive',
    );
    const restored = f.store.getFileByPath('a.ts');
    assert.notEqual(restored.id, first);
    assert.equal(
      f.store.getDirectDependencies(restored.id)[0].target_file_id,
      f.store.getFileByPath('b.ts').id,
    );
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM arachne_embeddings').get().n, 1);
    assert.equal(f.store.getRecentFiles()[0].path, 'a.ts');
    assert.equal(f.store.getMeta('fixture'), 'original');
    await f.backup.restore(snapshot.id);
    assert.equal(f.store.getStats().chunkCount, 2);
    f.store.close();
    await f.store.init();
    assert.equal(f.backup.list().length, 1);
    assert.equal(f.store.getStats().fileCount, 2);
  } finally {
    f.close();
  }
});

test('restore refuses foreign references, invalid snapshots and running maintenance atomically', async () => {
  const f = await fixture();
  try {
    const id = insert(f.store, 'a.ts', 'original');
    const snapshot = await f.backup.create();
    f.store.db.exec(
      'CREATE TABLE external_refs(file_id INTEGER REFERENCES arachne_files(id) ON DELETE CASCADE)',
    );
    f.store.db.prepare('INSERT INTO external_refs VALUES(?)').run(id);
    await assert.rejects(f.backup.restore(snapshot.id), /invalidate references/);
    assert.equal(f.store.getFileByPath('a.ts').id, id);
    f.store.db.exec('DELETE FROM external_refs');
    let release = acquireIndex(f.store);
    try {
      await assert.rejects(f.backup.restore(snapshot.id), /already running/);
    } finally {
      release();
    }
    release = acquireBackup(f.store);
    try {
      await assert.rejects(f.backup.create(), /already running/);
    } finally {
      release();
    }
    const snapshotFile = file(f, snapshot.id);
    const source = new Database(snapshotFile);
    source.prepare("UPDATE meta SET value='999' WHERE key='arachne_schema_version'").run();
    source.close();
    await assert.rejects(f.backup.restore(snapshot.id), /checksum/);
    f.store.db
      .prepare('UPDATE arachne_backups SET sha256=? WHERE id=?')
      .run(hashFile(snapshotFile).sha256, snapshot.id);
    await assert.rejects(f.backup.restore(snapshot.id), /schema/);
    assert.equal(f.store.getFileByPath('a.ts').id, id);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM arachne_backup_jobs').get().n, 0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM arachne_index_jobs').get().n, 0);
  } finally {
    f.close();
  }
});

test('unique snapshots recover a catalog interruption and GC preserves unrelated files', async () => {
  const f = await fixture();
  try {
    insert(f.store, 'a.ts', 'keyword');
    const one = await f.backup.create();
    const two = await f.backup.create();
    assert.notEqual(one.id, two.id);
    const filename = file(f, one.id);
    f.store.db.prepare('DELETE FROM arachne_backups WHERE id=?').run(one.id);
    assert.equal(f.backup.recover(), 1);
    assert.equal(f.backup.recover(), 0);
    fs.writeFileSync(path.join(f.backup.directory, 'notes.txt'), 'keep');
    const foreignBackup = new Backup(f.other, config);
    const foreign = await foreignBackup.create();
    assert.equal(f.backup.list().length, 2);
    const dest = path.join(f.root, 'export');
    assert.ok(f.backup.exportTo(dest));
    assert.throws(() => f.backup.exportTo(dest), /exist/i);
    assert.equal(await f.backup.gc(30, 1), 1);
    assert.equal(await f.backup.gc(30, 0), 1);
    assert.equal(fs.existsSync(filename), false);
    assert.equal(fs.readFileSync(path.join(f.backup.directory, 'notes.txt'), 'utf8'), 'keep');
    assert.equal(foreignBackup.list()[0].id, foreign.id);
    await assert.rejects(f.backup.gc(-1, 10), /Invalid/);
  } finally {
    f.close();
  }
});

test('legacy backup IDs restore through copy-only migration and original backup files survive GC', async () => {
  const f = await fixture();
  try {
    const directory = path.join(f.root, 'backups');
    fs.mkdirSync(directory);
    const id = '2026-01-01-000000';
    const filename = `context-${id}.db`;
    const sourcePath = path.join(directory, filename);
    const legacy = new Database(sourcePath);
    legacy.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE files(id INTEGER PRIMARY KEY,path TEXT,hash TEXT,language TEXT,size_bytes INTEGER,chunk_count INTEGER,indexed_at TEXT,modified_at TEXT);
      CREATE TABLE chunks(id INTEGER PRIMARY KEY,file_id INTEGER,chunk_type TEXT,name TEXT,start_line INTEGER,end_line INTEGER,content TEXT,token_count INTEGER,search_text TEXT,created_at TEXT);
      INSERT INTO meta VALUES('schema_version','3');
      INSERT INTO files VALUES(1,'old.ts','hash','ts',7,1,'2026-01-01',NULL);
      INSERT INTO chunks VALUES(1,1,'module',NULL,1,1,'oldword',3,'oldword','2026-01-01');`);
    legacy.prepare("INSERT INTO meta VALUES('project_dir',?)").run(f.root);
    legacy.close();
    const original = hashFile(sourcePath);
    fs.writeFileSync(
      path.join(directory, 'backups.json'),
      JSON.stringify({
        backups: [
          {
            id,
            filename,
            label: 'legacy',
            trigger: 'manual',
            created_at: '2026-01-01T00:00:00Z',
            file_count: 1,
            chunk_count: 1,
            size_bytes: original.size,
          },
        ],
      }),
    );
    insert(f.store, 'new.ts', 'new');
    insert(f.other, 'foreign.ts', 'foreign');
    assert.equal(f.backup.list()[0].id, id);
    assert.equal(f.backup.searchBackup(id, 'oldword')[0].file_path, 'old.ts');
    await f.backup.restore(id);
    assert.equal(f.store.getFileByPath('new.ts'), undefined);
    assert.equal(f.store.getAllFiles()[0].path, 'old.ts');
    assert.equal(f.other.getAllFiles()[0].path, 'foreign.ts');
    const otherBackup = new Backup(f.other, config);
    assert.equal(otherBackup.list().length, 0);
    await assert.rejects(otherBackup.restore(id), /not found/);
    assert.equal(await f.backup.gc(0, 0), 0);
    assert.deepEqual(hashFile(sourcePath), original);
    const fresh = await f.backup.create('converted');
    await f.backup.restore(fresh.id);
    assert.equal(f.store.getStats().chunkCount, 1);
  } finally {
    f.close();
  }
});

test('a bad copied row rolls back restore and custom snapshot directories are isolated', async () => {
  const f = await fixture();
  try {
    const custom = new Backup(f.store, {
      ...config,
      dir: path.join(f.root, 'custom'),
    });
    const originalId = insert(f.store, 'a.ts', 'original');
    const snapshot = await custom.create();
    const sourcePath = file(f, snapshot.id);
    assert.equal(
      path.dirname(sourcePath),
      path.join(f.root, 'custom', path.basename(f.store.backupDir)),
    );
    const invalid = new Database(sourcePath);
    invalid.prepare("UPDATE arachne_files SET path='../outside'").run();
    invalid.close();
    const digest = hashFile(sourcePath);
    f.store.db
      .prepare('UPDATE arachne_backups SET sha256=?,size_bytes=? WHERE id=?')
      .run(digest.sha256, digest.size, snapshot.id);
    await assert.rejects(custom.restore(snapshot.id), /normalized/);
    assert.equal(f.store.getFileByPath('a.ts').id, originalId);
    assert.equal(f.store.getChunksByFileId(originalId)[0].content, 'original');
  } finally {
    f.close();
  }
});

test('configured external copies verify their content and failures preserve the local snapshot', async () => {
  const f = await fixture();
  try {
    insert(f.store, 'a.ts', 'keyword');
    const directory = path.join(f.root, 'external');
    const automatic = new Backup(f.store, {
      ...config,
      externalBackupDir: directory,
    });
    const result = await automatic.create();
    assert.equal(result.exportedTo, path.join(directory, result.filename));
    assert.deepEqual(hashFile(result.exportedTo), hashFile(file(f, result.id)));
    const blocked = path.join(f.root, 'blocked');
    fs.writeFileSync(blocked, 'existing user file');
    const failing = new Backup(f.store, {
      ...config,
      externalBackupDir: blocked,
    });
    await assert.rejects(failing.create(), /saved locally.*External export failed/);
    assert.equal(failing.list().length, 2);
    assert.equal(fs.readFileSync(blocked, 'utf8'), 'existing user file');
    await failing.restore();
    assert.equal(f.store.getStats().fileCount, 1);
  } finally {
    f.close();
  }
});

test('old version-one tables and snapshots gain nullable fingerprints without losing source data', async () => {
  const f = await fixture();
  try {
    insert(f.store, 'a.ts', 'original');
    const saved = await f.backup.create();
    const sourcePath = file(f, saved.id);
    const old = new Database(sourcePath);
    old.exec(
      'DROP TRIGGER arachne_source_content; DROP TRIGGER arachne_source_chunk_insert; DROP TRIGGER arachne_source_chunk_delete; DROP TRIGGER arachne_source_chunk_update; ALTER TABLE arachne_files DROP COLUMN source_hash;',
    );
    old.close();
    const digest = hashFile(sourcePath);
    f.store.db
      .prepare('UPDATE arachne_backups SET sha256=?,size_bytes=? WHERE id=?')
      .run(digest.sha256, digest.size, saved.id);
    await f.backup.restore(saved.id);
    assert.equal(f.store.getAllFiles()[0].source_hash, null);
    assert.equal(f.store.getChunksByFileId(f.store.getAllFiles()[0].id)[0].content, 'original');
    f.store.db.exec(
      'DROP TRIGGER arachne_source_content; DROP TRIGGER arachne_source_chunk_insert; DROP TRIGGER arachne_source_chunk_delete; DROP TRIGGER arachne_source_chunk_update; ALTER TABLE arachne_files DROP COLUMN source_hash;',
    );
    f.store.close();
    await f.store.init();
    assert.ok(
      f.store.db
        .pragma('table_info(arachne_files)')
        .some((column) => column.name === 'source_hash'),
    );
    assert.equal(f.store.getAllFiles()[0].source_hash, null);
  } finally {
    f.close();
  }
});

test('snapshot resource caps roll back copies while restore allows a large unrelated host database', async () => {
  const f = await fixture();
  const destination = new Database(':memory:');
  const { initializeSchema } = require('../dist/lib/schema');
  const { copyScope } = require('../dist/lib/snapshot');
  const { MAX_SNAPSHOT_BYTES } = require('../dist/lib/file-hash');
  try {
    insert(f.store, 'a.ts', 'oversized-payload-fixture');
    initializeSchema(destination);
    destination.pragma('foreign_keys=ON');
    destination
      .prepare('INSERT INTO arachne_scope_state(project,agent,root) VALUES(?,?,?)')
      .run(f.store.project, f.store.agent, f.store.projectRoot);
    const copy = (limit) =>
      destination.transaction(() => copyScope(f.store.db, destination, f.store, limit)).immediate();
    const length = Buffer.byteLength;
    try {
      Buffer.byteLength = (value, ...args) =>
        value === 'oversized-payload-fixture' ? MAX_SNAPSHOT_BYTES + 1 : length(value, ...args);
      assert.throws(() => copy(true), /content exceeds/);
    } finally {
      Buffer.byteLength = length;
    }
    assert.equal(destination.prepare('SELECT COUNT(*) n FROM arachne_files').get().n, 0);
    const pragma = destination.pragma;
    try {
      destination.pragma = function (name, ...args) {
        return name === 'page_count' ? MAX_SNAPSHOT_BYTES : pragma.call(this, name, ...args);
      };
      assert.throws(() => copy(true), /database exceeds/);
      assert.equal(destination.prepare('SELECT COUNT(*) n FROM arachne_files').get().n, 0);
      assert.equal(copy(false).files, 1);
    } finally {
      destination.pragma = pragma;
    }
    assert.equal(f.store.getStats().fileCount, 1);
  } finally {
    destination.close();
    f.close();
  }
});
