// Exercise the public stdio entry point against an isolated HTTP embedding fixture.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Database = require('better-sqlite3');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

async function connect(root, endpoint, overrides = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(__dirname, '../dist/index.js')],
    cwd: root,
    env: {
      ...process.env,
      N2_CONTEXT_PROJECT_DIR: root,
      N2_CONTEXT_DATA_DIR: path.join(root, 'data'),
      N2_CONTEXT_DB_PATH: path.join(root, 'data', 'mimir.db'),
      N2_PROJECT: 'mcp-fixture',
      N2_AGENT_NAME: 'worker',
      N2_CONTEXT_AUTO_INDEX: 'false',
      N2_CONTEXT_EMBEDDING_ENABLED: 'true',
      N2_CONTEXT_EMBEDDING_ENDPOINT: endpoint,
      N2_CONTEXT_EMBEDDING_MODEL: 'fixture-model',
      N2_CONTEXT_EMBEDDING_TIMEOUT: '1000',
      N2_CONTEXT_BACKUP_DIR: '',
      ...overrides,
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-16000);
  });
  const client = new Client({ name: 'arachne-release-test', version: '1' });
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close();
    throw new Error(`${error.message}\n${stderr}`);
  }
  return {
    client,
    transport,
    call: (args, options) =>
      client.callTool({ name: 'n2_arachne', arguments: args }, undefined, options),
    stderr: () => stderr,
  };
}
const body = (response) =>
  response.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
function success(response) {
  assert.ok(!response.isError, body(response));
  return body(response);
}

async function eventually(check, milliseconds = 5000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('The expected state was not reached before the test deadline');
}

test('actual MCP indexes, searches, assembles, embeds, backs up, restores, paginates and restarts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-mcp-'));
  fs.writeFileSync(
    path.join(root, 'main.ts'),
    'export function fixture() { return "uniqueKeyword"; }',
  );
  fs.writeFileSync(path.join(root, 'other.ts'), 'export const second = "otherKeyword";');
  let calls = 0;
  const server = http.createServer((request, response) => {
    calls++;
    request.resume();
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ model: 'fixture-model', embeddings: [[1, 0, 0]] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  let connection;
  try {
    connection = await connect(root, endpoint);
    assert.deepEqual(
      (await connection.client.listTools()).tools.map((tool) => tool.name),
      ['n2_arachne'],
    );
    assert.match(success(await connection.call({ action: 'status' })), /Files: 0/);
    success(await connection.call({ action: 'index' }));
    const health = await connection.call({ action: 'health' });
    success(health);
    assert.equal(health.structuredContent.nodeCount, 2);
    assert.equal(health.structuredContent.agent, 'worker');
    assert.ok(calls >= 3);
    assert.match(
      success(await connection.call({ action: 'search', query: 'uniqueKeyword' })),
      /uniqueKeyword/,
    );
    assert.match(
      success(await connection.call({ action: 'files', limit: 1 })),
      /2 files, showing 1 from offset 0/,
    );
    assert.match(
      success(await connection.call({ action: 'files', limit: 1, offset: 1 })),
      /other.ts/,
    );
    const assembled = success(
      await connection.call({
        action: 'assemble',
        query: 'uniqueKeyword',
        activeFile: 'main.ts',
        budget: 1000,
      }),
    );
    assert.match(assembled, /Estimated context tokens/);
    assert.match(assembled, /uniqueKeyword/);
    const zero = success(
      await connection.call({
        action: 'assemble',
        query: 'uniqueKeyword',
        budget: 0,
      }),
    );
    assert.match(zero, /0 \/ 0 \(0% used\)/);
    assert.doesNotMatch(zero, /NaN|Infinity/);
    success(await connection.call({ action: 'embed', topK: 1 }));
    const saved = success(await connection.call({ action: 'backup', label: 'fixture' }));
    const id = saved.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)[0];
    fs.writeFileSync(
      path.join(root, 'main.ts'),
      'export function fixture() { return "replacementWord"; }',
    );
    success(await connection.call({ action: 'index' }));
    const archived = success(
      await connection.call({
        action: 'search',
        query: 'uniqueKeyword',
        searchBackups: true,
        backupId: id,
      }),
    );
    assert.match(archived, /from backup/);
    assert.match(archived, /uniqueKeyword/);
    success(await connection.call({ action: 'restore', backupId: id }));
    assert.match(
      success(await connection.call({ action: 'search', query: 'uniqueKeyword' })),
      /uniqueKeyword/,
    );
    assert.match(success(await connection.call({ action: 'status' })), /Files: 2/);
    assert.equal((await connection.call({ action: 'index', path: '..' })).isError, true);
    assert.equal(
      (await connection.call({ action: 'restore', backupId: '../escape' })).isError,
      true,
    );
    assert.equal((await connection.call({ action: 'search', query: 'x', topK: -1 })).isError, true);
    await connection.client.close();
    connection = undefined;
    connection = await connect(root, endpoint);
    assert.match(
      success(await connection.call({ action: 'search', query: 'uniqueKeyword' })),
      /uniqueKeyword/,
    );
    assert.match(connection.stderr(), /KV restored/);
    success(await connection.call({ action: 'gc', maxCount: 0 }));
    const db = new Database(path.join(root, 'data', 'mimir.db'), {
      readonly: true,
    });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM arachne_backups').get().n, 0);
      const state = JSON.parse(
        db.prepare('SELECT payload_json FROM arachne_sessions').get().payload_json,
      );
      assert.ok(state.searchHistory.length >= 4);
      assert.equal(state.agent, 'worker');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM arachne_embeddings').get().n, 2);
    } finally {
      db.close();
    }
  } finally {
    if (connection) await connection.client.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

test('actual MCP reports unavailable embeddings and partial invalid-source scans', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-mcp-errors-'));
  fs.writeFileSync(path.join(root, 'valid.ts'), 'const keyword = 1;');
  fs.writeFileSync(path.join(root, 'broken.ts'), Buffer.from([0xff, 0xfe, 0xff]));
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(503);
    response.end('fixture offline');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let connection;
  try {
    connection = await connect(root, `http://127.0.0.1:${server.address().port}`);
    await eventually(async () =>
      /Inactive/.test(success(await connection.call({ action: 'status' }))),
    );
    const index = await connection.call({ action: 'index' });
    assert.equal(index.isError, true);
    assert.match(body(index), /broken.ts/);
    assert.match(success(await connection.call({ action: 'search', query: 'keyword' })), /keyword/);
    assert.match(
      success(
        await connection.call({
          action: 'assemble',
          query: 'keyword',
          budget: 1000,
        }),
      ),
      /Semantic search unavailable/,
    );
    assert.equal((await connection.call({ action: 'embed' })).isError, true);
    assert.match(success(await connection.call({ action: 'status' })), /partial/);
    await connection.client.close();
    connection = await connect(root, `http://127.0.0.1:${server.address().port}`);
    assert.match(success(await connection.call({ action: 'status' })), /partial/);
    assert.match(
      success(await connection.call({ action: 'search', query: 'keyword' })),
      /partial or interrupted/,
    );
  } finally {
    if (connection) await connection.client.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

test('MCP connects while embeddings and automatic document indexing are still pending', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-mcp-startup-'));
  fs.writeFileSync(path.join(root, 'fixture.pdf'), 'fake fixture input');
  fs.writeFileSync(path.join(root, 'package.json'), '{"main":"worker.cjs"}');
  fs.writeFileSync(
    path.join(root, 'worker.cjs'),
    `
    const fs = require('node:fs'), path = require('node:path');
    fs.writeFileSync(path.join(__dirname, 'worker.pid'), String(process.pid));
    const timer = setInterval(() => {
      if (fs.existsSync(path.join(__dirname, 'release'))) {
        clearInterval(timer); process.stdout.write(JSON.stringify('documentKeyword'));
      }
    }, 20);`,
  );
  const pending = [];
  const server = http.createServer((request, response) => {
    request.resume();
    pending.push(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let connection;
  try {
    connection = await connect(root, `http://127.0.0.1:${server.address().port}`, {
      N2_CONTEXT_AUTO_INDEX: 'true',
      N2_CONTEXT_EMBEDDING_TIMEOUT: '10000',
      N2_ARACHNE_DOCUMENT_WORKER: process.execPath,
    });
    await eventually(() => pending.length > 0 && fs.existsSync(path.join(root, 'worker.pid')));
    const status = success(await connection.call({ action: 'status' }));
    assert.match(status, /Checking service/);
    assert.match(status, /Index running true/);
    for (const action of ['search', 'assemble']) {
      const result = await connection.call({ action, query: 'keyword' });
      assert.equal(result.isError, true);
      assert.match(body(result), /Indexing is in progress/);
    }
    fs.writeFileSync(path.join(root, 'release'), 'ready');
    for (const response of pending) {
      response.writeHead(503);
      response.end('offline fixture');
    }
    await eventually(async () =>
      /Index running false/.test(success(await connection.call({ action: 'status' }))),
    );
    assert.match(
      success(await connection.call({ action: 'search', query: 'documentKeyword' })),
      /documentKeyword/,
    );
    assert.match(success(await connection.call({ action: 'status' })), /Inactive/);
  } finally {
    if (connection) await connection.client.close();
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

test('MCP cancellation kills its document worker, releases the lease and supports retry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-mcp-cancel-'));
  fs.writeFileSync(path.join(root, 'fixture.pdf'), 'fake fixture input');
  fs.writeFileSync(path.join(root, 'package.json'), '{"main":"worker.cjs"}');
  fs.writeFileSync(
    path.join(root, 'worker.cjs'),
    `require('node:fs').writeFileSync(require('node:path').join(__dirname,'worker.pid'),String(process.pid));setInterval(()=>{},1000);`,
  );
  let connection;
  try {
    connection = await connect(root, 'http://127.0.0.1:1', {
      N2_CONTEXT_EMBEDDING_ENABLED: 'false',
      N2_ARACHNE_DOCUMENT_WORKER: process.execPath,
    });
    const controller = new AbortController();
    const running = connection.call({ action: 'index' }, { signal: controller.signal });
    const rejected = assert.rejects(running, /cancel|abort/i);
    await eventually(() => fs.existsSync(path.join(root, 'worker.pid')));
    const pid = Number(fs.readFileSync(path.join(root, 'worker.pid'), 'utf8'));
    controller.abort();
    await rejected;
    await eventually(async () =>
      /Index running false/.test(success(await connection.call({ action: 'status' }))),
    );
    await eventually(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return error.code === 'ESRCH';
      }
    });
    const db = new Database(path.join(root, 'data', 'mimir.db'), {
      readonly: true,
    });
    try {
      assert.equal(db.prepare('SELECT count(*) n FROM arachne_index_jobs').get().n, 0);
    } finally {
      db.close();
    }
    fs.writeFileSync(
      path.join(root, 'worker.cjs'),
      'process.stdout.write(JSON.stringify("retriedKeyword"));',
    );
    success(await connection.call({ action: 'index' }));
    assert.match(
      success(await connection.call({ action: 'search', query: 'retriedKeyword' })),
      /retriedKeyword/,
    );
    const exited = new Promise((resolve) => connection.transport._process.once('exit', resolve));
    connection.transport._process.stdin.end();
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Server did not stop on stdin EOF')), 3000);
        timer.unref();
      }),
    ]);
  } finally {
    if (connection) await connection.client.close();
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});
