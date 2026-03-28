// test-kv-bridge.js — KV-Cache bridge integration tests
// Tests search history, hot file tracking, save/load, and graceful degradation
const path = require('path');
const fs = require('fs');
const { loadConfig } = require('../dist/lib/config');
const { Store } = require('../dist/lib/store');
const { Indexer } = require('../dist/lib/indexer');
const { KVBridge } = require('../dist/lib/kv-bridge');

const TEST_PROJECT = path.resolve(__dirname, '../../QLN');
const TEST_DATA_DIR = path.resolve(__dirname, '../data');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) {
        console.log(`  ✅ ${msg}`);
        passed++;
    } else {
        console.log(`  ❌ FAIL: ${msg}`);
        failed++;
    }
}

async function main() {
    console.log('=== Arachne Phase 2: KV-Cache Bridge Test ===\n');

    const config = loadConfig();
    const store = new Store(TEST_DATA_DIR);
    await store.init();

    // Index some files first (needed for hot file tracking)
    const indexer = new Indexer(store, config);
    await indexer.index(TEST_PROJECT);

    // ── Test 1: KVBridge Initialization ──
    console.log('\n💾 Test 1: KVBridge Initialization');
    const kvBridge = new KVBridge(store, TEST_DATA_DIR, TEST_PROJECT);
    assert(kvBridge !== null, 'KVBridge created');
    assert(kvBridge.isEnabled === true, 'KVBridge enabled by default');
    assert(kvBridge.kvPath.endsWith('arachne-kv.json'), `KV path: ${path.basename(kvBridge.kvPath)}`);

    // ── Test 2: Search History Recording ──
    console.log('\n📝 Test 2: Search History Recording');
    kvBridge.recordSearch('login timeout', 5);
    kvBridge.recordSearch('authentication', 3);
    kvBridge.recordSearch('session management', 8);

    const history = kvBridge.getSearchHistory();
    assert(history.length === 3, `History has 3 entries (got ${history.length})`);
    assert(history[0].query === 'login timeout', `First query: ${history[0].query}`);
    assert(history[0].resultCount === 5, `First result count: ${history[0].resultCount}`);
    assert(typeof history[0].timestamp === 'string', 'Timestamp is string');

    // ── Test 3: Empty/Invalid Query Handling ──
    console.log('\n🛡️ Test 3: Empty/Invalid Query Handling');
    kvBridge.recordSearch('', 0);
    kvBridge.recordSearch('   ', 0);
    assert(kvBridge.getSearchHistory().length === 3, 'Empty queries ignored');

    // ── Test 4: Recent Queries Deduplication ──
    console.log('\n🔄 Test 4: Recent Queries Deduplication');
    kvBridge.recordSearch('login timeout', 10);  // duplicate query
    kvBridge.recordSearch('new query', 2);

    const recent = kvBridge.getRecentQueries(5);
    assert(recent.length >= 3, `Recent queries: ${recent.length}`);
    assert(recent[0] === 'new query', `Most recent: ${recent[0]}`);
    // 'login timeout' should appear only once despite being recorded twice
    const loginCount = recent.filter(q => q.toLowerCase() === 'login timeout').length;
    assert(loginCount <= 1, `Deduplicated: login timeout appears ${loginCount} time(s)`);

    // ── Test 5: State Export ──
    console.log('\n📦 Test 5: State Export');
    const state = kvBridge.exportState();
    assert(state.version === '4.0.0', `Version: ${state.version}`);
    assert(typeof state.lastSavedAt === 'string', 'Has lastSavedAt');
    assert(typeof state.fileCount === 'number', `Files: ${state.fileCount}`);
    assert(typeof state.chunkCount === 'number', `Chunks: ${state.chunkCount}`);
    assert(typeof state.totalTokens === 'number', `Tokens: ${state.totalTokens}`);
    assert(Array.isArray(state.hotFiles), `Hot files: ${state.hotFiles.length}`);
    assert(Array.isArray(state.searchHistory), `Search history: ${state.searchHistory.length}`);

    // ── Test 6: Save to Disk ──
    console.log('\n💾 Test 6: Save to Disk');
    const saved = kvBridge.save();
    assert(saved === true, 'Save returned true');
    assert(fs.existsSync(kvBridge.kvPath), 'KV file exists on disk');

    const raw = JSON.parse(fs.readFileSync(kvBridge.kvPath, 'utf-8'));
    assert(raw.version === '4.0.0', `Saved version: ${raw.version}`);
    assert(raw.searchHistory.length > 0, `Saved history count: ${raw.searchHistory.length}`);

    // ── Test 7: Load from Disk (New Instance) ──
    console.log('\n📂 Test 7: Load from Disk (New Instance)');
    const kvBridge2 = new KVBridge(store, TEST_DATA_DIR, TEST_PROJECT);
    const loaded = kvBridge2.load();
    assert(loaded !== null, 'Load returned data');
    assert(loaded.version === '4.0.0', `Loaded version: ${loaded.version}`);
    assert(loaded.searchHistory.length > 0, `Loaded history: ${loaded.searchHistory.length}`);

    // Verify search history was restored into the new instance
    const restoredHistory = kvBridge2.getSearchHistory();
    assert(restoredHistory.length > 0, `Restored history in new instance: ${restoredHistory.length}`);

    // ── Test 8: Corrupted KV File ──
    console.log('\n💥 Test 8: Corrupted KV File');
    fs.writeFileSync(kvBridge.kvPath, '{invalid json!!!', 'utf-8');
    const kvBridge3 = new KVBridge(store, TEST_DATA_DIR, TEST_PROJECT);
    const corruptedResult = kvBridge3.load();
    assert(corruptedResult === null, 'Corrupted file returns null (graceful)');
    assert(kvBridge3.getSearchHistory().length === 0, 'Fresh history after corruption');

    // ── Test 9: Max History Cap ──
    console.log('\n📊 Test 9: Max History Cap');
    const kvCapped = new KVBridge(store, TEST_DATA_DIR, TEST_PROJECT, { maxSearchHistory: 5 });
    for (let i = 0; i < 20; i++) {
        kvCapped.recordSearch(`query_${i}`, i);
    }
    assert(kvCapped.getSearchHistory().length === 5, `Capped at 5 (got ${kvCapped.getSearchHistory().length})`);
    assert(kvCapped.getSearchHistory()[4].query === 'query_19', 'Keeps most recent');

    // ── Test 10: Disabled KVBridge ──
    console.log('\n🚫 Test 10: Disabled KVBridge');
    const kvDisabled = new KVBridge(store, TEST_DATA_DIR, TEST_PROJECT, { enabled: false });
    assert(kvDisabled.isEnabled === false, 'KVBridge disabled');
    // Still functional (recording works, but won't auto-save in production)
    kvDisabled.recordSearch('test query', 1);
    assert(kvDisabled.getSearchHistory().length === 1, 'Recording still works when disabled');

    // ── Test 11: Hot Files from Access Log ──
    console.log('\n🔥 Test 11: Hot Files from Access Log');
    // Log some file accesses
    const files = store.db.prepare('SELECT id FROM files LIMIT 3').all();
    for (const f of files) {
        store.logAccess(f.id, 'test query');
    }
    const stateWithHot = kvBridge.exportState();
    assert(Array.isArray(stateWithHot.hotFiles), `Hot files array: ${stateWithHot.hotFiles.length}`);

    // ── Cleanup ──
    if (fs.existsSync(kvBridge.kvPath)) {
        fs.unlinkSync(kvBridge.kvPath);
    }

    // Results
    console.log('\n========================================');
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log('========================================\n');
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Test error:', err);
    process.exit(1);
});
