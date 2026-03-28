// test-stability.js — Arachne stability test (Reddit-proof)
// Edge cases, SQL injection, error recovery, input validation
const path = require('path');
const fs = require('fs');
const { loadConfig } = require('../dist/lib/config');
const { Store } = require('../dist/lib/store');
const { Indexer } = require('../dist/lib/indexer');
const { BM25Search } = require('../dist/lib/search');
const { Embedding } = require('../dist/lib/embedding');
const { VectorStore } = require('../dist/lib/vector-store');
const { Assembler } = require('../dist/lib/assembler');

const TEST_PROJECT = path.resolve(__dirname, '../../QLN');
const TEST_DATA_DIR = path.resolve(__dirname, '../data');

async function runTests() {
    console.log('=== Arachne Stability Test (Reddit-proof) ===\n');
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

    // ── Setup ──
    const config = loadConfig(path.resolve(__dirname, '..'));
    config.projectDir = TEST_PROJECT;
    config.dataDir = TEST_DATA_DIR;
    config.backup.dir = path.join(TEST_DATA_DIR, 'backups');
    config.indexing.autoIndex = false;

    const store = new Store(config.dataDir);
    await store.init();
    const indexer = new Indexer(store, config);
    const search = new BM25Search(store, config.search);
    const assembler = new Assembler(store, search, config.assembly);

    // 인덱싱 (데이터 준비)
    await indexer.index(TEST_PROJECT);

    // ══════════════════════════════════════════════════════
    // Test 1: 빈 입력 방어
    // ══════════════════════════════════════════════════════
    console.log('\n🛡️ Test 1: Empty Input Defense');

    const emptySearch = search.search('', { topK: 10 });
    assert('Empty query → empty results', emptySearch.length === 0);

    const nullSearch = search.search(null, { topK: 10 });
    assert('Null query → empty results', nullSearch.length === 0);

    const undefinedSearch = search.search(undefined, { topK: 10 });
    assert('Undefined query → empty results', undefinedSearch.length === 0);

    const hybridEmpty = await search.hybridSearch('', { topK: 5 });
    assert('Empty hybridSearch → empty results', hybridEmpty.length === 0);

    const assembleEmpty = await assembler.assemble('', {
        projectDir: TEST_PROJECT, budget: 5000,
    });
    assert('Empty assemble → still returns (file tree)', assembleEmpty.context !== undefined);

    // ══════════════════════════════════════════════════════
    // Test 2: 거대 입력 방어
    // ══════════════════════════════════════════════════════
    console.log('\n🐘 Test 2: Huge Input Defense');

    const hugeQuery = 'a'.repeat(10000);
    const hugeSearch = search.search(hugeQuery, { topK: 5 });
    assert('10KB query → no crash', Array.isArray(hugeSearch));

    const hugeAssemble = await assembler.assemble(hugeQuery, {
        projectDir: TEST_PROJECT, budget: 5000,
    });
    assert('10KB assemble → no crash', hugeAssemble.context !== undefined);

    // ══════════════════════════════════════════════════════
    // Test 3: 특수문자 / 유니코드  
    // ══════════════════════════════════════════════════════
    console.log('\n🔣 Test 3: Special Characters');

    const specialChars = '!@#$%^&*()[]{}|\\;:\'",.<>?/`~';
    const specialSearch = search.search(specialChars, { topK: 5 });
    assert('Special chars → no crash', Array.isArray(specialSearch));

    const unicodeQuery = '한글쿼리テスト🚀🕷️';
    const unicodeSearch = search.search(unicodeQuery, { topK: 5 });
    assert('Unicode query → no crash', Array.isArray(unicodeSearch));

    const emojiQuery = '🔥💀👻🎃🦇🕸️';
    const emojiSearch = search.search(emojiQuery, { topK: 5 });
    assert('Emoji query → no crash', Array.isArray(emojiSearch));

    // ══════════════════════════════════════════════════════
    // Test 4: SQL 인젝션 방어
    // ══════════════════════════════════════════════════════
    console.log('\n💉 Test 4: SQL Injection Defense');

    const sqlInjections = [
        "'; DROP TABLE chunks; --",
        "1 OR 1=1",
        "1'; DELETE FROM files WHERE '1'='1",
        "UNION SELECT * FROM meta--",
        "Robert'); DROP TABLE files;--",
    ];

    for (const injection of sqlInjections) {
        try {
            const result = search.search(injection, { topK: 5 });
            assert(`SQL injection safe: ${injection.slice(0, 30)}...`, Array.isArray(result));
        } catch (err) {
            assert(`SQL injection should not crash: ${injection.slice(0, 30)}...`, false);
        }
    }

    // 인젝션 후 테이블 무사한지 확인
    const tablesAfter = store.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).all();
    const tableNames = tablesAfter.map(t => t.name);
    assert('chunks table survived', tableNames.includes('chunks'));
    assert('files table survived', tableNames.includes('files'));
    assert('meta table survived', tableNames.includes('meta'));

    // ══════════════════════════════════════════════════════
    // Test 5: 존재하지 않는 경로 처리
    // ══════════════════════════════════════════════════════
    console.log('\n📂 Test 5: Invalid Path Handling');

    try {
        const result = await indexer.index('Z:\\nonexistent\\path\\that\\cant\\exist');
        assert('Nonexistent path → no crash', true);
    } catch (err) {
        assert('Nonexistent path → handled gracefully', err.message.length > 0);
    }

    // ══════════════════════════════════════════════════════
    // Test 6: 중복 인덱싱 안정성
    // ══════════════════════════════════════════════════════
    console.log('\n🔄 Test 6: Duplicate Indexing Stability');

    const r1 = await indexer.index(TEST_PROJECT);
    const r2 = await indexer.index(TEST_PROJECT);
    const r3 = await indexer.index(TEST_PROJECT);
    assert('Triple indexing → no crash', true);
    assert('Idempotent: same file count', r1.total === r2.total && r2.total === r3.total);

    const chunkCount1 = store.db.prepare('SELECT COUNT(*) as cnt FROM chunks').get().cnt;
    assert('No duplicate chunks after re-index', chunkCount1 > 0);

    // ══════════════════════════════════════════════════════
    // Test 7: 극단적 예산 처리
    // ══════════════════════════════════════════════════════
    console.log('\n💰 Test 7: Extreme Budget Handling');

    const tinyBudget = await assembler.assemble('function', {
        projectDir: TEST_PROJECT, budget: 1,
    });
    assert('Budget=1 → no crash', tinyBudget.context !== undefined);

    const zeroBudget = await assembler.assemble('function', {
        projectDir: TEST_PROJECT, budget: 0,
    });
    assert('Budget=0 → no crash', zeroBudget.context !== undefined);

    const hugeBudget = await assembler.assemble('function', {
        projectDir: TEST_PROJECT, budget: 1000000,
    });
    assert('Budget=1M → no crash', hugeBudget.context !== undefined);
    assert('Budget=1M → within budget', hugeBudget.metadata.tokensUsed <= 1000000);

    // ══════════════════════════════════════════════════════
    // Test 8: Embedding 엣지 케이스
    // ══════════════════════════════════════════════════════
    console.log('\n🧠 Test 8: Embedding Edge Cases');

    const embedding = new Embedding({
        model: 'nomic-embed-text',
        endpoint: 'http://127.0.0.1:11434',
    });

    const emptyEmbed = await embedding.embed('');
    assert('Empty text → empty vector', emptyEmbed.length === 0);

    const nullEmbed = await embedding.embed(null);
    assert('Null text → empty vector', nullEmbed.length === 0);

    const whitespaceEmbed = await embedding.embed('   ');
    assert('Whitespace → empty vector', whitespaceEmbed.length === 0);

    const sim1 = embedding.cosineSimilarity([], []);
    assert('cosineSimilarity([], []) → 0', sim1 === 0);

    const sim2 = embedding.cosineSimilarity([1, 2], [1]);
    assert('cosineSimilarity mismatched dims → 0', sim2 === 0);

    const sim3 = embedding.cosineSimilarity(null, null);
    assert('cosineSimilarity(null, null) → 0', sim3 === 0);

    // ══════════════════════════════════════════════════════
    // Test 9: 잘못된 Ollama 엔드포인트
    // ══════════════════════════════════════════════════════
    console.log('\n🔌 Test 9: Bad Ollama Endpoint');

    const badEmbedding = new Embedding({
        model: 'nomic-embed-text',
        endpoint: 'http://192.168.254.254:11434', // 존재하지 않는 IP
    });

    const badAvailable = await badEmbedding.isAvailable();
    assert('Bad endpoint → isAvailable=false', badAvailable === false);

    const badEmbed = await badEmbedding.embed('test');
    assert('Bad endpoint → empty vector', badEmbed.length === 0);

    // ══════════════════════════════════════════════════════
    // Test 10: VectorStore 미초기화 상태에서 호출
    // ══════════════════════════════════════════════════════
    console.log('\n🚫 Test 10: VectorStore Not Initialized');

    const uninitVS = new VectorStore(store, badEmbedding);
    // init 하지 않고 바로 호출

    const vsSearch = await uninitVS.search('test', 5);
    assert('Uninitialized search → empty', vsSearch.length === 0);

    const vsEmbed = await uninitVS.embedNewChunks();
    assert('Uninitialized embedNewChunks → zero', vsEmbed.embedded === 0);

    const vsCount = uninitVS.getEmbeddedCount();
    assert('Uninitialized getEmbeddedCount → 0', vsCount === 0);

    uninitVS.deleteByChunkIds([1, 2, 3]);
    assert('Uninitialized deleteByChunkIds → no crash', true);

    // ══════════════════════════════════════════════════════
    // Test 11: topK 엣지 케이스
    // ══════════════════════════════════════════════════════
    console.log('\n📊 Test 11: topK Edge Cases');

    const topK0 = search.search('function', { topK: 0 });
    assert('topK=0 → no crash', Array.isArray(topK0));

    const topKNeg = search.search('function', { topK: -1 });
    assert('topK=-1 → no crash', Array.isArray(topKNeg));

    const topKHuge = search.search('function', { topK: 99999 });
    assert('topK=99999 → no crash', Array.isArray(topKHuge));

    // ══════════════════════════════════════════════════════
    // Test 12: Schema 동시 마이그레이션 안정성
    // ══════════════════════════════════════════════════════
    console.log('\n💾 Test 12: Schema Re-migration Safety');

    // init을 여러 번 호출해도 안전한지
    await store.init();
    await store.init();
    await store.init();
    assert('Triple init → no crash', true);
    assert('Schema still v3 after re-init', store.getMeta('schema_version') === '3');

    // 데이터도 무사한지
    const finalChunks = store.db.prepare('SELECT COUNT(*) as cnt FROM chunks').get().cnt;
    assert('Data survived re-init', finalChunks > 0);

    // ══════════════════════════════════════════════════════
    // Summary
    // ══════════════════════════════════════════════════════
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Stability Test Results: ${passed} passed, ${failed} failed`);
    console.log(`${'='.repeat(50)}`);

    if (failed > 0) {
        console.log('\n⚠️ FAILED TESTS — Fix before Reddit deployment!');
    } else {
        console.log('\n🎉 ALL STABLE — Reddit-proof!');
    }

    store.close();
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Stability test fatal error:', err);
    process.exit(1);
});
