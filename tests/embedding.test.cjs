// Real loopback HTTP fixtures verify provider contracts without external model calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Embedding } = require('../dist/lib/embedding');
const { VectorStore } = require('../dist/lib/vector-store');
const { Store } = require('../dist/lib/store');
const { readResponseText } = require('../dist/lib/http');

test('a transport with stalled cancellation cannot extend the response byte-limit failure', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(20));
    },
    cancel() {
      return new Promise(() => {});
    },
  });
  let timer;
  try {
    await assert.rejects(
      Promise.race([
        readResponseText(new Response(stream), 10),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Cancellation stalled')), 1000);
        }),
      ]),
      /byte limit/,
    );
  } finally {
    clearTimeout(timer);
  }
});

async function provider() {
  const state = {
    mode: 'normal',
    requests: [],
    dimensions: 3,
    beforeReply: null,
  };
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const body = JSON.parse(raw);
      state.requests.push({ path: request.url, body });
      if (state.mode === 'failure') {
        response.writeHead(503).end();
        return;
      }
      if (state.mode === 'large') {
        response.end(' '.repeat(5 * 1048576));
        return;
      }
      if (state.mode === 'hang') {
        response.writeHead(200);
        response.write('{');
        return;
      }
      if (state.mode === 'legacy' && request.url.endsWith('/embed')) {
        response.writeHead(404).end();
        return;
      }
      const input = body.input ?? body.prompt;
      state.beforeReply?.(input);
      let vector = input.includes('banana') ? [0, 1, 0] : [1, 0, 0];
      vector = vector.slice(0, state.dimensions);
      if (state.mode === 'zero') vector = vector.map(() => 0);
      const data = request.url.endsWith('/embeddings')
        ? { embedding: vector }
        : {
            model: state.mode === 'wrong-model' ? 'unexpected' : body.model,
            embeddings: [vector],
          };
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(data));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    endpoint: `http://127.0.0.1:${server.address().port}/nested/api`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('modern and legacy APIs preserve endpoint prefixes and reject invalid models/vectors', async () => {
  const fixture = await provider();
  const client = new Embedding({
    model: 'fixture',
    endpoint: fixture.endpoint,
    timeoutMs: 1000,
  });
  try {
    assert.deepEqual(await client.embed('apple'), [1, 0, 0]);
    assert.equal(fixture.state.requests[0].path, '/nested/api/embed');
    assert.equal(fixture.state.requests[0].body.truncate, false);
    fixture.state.mode = 'legacy';
    assert.deepEqual(await client.embed('banana'), [0, 1, 0]);
    assert(fixture.state.requests.some((request) => request.path === '/nested/api/embeddings'));
    fixture.state.mode = 'wrong-model';
    await assert.rejects(client.embed('apple'), /model differs/);
    fixture.state.mode = 'zero';
    await assert.rejects(client.embed('apple'), /zero norm/);
    fixture.state.mode = 'normal';
    client.resetAvailability();
    assert.equal(await client.isAvailable(), true);
  } finally {
    await fixture.close();
  }
});

test('response bodies and body-reading time are bounded', async () => {
  const fixture = await provider();
  const client = new Embedding({
    model: 'fixture',
    endpoint: fixture.endpoint,
    timeoutMs: 100,
  });
  try {
    fixture.state.mode = 'large';
    await assert.rejects(client.embed('apple'), /byte limit/);
    fixture.state.mode = 'hang';
    await assert.rejects(client.embed('apple'));
    fixture.state.mode = 'normal';
    client.resetAvailability();
    assert.equal(await client.isAvailable(), true);
  } finally {
    await fixture.close();
  }
});

function insert(store, name, word) {
  const id = store.upsertFile(name, 'hash', 'ts', word.length, '2026-01-01').fileId;
  store.insertChunks(id, [
    {
      type: 'module',
      name: null,
      startLine: 1,
      endLine: 1,
      content: word,
      tokenCount: 2,
      searchText: word,
    },
  ]);
  return store.getChunksByFileId(id)[0].id;
}

test('vector batches restart, filter owners/models and preserve existing data on provider failure', async () => {
  const fixture = await provider();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-vectors-'));
  const first = new Store(root, {
    project: 'demo',
    agent: 'first',
    projectRoot: root,
  });
  const other = new Store(root, {
    project: 'demo',
    agent: 'other',
    projectRoot: root,
  });
  const client = new Embedding({
    model: 'fixture',
    endpoint: fixture.endpoint,
  });
  const vectors = new VectorStore(first, client);
  try {
    await first.init();
    await other.init();
    const apple = insert(first, 'apple.ts', 'apple'),
      banana = insert(first, 'banana.ts', 'banana');
    insert(other, 'foreign.ts', 'apple');
    assert.equal((await vectors.embedNewChunks(1)).remaining, 1);
    assert.equal((await vectors.embedNewChunks(1)).complete, true);
    assert.equal(vectors.getEmbeddedCount(), 2);
    const results = await vectors.search('apple', 1);
    assert.equal(results[0].chunkId, apple);
    assert.equal(results[0].distance, 0);
    const before = first.db
      .prepare('SELECT hex(vector) AS vector FROM arachne_embeddings WHERE chunk_id=?')
      .get(apple).vector;
    fixture.state.mode = 'failure';
    await assert.rejects(vectors.embedNewChunks(), /503/);
    assert.equal(
      first.db
        .prepare('SELECT hex(vector) AS vector FROM arachne_embeddings WHERE chunk_id=?')
        .get(apple).vector,
      before,
    );
    fixture.state.mode = 'normal';
    fixture.state.dimensions = 2;
    const reset = new VectorStore(
      first,
      new Embedding({ model: 'fixture', endpoint: fixture.endpoint }),
    );
    assert.equal((await reset.embedNewChunks()).embedded, 2);
    assert.equal((await reset.search('banana', 1))[0].chunkId, banana);
    const different = new VectorStore(
      first,
      new Embedding({ model: 'different', endpoint: fixture.endpoint }),
    );
    assert.deepEqual(await different.search('apple'), []);
    assert.equal(
      new VectorStore(
        other,
        new Embedding({ model: 'fixture', endpoint: fixture.endpoint }),
      ).getEmbeddedCount(),
      0,
    );
  } finally {
    first.close();
    other.close();
    await fixture.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('an embedding response cannot overwrite a concurrently changed chunk', async () => {
  const fixture = await provider();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-vector-race-'));
  const store = new Store(root, {
    project: 'demo',
    agent: 'worker',
    projectRoot: root,
  });
  try {
    await store.init();
    const id = insert(store, 'apple.ts', 'apple');
    const vectors = new VectorStore(
      store,
      new Embedding({ model: 'fixture', endpoint: fixture.endpoint }),
    );
    fixture.state.beforeReply = (input) => {
      if (input.includes('apple')) {
        fixture.state.beforeReply = null;
        store.db
          .prepare("UPDATE arachne_chunks SET content='banana',search_text='banana' WHERE id=?")
          .run(id);
      }
    };
    const stale = await vectors.embedNewChunks();
    assert.equal(stale.embedded, 0);
    assert.equal(stale.remaining, 1);
    assert.equal(vectors.getEmbeddedCount(), 0);
    assert.equal((await vectors.embedNewChunks()).embedded, 1);
    store.close();
    await store.init();
    const restored = new VectorStore(
      store,
      new Embedding({ model: 'fixture', endpoint: fixture.endpoint }),
    );
    assert.equal((await restored.search('banana', 1))[0].chunkId, id);
    store.db.prepare('UPDATE arachne_embeddings SET vector=zeroblob(12)').run();
    await assert.rejects(restored.search('banana'), /zero norm/);
    assert.equal((await restored.embedNewChunks()).embedded, 1);
  } finally {
    store.close();
    await fixture.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('hybrid requests retain keyword results and report an unavailable semantic provider', async () => {
  const fixture = await provider();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-hybrid-'));
  const store = new Store(root, {
    project: 'demo',
    agent: 'worker',
    projectRoot: root,
  });
  const { BM25Search } = require('../dist/lib/search');
  try {
    await store.init();
    insert(store, 'apple.ts', 'apple');
    const vectors = new VectorStore(
      store,
      new Embedding({ model: 'fixture', endpoint: fixture.endpoint }),
    );
    await vectors.init();
    const search = new BM25Search(store, {
      bm25: { k1: 1.2, b: 0.75 },
      topK: 10,
    });
    search.setVectorStore(vectors);
    fixture.state.mode = 'failure';
    const results = await search.hybridSearch('apple');
    assert.equal(results.length, 1);
    assert.equal(results[0].semanticScore, 0);
    assert.match(search.getLastSemanticError(), /503/);
    await assert.rejects(search.hybridSearch('apple', { alpha: -1 }), /weight/);
  } finally {
    store.close();
    await fixture.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('embedding preserves text beyond 2000 characters and detects late source changes', async () => {
  const fixture = await provider();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-vector-tail-'));
  const store = new Store(root, {
    project: 'demo',
    agent: 'worker',
    projectRoot: root,
  });
  try {
    await store.init();
    const text = 'prefix '.repeat(400) + 'banana';
    const id = insert(store, 'long.ts', text);
    const vectors = new VectorStore(
      store,
      new Embedding({ model: 'fixture', endpoint: fixture.endpoint }),
    );
    assert.equal((await vectors.embedNewChunks()).embedded, 1);
    assert.ok(fixture.state.requests.some((request) => request.body.input?.endsWith('banana')));
    store.db
      .prepare('UPDATE arachne_chunks SET content=? WHERE id=?')
      .run(text.replace('banana', 'apple'), id);
    assert.equal((await vectors.embedNewChunks()).embedded, 1);
    assert.ok(fixture.state.requests.some((request) => request.body.input?.endsWith('apple')));
    store.db.prepare('UPDATE arachne_chunks SET content=? WHERE id=?').run('x'.repeat(70000), id);
    await assert.rejects(vectors.embedNewChunks(), /Re-index/);
    assert.equal(vectors.getEmbeddedCount(), 1);
  } finally {
    store.close();
    await fixture.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('vector initialization is shared and duplicate embedding jobs fail before writing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-vector-jobs-'));
  const store = new Store(root, {
    project: 'demo',
    agent: 'worker',
    projectRoot: root,
  });
  let release,
    calls = 0;
  const provider = {
    model: 'fixture',
    dimensions: 2,
    resetAvailability() {},
    getLastError: () => null,
    isAvailable: () => {
      calls++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    embed: async () => [1, 0],
  };
  try {
    await store.init();
    insert(store, 'one.ts', 'keyword');
    const vectors = new VectorStore(store, provider);
    const first = vectors.init(),
      second = vectors.init();
    assert.equal(calls, 1);
    assert.equal(vectors.isInitializing, true);
    release(true);
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(vectors.isInitializing, false);
    const batch = vectors.embedNewChunks();
    assert.equal(vectors.isEmbedding, true);
    await assert.rejects(vectors.embedNewChunks(), /already running/);
    release(true);
    assert.equal((await batch).embedded, 1);
    assert.equal(vectors.isEmbedding, false);
    assert.equal(vectors.getEmbeddedCount(), 1);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
