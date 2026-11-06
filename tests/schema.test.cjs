// Common-memory interoperability and module version ownership.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initializeSchema } = require('../dist/lib/schema');
const { SOUL_SCHEMA_SQL } = require('../dist/lib/soul-schema');

test('shared initialization preserves common fields, existing data and future versions', () => {
  const db = new Database(':memory:');
  try {
    db.exec(SOUL_SCHEMA_SQL);
    db.prepare(
      `INSERT INTO experiences(id,agent,project,type,category,context,action,outcome)
      VALUES('existing','worker','demo','success','testing','original','original','original')`,
    ).run();
    const columns = db.pragma('table_info(experiences)');
    initializeSchema(db);
    assert.deepEqual(db.pragma('table_info(experiences)'), columns);
    assert.equal(db.prepare('SELECT context FROM experiences').get().context, 'original');
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '2');
    db.prepare("UPDATE meta SET value='999' WHERE key='arachne_schema_version'").run();
    assert.throws(() => initializeSchema(db), /Unsupported Arachne/);
    assert.equal(
      db.prepare("SELECT value FROM meta WHERE key='arachne_schema_version'").get().value,
      '999',
    );
  } finally {
    db.close();
  }
});

test('future common schema and legacy unscoped tables are preserved on rejection', () => {
  for (const setup of [
    "CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);INSERT INTO meta VALUES('schema_version','999')",
    'CREATE TABLE arachne_files(path TEXT PRIMARY KEY)',
  ]) {
    const db = new Database(':memory:');
    try {
      db.exec(setup);
      const before = db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all();
      assert.throws(() => initializeSchema(db), /Unsupported|migration/);
      assert.deepEqual(
        db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(),
        before,
      );
    } finally {
      db.close();
    }
  }
});

test('scope revisions, FTS and dependency owner constraints follow committed writes', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    initializeSchema(db);
    for (const agent of ['first', 'second']) {
      db.prepare(
        "INSERT INTO arachne_scope_state(project,agent,root) VALUES('demo',?,'fixture')",
      ).run(agent);
      db.prepare(
        "INSERT INTO arachne_files(project,agent,path,hash) VALUES('demo',?,'file.ts','hash')",
      ).run(agent);
    }
    assert.throws(
      () => db.prepare("INSERT INTO arachne_dependencies VALUES(1,'file.ts',2,'import')").run(),
      /another scope/,
    );
    db.prepare(
      `INSERT INTO arachne_chunks(file_id,chunk_type,start_line,end_line,content,token_count,search_text)
      VALUES(1,'module',1,1,'uniqueAlpha',4,'uniqueAlpha')`,
    ).run();
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM arachne_chunks_fts WHERE arachne_chunks_fts MATCH 'uniqueAlpha'",
        )
        .get().n,
      1,
    );
    const revision = db
      .prepare("SELECT revision FROM arachne_scope_state WHERE agent='first'")
      .get().revision;
    db.prepare(
      "UPDATE arachne_chunks SET content='uniqueBeta',search_text='uniqueBeta' WHERE id=1",
    ).run();
    assert(
      db.prepare("SELECT revision FROM arachne_scope_state WHERE agent='first'").get().revision >
        revision,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM arachne_chunks_fts WHERE arachne_chunks_fts MATCH 'uniqueAlpha'",
        )
        .get().n,
      0,
    );
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO arachne_embeddings(chunk_id,model,dimensions,vector,source_hash) VALUES(1,'model',3,x'00','hash')",
          )
          .run(),
      /CHECK/,
    );
    db.prepare('DELETE FROM arachne_files WHERE id=1').run();
    assert.equal(db.prepare('SELECT count(*) AS n FROM arachne_chunks').get().n, 0);
  } finally {
    db.close();
  }
});
