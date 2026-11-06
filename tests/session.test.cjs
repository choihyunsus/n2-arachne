const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../dist/lib/store');
const { KVBridge } = require('../dist/lib/kv-bridge');
const { Backup } = require('../dist/lib/backup');
const { hashFile } = require('../dist/lib/snapshot');

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-session-'));
  const store = new Store(root, {
    projectRoot: root,
    project: 'demo',
    agent: 'first',
  });
  const peer = new Store(root, {
    projectRoot: root,
    project: 'demo',
    agent: 'first',
  });
  const other = new Store(root, {
    projectRoot: root,
    project: 'demo',
    agent: 'second',
  });
  await store.init();
  await peer.init();
  await other.init();
  return {
    root,
    store,
    peer,
    other,
    bridge: new KVBridge(store, root, root),
    close() {
      store.close();
      peer.close();
      other.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

test('session writes persist immediately, merge concurrent clients and survive restart and restore', async () => {
  const f = await fixture();
  try {
    const peer = new KVBridge(f.peer, f.root, f.root);
    const other = new KVBridge(f.other, f.root, f.root);
    assert.equal(f.bridge.load(), null);
    assert.equal(peer.load(), null);
    f.bridge.recordSearch('first', 2);
    peer.recordSearch('second', 3);
    other.recordSearch('secret', 1);
    f.bridge.save();
    peer.save();
    assert.equal(f.bridge.load().searchHistory.length, 2);
    assert.deepEqual(new Set(f.bridge.getRecentQueries()), new Set(['first', 'second']));
    assert.deepEqual(other.getRecentQueries(), ['secret']);
    const copy = f.bridge.getSearchHistory();
    copy[0].query = 'mutated';
    assert.ok(!f.bridge.getRecentQueries().includes('mutated'));
    const backup = new Backup(f.store, {
      dir: '',
      maxBackups: 10,
      maxAgeDays: 30,
    });
    const saved = await backup.create();
    f.bridge.recordSearch('after backup', 4);
    await backup.restore(saved.id);
    f.bridge.save();
    assert.equal(f.bridge.getSearchHistory().length, 2);
    f.store.close();
    await f.store.init();
    const restarted = new KVBridge(f.store, f.root, f.root);
    assert.equal(restarted.load().searchHistory.length, 2);
    assert.equal(restarted.kvPath, f.store.dbPath);
    assert.equal(fs.existsSync(path.join(f.root, 'arachne-kv.json')), false);
  } finally {
    f.close();
  }
});

test('invalid stored state is preserved and pending searches retry once after repair', async () => {
  const f = await fixture();
  try {
    f.bridge.recordSearch('valid', 1);
    const original = f.store.db
      .prepare('SELECT payload_json FROM arachne_sessions')
      .get().payload_json;
    f.store.db.prepare("UPDATE arachne_sessions SET payload_json='broken'").run();
    assert.equal(f.bridge.load(), null);
    assert.ok(f.bridge.getLastError());
    f.bridge.recordSearch('retry me', 2);
    assert.equal(f.bridge.save(), false);
    assert.equal(
      f.store.db.prepare('SELECT payload_json FROM arachne_sessions').get().payload_json,
      'broken',
    );
    f.store.db.prepare('UPDATE arachne_sessions SET payload_json=?').run(original);
    assert.equal(f.bridge.save(), true);
    assert.equal(f.bridge.save(), true);
    assert.equal(f.bridge.getSearchHistory().length, 2);
    assert.equal(f.bridge.getLastError(), null);
    assert.throws(() => f.bridge.recordSearch('invalid', -1), /Invalid/);
    assert.throws(() => f.bridge.recordSearch('x'.repeat(4097), 0), /length/);
    const state = JSON.parse(original);
    state.version = '99.0.0';
    f.store.db.prepare('UPDATE arachne_sessions SET payload_json=?').run(JSON.stringify(state));
    assert.equal(f.bridge.load(), null);
    assert.match(f.bridge.getLastError(), /Unsupported/);
    assert.equal(f.bridge.save(), false);
  } finally {
    f.close();
  }
});

test('legacy JSON is imported by one owner, checked for source root and preserved byte-for-byte', async () => {
  const f = await fixture();
  try {
    const legacyPath = path.join(f.root, 'arachne-kv.json');
    const legacy = {
      ...f.bridge.exportState(),
      version: '4.0.0',
      searchHistory: [{ query: 'legacy', timestamp: '2026-01-01', resultCount: 1 }],
    };
    delete legacy.project;
    delete legacy.agent;
    legacy.projectDir = path.join(f.root, 'wrong');
    fs.writeFileSync(legacyPath, JSON.stringify(legacy));
    assert.equal(f.bridge.load(), null);
    assert.match(f.bridge.getLastError(), /root differs/);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM arachne_sessions').get().n, 0);
    legacy.projectDir = f.root;
    fs.writeFileSync(legacyPath, JSON.stringify(legacy));
    const original = hashFile(legacyPath);
    assert.equal(f.bridge.load().version, '5.0.0');
    assert.deepEqual(f.bridge.getRecentQueries(), ['legacy']);
    const other = new KVBridge(f.other, f.root, f.root);
    assert.equal(other.load(), null);
    other.recordSearch('own', 1);
    assert.deepEqual(other.getRecentQueries(), ['own']);
    f.bridge.save();
    f.bridge.load();
    assert.equal(f.bridge.getSearchHistory().length, 1);
    assert.deepEqual(hashFile(legacyPath), original);
  } finally {
    f.close();
  }
});

test('zero retention and disabled sessions do not accidentally retain searches', async () => {
  const f = await fixture();
  try {
    const disabled = new KVBridge(f.store, f.root, f.root, { enabled: false });
    disabled.recordSearch('ignore', 1);
    assert.equal(disabled.save(), false);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM arachne_sessions').get().n, 0);
    const zero = new KVBridge(f.store, f.root, f.root, {
      maxSearchHistory: 0,
      maxHotFiles: 0,
    });
    zero.recordSearch('forget', 1);
    assert.equal(zero.getSearchHistory().length, 0);
    assert.equal(zero.load().searchHistory.length, 0);
    assert.deepEqual(zero.getRecentQueries(0), []);
    assert.throws(() => zero.getRecentQueries(-1), /Invalid/);
  } finally {
    f.close();
  }
});
