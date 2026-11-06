// Real worker processes cover document extraction, indexing, cancellation and cleanup.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { zip, pdf } = require('./document-fixtures.cjs');
const { extractDocument } = require('../dist/lib/document-worker');
const { Store } = require('../dist/lib/store');
const { Indexer } = require('../dist/lib/indexer');
const { BM25Search } = require('../dist/lib/search');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-document-'));
  return {
    root,
    close() {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

test('actual guarded worker extracts PDF, DOCX and PPTX into the normal indexing and search pipeline', async () => {
  const f = fixture();
  const store = new Store(path.join(f.root, 'data'), {
    projectRoot: f.root,
    project: 'fixture',
    agent: 'worker',
  });
  try {
    fs.writeFileSync(path.join(f.root, 'one.pdf'), pdf());
    fs.writeFileSync(
      path.join(f.root, 'two.docx'),
      zip([
        [
          'word/document.xml',
          '<w:document xmlns:w="w"><w:p><w:t>한글 document keyword</w:t></w:p></w:document>',
        ],
      ]),
    );
    fs.writeFileSync(
      path.join(f.root, 'three.pptx'),
      zip([
        ['ppt/slides/slide2.xml', '<s><t>second slide keyword</t></s>'],
        ['ppt/slides/slide1.xml', '<s><t>first slide keyword</t></s>'],
      ]),
    );
    const text = await extractDocument(f.root, path.join(f.root, 'three.pptx'));
    assert.ok(text.indexOf('first slide') < text.indexOf('second slide'));
    await store.init();
    const config = structuredClone(require('../config.default.js'));
    const indexer = new Indexer(store, config);
    const result = await indexer.index(f.root);
    assert.equal(result.complete, true, JSON.stringify(result.issues));
    assert.equal(result.indexed, 3);
    const search = new BM25Search(store, config.search);
    assert.equal(search.search('keyword').length, 3);
    assert.ok(search.search('한글')[0].chunk.content.includes('한글'));
    assert.equal((await indexer.index(f.root)).skipped, 3);
    fs.writeFileSync(path.join(f.root, 'two.docx'), Buffer.from('broken office document'));
    const partial = await indexer.index(f.root);
    assert.equal(partial.complete, false);
    assert.ok(search.search('한글')[0].chunk.content.includes('한글'));
  } finally {
    store.close();
    f.close();
  }
});

test('document limits, unknown XML entities, missing workers and cross-root paths fail explicitly', async () => {
  const f = fixture();
  const original = process.env.N2_ARACHNE_DOCUMENT_WORKER;
  try {
    const filename = path.join(f.root, 'bad.docx');
    fs.writeFileSync(filename, zip([['word/document.xml', '<t>&unknown;</t>']]));
    await assert.rejects(extractDocument(f.root, filename), /entity/);
    await assert.rejects(extractDocument(f.root, filename, 1), /input limit/);
    const inner = path.join(f.root, 'inner');
    fs.mkdirSync(inner);
    await assert.rejects(extractDocument(inner, filename), /outside/);
    process.env.N2_ARACHNE_DOCUMENT_WORKER = path.join(f.root, 'missing.exe');
    await assert.rejects(extractDocument(f.root, filename), /build:documents/);
  } finally {
    if (original === undefined) delete process.env.N2_ARACHNE_DOCUMENT_WORKER;
    else process.env.N2_ARACHNE_DOCUMENT_WORKER = original;
    f.close();
  }
});

test('worker cancellation and concurrency limits release processes and exit listeners', async () => {
  const f = fixture();
  const original = process.env.N2_ARACHNE_DOCUMENT_WORKER;
  const controllers = [new AbortController(), new AbortController()];
  try {
    const filename = path.join(f.root, 'fixture.pdf');
    fs.writeFileSync(filename, pdf());
    fs.writeFileSync(path.join(f.root, 'package.json'), '{"main":"worker.cjs"}');
    fs.writeFileSync(
      path.join(f.root, 'worker.cjs'),
      'setTimeout(() => process.stdout.write(JSON.stringify("delayed")), 10000);',
    );
    process.env.N2_ARACHNE_DOCUMENT_WORKER = process.execPath;
    const listeners = process.listenerCount('exit');
    const running = controllers.map((controller) =>
      extractDocument(f.root, filename, undefined, controller.signal),
    );
    const settled = Promise.allSettled(running);
    await assert.rejects(extractDocument(f.root, filename), /already running/);
    controllers.forEach((controller) => controller.abort());
    const results = await settled;
    assert.ok(
      results.every(
        (result) => result.status === 'rejected' && /cancelled/.test(result.reason.message),
      ),
    );
    assert.equal(process.listenerCount('exit'), listeners);
    fs.writeFileSync(
      path.join(f.root, 'worker.cjs'),
      'process.stdout.write(JSON.stringify("ready"));',
    );
    assert.equal(await extractDocument(f.root, filename), 'ready');
  } finally {
    controllers.forEach((controller) => controller.abort());
    if (original === undefined) delete process.env.N2_ARACHNE_DOCUMENT_WORKER;
    else process.env.N2_ARACHNE_DOCUMENT_WORKER = original;
    f.close();
  }
});

test('index cancellation preserves previous records and releases its durable lease', async () => {
  const f = fixture();
  const store = new Store(path.join(f.root, 'data'), {
    projectRoot: f.root,
    project: 'fixture',
    agent: 'worker',
  });
  try {
    await store.init();
    const config = structuredClone(require('../config.default.js'));
    const indexer = new Indexer(store, config);
    store.upsertFile('retained.ts', 'hash', 'ts', 1, '2026-01-01');
    fs.writeFileSync(path.join(f.root, 'new.ts'), 'const keyword = 1;');
    const running = indexer.index(f.root);
    indexer.cancel();
    await assert.rejects(running, /abort/i);
    assert.ok(store.getFileByPath('retained.ts'));
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM arachne_index_jobs').get().n, 0);
    assert.equal(indexer.isIndexing, false);
    assert.equal((await indexer.index(f.root)).complete, true);
  } finally {
    store.close();
    f.close();
  }
});

test('actual XLSX worker resolves shared and inline cells and excludes unused strings', async () => {
  const f = fixture();
  try {
    const filename = path.join(f.root, 'cells.xlsx');
    fs.writeFileSync(
      filename,
      zip([
        [
          'xl/sharedStrings.xml',
          '<sst><si><t>사용한 셀</t></si><si><t>unused fixture</t></si></sst>',
        ],
        [
          'xl/worksheets/sheet1.xml',
          '<worksheet><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>inline fixture</t></is></c><c r="C1" t="b"><v>0</v></c><c r="D1"><v>42.5</v></c></worksheet>',
        ],
      ]),
    );
    const text = await extractDocument(f.root, filename);
    assert.match(text, /A1\t사용한 셀/);
    assert.match(text, /B1\tinline fixture/);
    assert.match(text, /C1\tfalse/);
    assert.match(text, /D1\t42.5/);
    assert.doesNotMatch(text, /unused fixture/);
  } finally {
    f.close();
  }
});

test('worker transport rejects oversized, malformed and changed-source results', async () => {
  const f = fixture();
  const original = process.env.N2_ARACHNE_DOCUMENT_WORKER;
  try {
    const filename = path.join(f.root, 'fixture.pdf');
    fs.writeFileSync(filename, pdf());
    fs.writeFileSync(path.join(f.root, 'package.json'), '{"main":"worker.cjs"}');
    process.env.N2_ARACHNE_DOCUMENT_WORKER = process.execPath;
    const worker = path.join(f.root, 'worker.cjs');
    fs.writeFileSync(worker, 'process.stdout.write(" ".repeat(17 * 1048576));');
    await assert.rejects(extractDocument(f.root, filename), /output exceeded/);
    fs.writeFileSync(worker, 'process.stdout.write("malformed JSON");');
    await assert.rejects(extractDocument(f.root, filename), /invalid JSON/);
    fs.writeFileSync(worker, 'process.stdout.write(Buffer.from([34,255,34]));');
    await assert.rejects(extractDocument(f.root, filename), /encoded data/i);
    fs.writeFileSync(
      worker,
      'require("node:fs").appendFileSync(process.argv[2], "changed"); process.stdout.write(JSON.stringify("text"));',
    );
    await assert.rejects(extractDocument(f.root, filename), /changed while/);
  } finally {
    if (original === undefined) delete process.env.N2_ARACHNE_DOCUMENT_WORKER;
    else process.env.N2_ARACHNE_DOCUMENT_WORKER = original;
    f.close();
  }
});

test('document fingerprints skip unchanged parsing, detect byte changes and survive backups', async () => {
  const f = fixture();
  const store = new Store(path.join(f.root, 'data'), {
    projectRoot: f.root,
    project: 'fixture',
    agent: 'worker',
  });
  const original = process.env.N2_ARACHNE_DOCUMENT_WORKER;
  try {
    const filename = path.join(f.root, 'fixture.pdf');
    fs.writeFileSync(filename, pdf());
    fs.writeFileSync(path.join(f.root, 'package.json'), '{"main":"worker.cjs"}');
    fs.writeFileSync(
      path.join(f.root, 'worker.cjs'),
      `const fs=require('node:fs'),p=require('node:path'); const file=p.join(__dirname,'calls'); const count=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8')):0; fs.writeFileSync(file,String(count+1)); process.stdout.write(JSON.stringify('parsed keyword'));`,
    );
    process.env.N2_ARACHNE_DOCUMENT_WORKER = process.execPath;
    await store.init();
    const config = structuredClone(require('../config.default.js'));
    const indexer = new Indexer(store, config);
    const count = () => Number(fs.readFileSync(path.join(f.root, 'calls'), 'utf8'));
    assert.equal((await indexer.index(f.root, { subPath: 'fixture.pdf' })).indexed, 1);
    const first = store.getFileByPath('fixture.pdf');
    assert.match(first.source_hash, /^[a-f0-9]{64}$/);
    assert.equal(first.size_bytes, fs.statSync(filename).size);
    assert.equal((await indexer.index(f.root, { subPath: 'fixture.pdf' })).skipped, 1);
    assert.equal(count(), 1);
    fs.appendFileSync(filename, '\n% harmless byte change');
    assert.equal((await indexer.index(f.root, { subPath: 'fixture.pdf' })).skipped, 1);
    assert.equal(count(), 2);
    assert.notEqual(store.getFileByPath('fixture.pdf').source_hash, first.source_hash);
    await indexer.index(f.root, { subPath: 'fixture.pdf' });
    assert.equal(count(), 2);
    store.db
      .prepare("UPDATE arachne_chunks SET content='external change' WHERE file_id=?")
      .run(first.id);
    assert.equal(store.getFileByPath('fixture.pdf').source_hash, null);
    await indexer.index(f.root, { subPath: 'fixture.pdf' });
    assert.equal(count(), 3);
    assert.equal(store.getChunksByFileId(first.id)[0].content, 'parsed keyword');
    config.indexing.tokenMultiplier = 2;
    await indexer.index(f.root, { subPath: 'fixture.pdf' });
    assert.equal(count(), 4);
    const { Backup } = require('../dist/lib/backup');
    const backup = new Backup(store, config.backup),
      saved = await backup.create();
    const fingerprint = store.getFileByPath('fixture.pdf').source_hash;
    await backup.restore(saved.id);
    assert.equal(store.getFileByPath('fixture.pdf').source_hash, fingerprint);
    await indexer.index(f.root, { subPath: 'fixture.pdf' });
    assert.equal(count(), 4);
  } finally {
    store.close();
    if (original === undefined) delete process.env.N2_ARACHNE_DOCUMENT_WORKER;
    else process.env.N2_ARACHNE_DOCUMENT_WORKER = original;
    f.close();
  }
});

test('actual PDF worker bounds decompression and accepts the next ordinary request', async () => {
  const f = fixture();
  try {
    const filename = path.join(f.root, 'expanded.pdf');
    fs.writeFileSync(filename, pdf(' '.repeat(33 * 1048576), true));
    assert.ok(fs.statSync(filename).size < 100000);
    await assert.rejects(extractDocument(f.root, filename), /limit|decompress|size|allocation/i);
    fs.writeFileSync(filename, pdf('afterLimitKeyword', true));
    assert.match(await extractDocument(f.root, filename), /afterLimitKeyword/);
  } finally {
    f.close();
  }
});
