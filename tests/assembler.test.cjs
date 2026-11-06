const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../dist/lib/store');
const { BM25Search } = require('../dist/lib/search');
const { Assembler, estimateTokens } = require('../dist/lib/assembler');
const { embeddingSourceHash } = require('../dist/lib/vector-store');

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-assemble-'));
  const store = new Store(path.join(root, 'data'), {
    projectRoot: root,
    project: 'demo',
    agent: 'worker',
  });
  await store.init();
  const search = new BM25Search(store, {
    bm25: { k1: 1.2, b: 0.75 },
    topK: 10,
  });
  return {
    root,
    store,
    search,
    close() {
      store.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}
function insert(f, filename, content) {
  fs.mkdirSync(path.dirname(path.join(f.root, filename)), { recursive: true });
  fs.writeFileSync(path.join(f.root, filename), content);
  const { fileId } = f.store.upsertFile(
    filename,
    content,
    'ts',
    Buffer.byteLength(content),
    '2026-11-07',
  );
  f.store.insertChunks(fileId, [
    {
      type: 'module',
      name: null,
      startLine: 1,
      endLine: 2,
      content,
      tokenCount: 0,
      searchText: content,
    },
  ]);
  return fileId;
}

test('rendered context stays within every budget including headings, fences, CJK and zero', async () => {
  const f = await fixture();
  try {
    insert(f, 'main.ts', 'keyword 가나다 😀 ```\n'.repeat(1000));
    insert(f, 'other.ts', 'keyword secondary');
    const assembler = new Assembler(f.store, f.search);
    for (const budget of [0, 1, 10, 80, 100, 500, 1000]) {
      const result = await assembler.assemble('keyword', {
        activeFile: 'main.ts',
        budget,
      });
      assert.equal(result.metadata.tokensUsed, estimateTokens(result.context));
      assert.ok(result.metadata.tokensUsed <= budget);
      assert.equal(result.metadata.tokensRemaining, budget - result.metadata.tokensUsed);
      assert.ok(
        Object.values(result.metadata.layers).reduce((sum, layer) => sum + layer.tokens, 0) <=
          budget,
      );
      assert.doesNotMatch(result.context, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      if (budget === 0) assert.equal(result.context, '');
    }
    const cjk = new Assembler(f.store, f.search, { tokenMultiplier: 1.5 });
    const result = await cjk.assemble('keyword', {
      budget: 500,
      activeFile: 'main.ts',
    });
    assert.equal(result.metadata.tokensUsed, estimateTokens(result.context, 1.5));
    assert.match(result.context, /\[truncated\]/);
    assert.match(result.context, /````ts/);
    assert.equal((result.context.match(/## Active File/g) ?? []).length, 1);
  } finally {
    f.close();
  }
});

test('project paths, unusual filenames and individual layer selection are handled explicitly', async () => {
  const f = await fixture();
  try {
    for (const filename of ['__proto__/x.ts', 'constructor/prototype.ts', '_private.ts'])
      insert(f, filename, 'keyword');
    const assembler = new Assembler(f.store, f.search);
    const tree = await assembler.assemble('', {
      layers: ['fixed'],
      budget: 1000,
    });
    assert.match(tree.context, /__proto__\/x.ts/);
    assert.match(tree.context, /constructor\/prototype.ts/);
    assert.match(tree.context, /_private.ts/);
    assert.equal({}.x, undefined);
    await assert.rejects(assembler.assemble('', { activeFile: '../outside' }), /normalized/);
    await assert.rejects(assembler.assemble('', { projectDir: os.tmpdir() }), /root differs/);
    await assert.rejects(assembler.assemble('', { layers: ['__proto__'] }), /layers/);
    await assert.rejects(assembler.assemble('', { budget: -1 }), /Invalid/);
    assert.throws(
      () =>
        new Assembler(f.store, f.search, {
          layers: { fixed: 1, shortTerm: 1, associative: 1, spare: 1 },
        }),
      /weights/,
    );
    assert.throws(() => new Assembler(f.store, f.search, { tokenMultiplier: 0 }), /multiplier/);
    const result = await assembler.assemble('', {
      budget: 1000,
      layers: ['fixed', 'fixed'],
    });
    assert.deepEqual(Object.keys(result.metadata.layers), ['fixed']);
  } finally {
    f.close();
  }
});

test('active-file failures use indexed chunks and unavailable semantic search reports a diagnostic', async () => {
  const f = await fixture();
  try {
    insert(f, 'missing.ts', 'keyword indexed version');
    fs.unlinkSync(path.join(f.root, 'missing.ts'));
    f.search.setVectorStore({
      isReady: false,
      getLastError: () => 'offline fixture',
    });
    const assembler = new Assembler(f.store, f.search);
    const result = await assembler.assemble('keyword', {
      activeFile: 'missing.ts',
      budget: 2000,
    });
    assert.match(result.context, /indexed version/);
    assert.ok(result.metadata.warnings.some((message) => message.includes('offline fixture')));
    assert.ok(result.metadata.warnings.some((message) => message.includes('could not be read')));
    const noHit = await assembler.assemble('unrelated', { budget: 1000 });
    assert.ok(noHit.metadata.warnings.some((message) => message.includes('offline fixture')));
    assert.equal(f.store.getRecentFiles()[0].path, 'missing.ts');
  } finally {
    f.close();
  }
});

test('hybrid results re-read keywords after provider I/O and discard vectors for changed sources', async () => {
  const f = await fixture();
  try {
    const id = insert(f, 'main.ts', 'original keyword');
    const old = f.store.getChunksByFileId(id)[0];
    const originalHash = embeddingSourceHash(old);
    f.search.setVectorStore({
      isReady: true,
      getLastError: () => null,
      async search() {
        f.store.db
          .prepare(
            "UPDATE arachne_chunks SET content='current keyword',search_text='current keyword' WHERE id=?",
          )
          .run(old.id);
        return [{ chunkId: old.id, distance: 0, sourceHash: originalHash }];
      },
    });
    const result = await f.search.hybridSearch('keyword');
    assert.equal(result.length, 1);
    assert.equal(result[0].chunk.content, 'current keyword');
    assert.equal(result[0].semanticScore, 0);
    f.search.setVectorStore({
      isReady: true,
      getLastError: () => null,
      async search() {
        f.store.removeFile('main.ts');
        throw new Error('offline after deletion');
      },
    });
    assert.deepEqual(await f.search.hybridSearch('keyword'), []);
    assert.match(f.search.getLastSemanticError(), /offline after deletion/);
  } finally {
    f.close();
  }
});
