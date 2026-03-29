// test-indexer.js — Context Assembler Phase 1 integration test
// Tests indexing + search against QLN project
const path = require('path');
const { loadConfig } = require('../dist/lib/config');
const { Store } = require('../dist/lib/store');
const { Indexer } = require('../dist/lib/indexer');
const { BM25Search } = require('../dist/lib/search');
const { Backup } = require('../dist/lib/backup');

const TEST_PROJECT = path.resolve(__dirname, '../../QLN');
const TEST_DATA_DIR = path.resolve(__dirname, '../data');

async function runTests() {
    console.log('=== Context Assembler Phase 1 Test ===\n');
    let passed = 0;
    let failed = 0;

    function assert(name, condition) {
        if (condition) {
            console.log(`  ✅ ${name}`);
            passed++;
        } else {
            console.log(`  ❌ ${name}`);
            failed++;
        }
    }

    // ── Test 1: Config ──
    console.log('\n📋 Test 1: Config Loading');
    const config = loadConfig(path.resolve(__dirname, '..'));
    config.projectDir = TEST_PROJECT;
    config.dataDir = TEST_DATA_DIR;
    config.backup.dir = path.join(TEST_DATA_DIR, 'backups');
    config.indexing.autoIndex = false;
    assert('Config loaded', !!config);
    assert('Data dir set', config.dataDir === TEST_DATA_DIR);
    assert('Default budget', config.assembly.defaultBudget === 40000);

    // ── Test 2: Store ──
    console.log('\n💾 Test 2: Store Init');
    const store = new Store(config.dataDir);
    await store.init();
    assert('Store initialized', !!store.db);
    assert('Schema version set', store.getMeta('schema_version') === '3');

    // ── Test 3: Indexing ──
    console.log('\n📁 Test 3: Indexing QLN Project');
    const indexer = new Indexer(store, config);
    const result = await indexer.index(TEST_PROJECT);
    console.log(`   → Total: ${result.total}, Indexed: ${result.indexed}, Skipped: ${result.skipped}, Elapsed: ${result.elapsed}ms`);
    assert('Files found', result.total > 0);
    assert('Files processed', result.indexed >= 0); // 증분 인덱싱: 변경 없으면 0 OK

    // ── Test 4: Stats ──
    console.log('\n📊 Test 4: Stats');
    const stats = store.getStats();
    console.log(`   → Files: ${stats.fileCount}, Chunks: ${stats.chunkCount}, Tokens: ${stats.totalTokens}, DB: ${stats.dbSizeMB}MB`);
    assert('File count > 0', stats.fileCount > 0);
    assert('Chunk count > 0', stats.chunkCount > 0);
    assert('Token count > 0', stats.totalTokens > 0);

    // ── Test 5: Search ──
    console.log('\n🔍 Test 5: BM25 Search');
    const search = new BM25Search(store, config.search);
    const searchResults = search.search('executor http timeout');
    console.log(`   → Found ${searchResults.length} results`);
    if (searchResults.length > 0) {
        const top = searchResults[0];
        console.log(`   → Top: ${top.chunk.file_path}:${top.chunk.start_line} [${top.chunk.chunk_type}${top.chunk.name ? ':' + top.chunk.name : ''}] score=${top.score.toFixed(2)}`);
    }
    assert('Search returns results', searchResults.length > 0);

    // ── Test 6: Incremental (재인덱싱 시 skip) ──
    console.log('\n🔄 Test 6: Incremental Indexing');
    const result2 = await indexer.index(TEST_PROJECT);
    console.log(`   → Total: ${result2.total}, Indexed: ${result2.indexed}, Skipped: ${result2.skipped}`);
    assert('Second run skips all', result2.indexed === 0 && result2.skipped > 0);

    // ── Test 7: Backup ──
    console.log('\n🗃️ Test 7: Backup');
    const backup = new Backup(store, config.backup);
    const bkResult = await backup.create('test-backup');
    console.log(`   → Backup ID: ${bkResult.id}, Size: ${(bkResult.size / 1024).toFixed(1)}KB`);
    assert('Backup created', !!bkResult.id);

    const backups = backup.list();
    assert('Backup listed', backups.length > 0);

    // ── Test 8: Backup Search ──
    console.log('\n🔎 Test 8: Backup Search');
    try {
        const bkSearch = backup.searchBackup(bkResult.id, 'function');
        console.log(`   → Found ${bkSearch.length} results in backup`);
        assert('Backup search works', bkSearch.length > 0);
    } catch (err) {
        console.log(`   → Backup search error: ${err.message}`);
        assert('Backup search works', false);
    }

    // ── Summary ──
    console.log(`\n${'='.repeat(40)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(`${'='.repeat(40)}`);

    store.close();
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
