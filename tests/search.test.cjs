// Search caches follow each owner and committed index revisions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Store } = require('../dist/lib/store');
const { BM25Search } = require('../dist/lib/search');
const config = { bm25: { k1: 1.2, b: 0.75 }, topK: 10 };

function insert(store, word, hash = word) {
  const id = store.upsertFile('file.ts', hash, 'ts', 10, new Date().toISOString()).fileId;
  store.insertChunks(id, [
    {
      type: 'module',
      name: null,
      startLine: 1,
      endLine: 1,
      content: word,
      tokenCount: 4,
      searchText: word,
    },
  ]);
  return id;
}
test('independent caches, same-owner writes, external writes and deletions stay consistent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-search-'));
  const make = (agent) => new Store(root, { project: 'demo', agent, projectRoot: root });
  const first = make('first'),
    second = make('second'),
    external = make('first');
  try {
    await first.init();
    await second.init();
    await external.init();
    insert(first, 'alpha 변경');
    insert(second, 'beta');
    const a = new BM25Search(first, config),
      b = new BM25Search(second, config);
    assert.equal(a.search('alpha').length, 1);
    assert.equal(b.search('beta').length, 1);
    assert.equal(a.search('alpha').length, 1);
    assert.equal(a.search('beta').length, 0);
    assert.equal(a.search('변경').length, 1);
    insert(first, 'updated');
    assert.equal(a.search('alpha').length, 0);
    assert.equal(a.search('updated').length, 1);
    insert(external, 'external');
    assert.equal(a.search('updated').length, 0);
    assert.equal(a.search('external').length, 1);
    external.removeFile('file.ts');
    assert.equal(a.search('external').length, 0);
    assert.equal(b.search('beta').length, 1);
    assert.throws(() => a.search('query', { topK: -1 }), /limit/);
    assert.throws(() => a.search('x'.repeat(4097)), /4096/);
  } finally {
    first.close();
    second.close();
    external.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('prototype-like keywords and zero limits have predictable results', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-search-words-'));
  const store = new Store(root, {
    project: 'demo',
    agent: 'worker',
    projectRoot: root,
  });
  try {
    await store.init();
    insert(store, '__proto__ constructor repeated');
    const search = new BM25Search(store, config);
    assert.equal(search.search('__proto__').length, 1);
    assert.equal(search.search('constructor').length, 1);
    assert.equal(search.search('repeated', { topK: 0 }).length, 0);
    assert(Number.isFinite(search.search('repeated '.repeat(300))[0].score));
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('cache construction and row lookup use one consistent SQLite snapshot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-search-snapshot-'));
  const options = { project: 'demo', agent: 'worker', projectRoot: root };
  const store = new Store(root, options),
    writer = new Store(root, options);
  try {
    await store.init();
    await writer.init();
    insert(store, 'alpha');
    const search = new BM25Search(store, config);
    const original = search._loadSearchData.bind(search);
    let changed = false;
    search._loadSearchData = (language) => {
      const rows = original(language);
      if (!changed) {
        changed = true;
        writer.db.prepare("UPDATE arachne_chunks SET content='beta',search_text='beta'").run();
      }
      return rows;
    };
    assert.equal(search.search('alpha')[0].chunk.content, 'alpha');
    assert.equal(search.search('alpha').length, 0);
    assert.equal(search.search('beta')[0].chunk.content, 'beta');
  } finally {
    store.close();
    writer.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('low-memory FTS search preserves owner and language filters before limiting', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-search-fts-'));
  const store = new Store(root, {
    project: 'demo',
    agent: 'worker',
    projectRoot: root,
  });
  const other = new Store(root, {
    project: 'demo',
    agent: 'another',
    projectRoot: root,
  });
  try {
    await store.init();
    await other.init();
    insert(store, '한국어 기억을 보존하는 자료');
    insert(other, '한국어 기억을 보존하는 자료');
    const search = new BM25Search(store, { ...config, maxCacheBytes: 0 });
    const result = search.search('기억', { topK: 1, language: 'ts' });
    assert.equal(result.length, 1);
    assert.equal(result[0].chunk.file_id, store.getFileByPath('file.ts').id);
    assert.equal(search.search('기억', { language: 'py' }).length, 0);
  } finally {
    store.close();
    other.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
