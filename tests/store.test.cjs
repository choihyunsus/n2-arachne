// Scoped shared storage keeps unrelated agents and Soul memory intact.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../dist/lib/store');

const chunk = (content) => ({
  type: 'module',
  name: null,
  startLine: 1,
  endLine: 1,
  content,
  tokenCount: 4,
  searchText: content,
});
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-scope-'));
  const options = { project: 'demo', projectRoot: root };
  const first = new Store(root, { ...options, agent: 'first' });
  const second = new Store(root, { ...options, agent: 'second' });
  await first.init();
  await second.init();
  return {
    root,
    first,
    second,
    close() {
      first.close();
      second.close();
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    },
  };
}
function insert(store, content = 'keyword') {
  const result = store.upsertFile('file.ts', 'hash', 'ts', 10, new Date().toISOString());
  store.insertChunks(result.fileId, [chunk(content)]);
  return result.fileId;
}

test('all file/chunk/stat/access queries retain project and agent scope', async () => {
  const f = await fixture();
  try {
    const one = insert(f.first),
      two = insert(f.second);
    f.first.logAccess(one, 'keyword');
    f.second.logAccess(two, 'keyword');
    assert.equal(f.first.getAllFiles().length, 1);
    assert.equal(f.first.getFileByPath('file.ts').id, one);
    assert.equal(f.first.getChunksByFileId(two).length, 0);
    assert.equal(f.first.getChunksByFileIds([one, two]).length, 1);
    assert.equal(f.first.searchChunks('keyword').length, 1);
    assert.equal(f.first.getStats().chunkCount, 1);
    assert.equal(f.first.getRecentFiles()[0].file_id, one);
    assert.equal(f.first.getMostAccessedFiles()[0].file_id, one);
    assert.throws(() => f.first.insertChunks(two, [chunk('foreign')]), /belong/);
    assert.throws(
      () =>
        f.first.insertDependencies(one, [
          { targetPath: 'file.ts', targetFileId: two, depType: 'import' },
        ]),
      /belong/,
    );
    f.first.removeFile('file.ts');
    assert.equal(f.second.getStats().fileCount, 1);
    assert.throws(() => f.first.getFileByPath('../outside'), /normalized/);
  } finally {
    f.close();
  }
});

test('file replacement rollback retains the prior content and revision tracks external writes', async () => {
  const f = await fixture();
  try {
    const id = insert(f.first, 'before');
    const revision = f.first.revision;
    assert.throws(
      () =>
        f.first.db
          .transaction(() => {
            f.first.upsertFile('file.ts', 'changed', 'ts', 10, new Date().toISOString());
            f.first.insertChunks(id, [{ ...chunk('invalid'), startLine: 5, endLine: 2 }]);
          })
          .immediate(),
      /precedes/,
    );
    assert.equal(f.first.getChunksByFileId(id)[0].content, 'before');
    assert.equal(f.first.revision, revision);
    f.second.db.prepare("UPDATE arachne_chunks SET content='after' WHERE file_id=?").run(id);
    assert.notEqual(f.first.revision, revision);
    assert.equal(f.first.getChunksByFileId(id)[0].content, 'after');
  } finally {
    f.close();
  }
});

test('the same ownership identity cannot silently switch source roots', async () => {
  const f = await fixture();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-root-'));
  const invalid = new Store(f.root, {
    project: 'demo',
    agent: 'first',
    projectRoot: other,
  });
  try {
    await assert.rejects(invalid.init(), /different source root/);
  } finally {
    invalid.close();
    f.close();
    fs.rmSync(other, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
});
