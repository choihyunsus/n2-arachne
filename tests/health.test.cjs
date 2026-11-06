// Graph metrics remain scoped, snapshot-consistent and safe for deep dependency chains.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../dist/lib/store');
const { buildHealthReport } = require('../dist/lib/graph-health');

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-health-'));
  const store = new Store(root, {
    projectRoot: root,
    project: 'fixture',
    agent: 'worker',
  });
  const peer = new Store(root, {
    projectRoot: root,
    project: 'fixture',
    agent: 'worker',
  });
  const other = new Store(root, {
    projectRoot: root,
    project: 'fixture',
    agent: 'other',
  });
  await store.init();
  await peer.init();
  await other.init();
  return {
    root,
    store,
    peer,
    other,
    close() {
      store.close();
      peer.close();
      other.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}
function insert(store, name) {
  return store.upsertFile(name + '.ts', 'hash', 'ts', 1, '2026-01-01').fileId;
}
function edge(store, source, target, name = String(target)) {
  store.insertDependencies(source, [{ targetPath: name, targetFileId: target, depType: 'import' }]);
}

test('health separates directed edges, peer links, unresolved imports and cyclic components', async () => {
  const f = await fixture();
  try {
    const ids = ['a', 'b', 'c', 'self', '__proto__', 'external'].map((name) =>
      insert(f.store, name),
    );
    insert(f.other, 'foreign');
    edge(f.store, ids[0], ids[1]);
    edge(f.store, ids[0], ids[1], 'alias');
    edge(f.store, ids[1], ids[2]);
    edge(f.store, ids[2], ids[0]);
    edge(f.store, ids[0], ids[2]);
    edge(f.store, ids[3], ids[3]);
    edge(f.store, ids[5], null, 'outside-package');
    f.store.db.prepare('UPDATE arachne_files SET language=NULL WHERE id=?').run(ids[5]);
    const report = buildHealthReport(f.store);
    assert.equal(report.nodeCount, 6);
    assert.equal(report.directedEdgeCount, 5);
    assert.equal(report.undirectedEdgeCount, 3);
    assert.equal(report.selfReferenceCount, 1);
    assert.equal(report.unresolvedImportCount, 1);
    assert.equal(report.orphanCount, 3);
    assert.equal(report.componentCount, 4);
    assert.equal(report.largestComponent, 3);
    assert.equal(report.cyclicComponentCount, 2);
    assert.equal(report.density, 0.2);
    assert.ok(
      report.languages.some((language) => language.language === null && language.count === 1),
    );
    assert.match(report.markdown, /__proto__\.ts/);
    assert.doesNotMatch(report.markdown, /foreign\.ts/);
    assert.equal(buildHealthReport(f.other).nodeCount, 1);
    f.store.db.exec('DROP TRIGGER arachne_dependency_insert');
    edge(f.other, f.other.getAllFiles()[0].id, null, 'original');
    f.store.db
      .prepare(
        'INSERT INTO arachne_dependencies(source_file_id,target_path,target_file_id) VALUES(?,?,?)',
      )
      .run(ids[0], 'corrupt foreign', f.other.getAllFiles()[0].id);
    assert.throws(() => buildHealthReport(f.store), /missing or foreign/);
  } finally {
    f.close();
  }
});

test('graph nodes and edges come from one consistent read snapshot', async () => {
  const f = await fixture();
  try {
    const first = insert(f.store, 'a'),
      second = insert(f.store, 'b');
    edge(f.store, first, second);
    const prepare = f.store.db.prepare;
    let changed = false;
    try {
      f.store.db.prepare = function (sql) {
        if (!changed && sql.includes('FROM arachne_dependencies')) {
          changed = true;
          f.peer.removeFile('b.ts');
        }
        return prepare.call(this, sql);
      };
      const report = buildHealthReport(f.store);
      assert.equal(report.nodeCount, 2);
      assert.equal(report.directedEdgeCount, 1);
    } finally {
      f.store.db.prepare = prepare;
    }
    const current = buildHealthReport(f.store);
    assert.equal(current.nodeCount, 1);
    assert.equal(current.directedEdgeCount, 0);
  } finally {
    f.close();
  }
});

test('deep graphs use iterative component traversal and bounded report samples', async () => {
  const f = await fixture();
  try {
    const insertFile = f.store.db.prepare(
      "INSERT INTO arachne_files(project,agent,path,hash,language) VALUES('fixture','worker',?,'hash','ts')",
    );
    const insertEdge = f.store.db.prepare(
      'INSERT INTO arachne_dependencies(source_file_id,target_path,target_file_id) VALUES(?,?,?)',
    );
    const ids = [];
    f.store.db
      .transaction(() => {
        for (let index = 0; index < 12000; index++)
          ids.push(Number(insertFile.run(`file-${index}.ts`).lastInsertRowid));
        for (let index = 1; index < ids.length; index++)
          insertEdge.run(ids[index - 1], `file-${index}.ts`, ids[index]);
        insertEdge.run(ids.at(-1), 'file-0.ts', ids[0]);
      })
      .immediate();
    const report = buildHealthReport(f.store);
    assert.equal(report.nodeCount, 12000);
    assert.equal(report.directedEdgeCount, 12000);
    assert.equal(report.componentCount, 1);
    assert.equal(report.largestComponent, 12000);
    assert.equal(report.cyclicComponentCount, 1);
    assert.equal(report.cycleSamples[0].size, 12000);
    assert.equal(report.cycleSamples[0].members.length, 10);
    assert.ok(report.markdown.length < 10000);
  } finally {
    f.close();
  }
});
