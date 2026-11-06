// Actual files exercise atomic replacement, scoped pruning, limits and same-owner concurrency.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../dist/lib/store');
const { Indexer } = require('../dist/lib/indexer');
const { BM25Search } = require('../dist/lib/search');

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-index-'));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  const config = structuredClone(require('../config.default.js'));
  config.indexing.autoIndex = false;
  config.ignore = { useGitignore: true, useContextignore: true, patterns: [] };
  config.indexing.maxFiles = 100;
  const store = new Store(path.join(root, 'data'), {
    projectRoot: source,
    project: 'demo',
    agent: 'worker',
  });
  await store.init();
  return {
    root,
    source,
    config,
    store,
    indexer: new Indexer(store, config),
    close() {
      store.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

test('dependencies resolve after the complete scan and force replacement stays inside its scope', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(
      path.join(f.source, 'a.ts'),
      "import { helper } from './z';\nexport function main() { return helper(); }",
    );
    fs.writeFileSync(path.join(f.source, 'z.ts'), "export function helper() { return 'keyword'; }");
    const first = await f.indexer.index(f.source);
    assert.equal(first.complete, true);
    assert.equal(first.indexed, 2);
    const a = f.store.getFileByPath('a.ts'),
      z = f.store.getFileByPath('z.ts');
    assert.equal(f.store.getDirectDependencies(a.id)[0].target_file_id, z.id);
    assert.equal((await f.indexer.index(f.source)).skipped, 2);
    const other = new Store(path.join(f.root, 'data'), {
      projectRoot: f.source,
      project: 'demo',
      agent: 'another',
    });
    try {
      await other.init();
      other.upsertFile('unrelated.ts', 'hash', 'ts', 1, '2026-01-01');
      assert.equal((await f.indexer.index(f.source, { force: true })).indexed, 2);
      assert.equal(other.getStats().fileCount, 1);
    } finally {
      other.close();
    }
    const search = new BM25Search(f.store, f.config.search);
    assert.equal(search.search('keyword').length, 1);
    fs.unlinkSync(path.join(f.source, 'z.ts'));
    const removed = await f.indexer.index(f.source);
    assert.equal(removed.removed, 1);
    assert.equal(f.store.getDirectDependencies(a.id)[0].target_file_id, null);
  } finally {
    f.close();
  }
});

test('default indexing excludes nested dependency/build trees and includes existing script aliases', async () => {
  const f = await fixture();
  try {
    f.config.ignore = structuredClone(require('../config.default.js').ignore);
    for (const directory of [
      'packages/child/node_modules/lib',
      'packages/child/target/debug',
      'packages/child/dist',
    ]) {
      fs.mkdirSync(path.join(f.source, directory), { recursive: true });
      fs.writeFileSync(path.join(f.source, directory, 'ignored.ts'), 'const excludedKeyword=1;');
    }
    for (const extension of ['mjs', 'cjs', 'mts', 'cts'])
      fs.writeFileSync(
        path.join(f.source, `included.${extension}`),
        'export function aliasKeyword() { return 1; }',
      );
    fs.writeFileSync(path.join(f.source, 'notes.txt'), 'plainTextKeyword');
    const result = await f.indexer.index(f.source);
    assert.equal(result.complete, true);
    assert.equal(result.indexed, 5);
    assert.ok(f.store.getAllFiles().every((file) => !file.path.includes('/')));
    for (const file of f.store.getAllFiles().filter((file) => file.path !== 'notes.txt'))
      assert.equal(f.store.getChunksByFileId(file.id)[0].name, 'aliasKeyword');
  } finally {
    f.close();
  }
});

test('partial scans retain unseen records and failed file updates retain their previous chunks', async () => {
  const f = await fixture();
  try {
    for (const file of ['one.ts', 'two.ts', 'three.ts'])
      fs.writeFileSync(path.join(f.source, file), `export const value = '${file}';`);
    await f.indexer.index(f.source);
    fs.unlinkSync(path.join(f.source, 'three.ts'));
    f.config.indexing.maxFiles = 1;
    assert.equal((await f.indexer.index(f.source)).complete, false);
    assert(f.store.getFileByPath('three.ts'));
    f.config.indexing.maxFiles = 100;
    f.store.db.exec(
      "CREATE TRIGGER injected BEFORE INSERT ON arachne_chunks WHEN new.content LIKE '%changedMarker%' BEGIN SELECT RAISE(ABORT,'injected failure'); END;",
    );
    fs.writeFileSync(path.join(f.source, 'one.ts'), 'export const changedMarker = true;');
    const result = await f.indexer.index(f.source, { force: true });
    assert.equal(result.complete, false);
    const original = f.store.getChunksByFileId(f.store.getFileByPath('one.ts').id);
    assert(original[0].content.includes('one.ts'));
    assert(f.store.getFileByPath('three.ts'));
    f.store.db.exec('DROP TRIGGER injected');
    assert.equal((await f.indexer.index(f.source)).complete, true);
    assert.equal(f.store.getFileByPath('three.ts'), undefined);
  } finally {
    f.close();
  }
});

test('negated ignore rules work, incomplete source reads are reported, and duplicate jobs fail cleanly', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.source, '.gitignore'), '*.ts\n!keep.ts\n');
    fs.writeFileSync(path.join(f.source, 'keep.ts'), 'export const keep = 1;');
    fs.writeFileSync(path.join(f.source, 'skip.ts'), 'ignored');
    const running = f.indexer.index(f.source);
    await assert.rejects(new Indexer(f.store, f.config).index(f.source), /already running/);
    assert.equal((await running).indexed, 1);
    assert.equal(f.store.getFileByPath('skip.ts'), undefined);
    fs.writeFileSync(path.join(f.source, 'keep.ts'), Buffer.from([0xff, 0xfe, 0xff]));
    assert.equal((await f.indexer.index(f.source)).complete, false);
    assert.equal(f.store.getStats().fileCount, 1);
    await assert.rejects(f.indexer.index(f.source, { subPath: '../' }), /outside/);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM arachne_index_jobs').get().n, 0);
  } finally {
    f.close();
  }
});

test('nonincremental mode replaces unchanged files and unstable source reads fail explicitly', async () => {
  const f = await fixture();
  try {
    const filename = path.join(f.source, 'changing.ts');
    fs.writeFileSync(filename, 'const marker = 1;');
    assert.equal((await f.indexer.index(f.source)).indexed, 1);
    assert.equal((await f.indexer.index(f.source)).skipped, 1);
    f.config.indexing.incremental = false;
    assert.equal((await f.indexer.index(f.source)).indexed, 1);
    const { readSource } = require('../dist/lib/scan-files');
    const read = fs.readSync;
    let changed = false;
    try {
      fs.readSync = function (...args) {
        const count = read.apply(this, args);
        if (!changed) {
          changed = true;
          fs.appendFileSync(filename, '\nchanged after read');
        }
        return count;
      };
      assert.throws(() => readSource(f.source, filename, 100000), /changed while reading/);
    } finally {
      fs.readSync = read;
    }
    f.config.indexing.chunkStrategy = 'ast';
    await assert.rejects(f.indexer.index(f.source), /AST mode is unavailable/);
  } finally {
    f.close();
  }
});
