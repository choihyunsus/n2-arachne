// Legacy context databases migrate into one explicit owner without rewriting their source.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Database = require('better-sqlite3');
const { Store } = require('../dist/lib/store');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

function createLegacy(root, invalid = false) {
  const filename = path.join(root, 'context.db');
  const db = new Database(filename);
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT);
 CREATE TABLE files(id INTEGER PRIMARY KEY,path TEXT,hash TEXT,language TEXT,size_bytes INTEGER,chunk_count INTEGER,indexed_at TEXT,modified_at TEXT);
 CREATE TABLE chunks(id INTEGER PRIMARY KEY,file_id INTEGER,chunk_type TEXT,name TEXT,start_line INTEGER,end_line INTEGER,content TEXT,token_count INTEGER,search_text TEXT,created_at TEXT);
 CREATE TABLE dependencies(source_file_id INTEGER,target_path TEXT,target_file_id INTEGER,dep_type TEXT);
 CREATE TABLE access_log(id INTEGER PRIMARY KEY,file_id INTEGER,query TEXT,accessed_at TEXT);
 INSERT INTO meta(key,value) VALUES('schema_version','3');
 INSERT INTO files VALUES(5,'legacy.ts','hash','ts',20,1,'2026-01-01',NULL);
 INSERT INTO chunks VALUES(7,5,'module',NULL,1,1,'legacy keyword',4,'legacy keyword','2026-01-01');
 INSERT INTO dependencies VALUES(5,'external-package',NULL,'external');
 INSERT INTO access_log VALUES(1,5,'legacy query','2026-01-01');`);
  db.prepare("INSERT INTO meta(key,value) VALUES('project_dir',?)").run(root);
  if (invalid) db.prepare('UPDATE chunks SET end_line=-1').run();
  db.close();
  return filename;
}
const checksum = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('automatic import remaps IDs, preserves metadata, is idempotent and keeps the legacy file intact', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-legacy-'));
  const source = createLegacy(root);
  const hash = checksum(source);
  const store = new Store(root, {
    projectRoot: root,
    project: 'demo',
    agent: 'worker',
  });
  try {
    await store.init();
    assert.equal(store.legacyImport.status, 'imported');
    assert.equal(store.getStats().chunkCount, 1);
    const file = store.getFileByPath('legacy.ts');
    assert.equal(file.modified_at, null);
    assert.notEqual(file.id, 5);
    assert.equal(store.getChunksByFileId(file.id)[0].content, 'legacy keyword');
    assert.equal(store.getDirectDependencies(file.id)[0].target_file_id, null);
    assert.equal(store.getRecentFiles()[0].path, 'legacy.ts');
    assert.equal(store.migrateLegacy().status, 'already-imported');
    assert.equal(checksum(source), hash);
    const other = new Store(root, {
      projectRoot: root,
      project: 'demo',
      agent: 'another',
    });
    try {
      await other.init();
      assert.equal(other.legacyImport.status, 'owned-by-another-agent');
      assert.equal(other.getStats().fileCount, 0);
    } finally {
      other.close();
    }
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('invalid legacy rows roll back all imports and preserve both source and destination', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-legacy-invalid-'));
  const source = createLegacy(root, true);
  const hash = checksum(source);
  const store = new Store(root, {
    projectRoot: root,
    project: 'demo',
    agent: 'worker',
    importLegacy: false,
  });
  try {
    await store.init();
    assert.throws(() => store.migrateLegacy(), /Invalid chunk/);
    assert.equal(store.getStats().fileCount, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM arachne_legacy_imports').get().n, 0);
    assert.equal(checksum(source), hash);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('two processes importing the same source share one committed receipt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-legacy-race-'));
  const source = createLegacy(root);
  const before = checksum(source);
  const modulePath = path.resolve(__dirname, '../dist/lib/store.js');
  const script = `const {Store}=require(${JSON.stringify(modulePath)});
    const store=new Store(process.argv[1],{projectRoot:process.argv[1],project:'demo',agent:'worker'});
    store.init().then(()=>{console.log(store.legacyImport.status);store.close();}).catch(error=>{console.error(error);process.exitCode=1;});`;
  try {
    const run = () =>
      promisify(execFile)(process.execPath, ['-e', script, root], {
        timeout: 30000,
        windowsHide: true,
      });
    const results = await Promise.all([run(), run()]);
    assert.deepEqual(results.map((result) => result.stdout.trim()).sort(), [
      'already-imported',
      'imported',
    ]);
    assert.equal(checksum(source), before);
    const store = new Store(root, {
      projectRoot: root,
      project: 'demo',
      agent: 'worker',
    });
    try {
      await store.init();
      assert.equal(store.getStats().chunkCount, 1);
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('legacy vec0 caches remain readable in their original database without requiring the extension for import', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-legacy-vec-'));
  const source = createLegacy(root);
  const db = new Database(source);
  require('sqlite-vec').load(db);
  db.exec('CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[3])');
  db.prepare('INSERT INTO vec_chunks(rowid,embedding) VALUES(?,?)').run(
    7n,
    new Float32Array([1, 0, 0]),
  );
  db.close();
  const before = checksum(source);
  const store = new Store(root, {
    projectRoot: root,
    project: 'demo',
    agent: 'worker',
  });
  try {
    await store.init();
    assert.equal(store.getStats().chunkCount, 1);
    assert.equal(checksum(source), before);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM arachne_embeddings').get().n, 0);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
