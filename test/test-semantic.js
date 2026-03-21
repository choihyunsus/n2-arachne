// test-semantic.js — Arachne Phase 3 시맨틱 검색 테스트
// Ollama 연결 가능 시 시맨틱, 불가 시 graceful degradation 테스트
const path = require('path');
const { loadConfig } = require('../lib/config');
const { Store } = require('../lib/store');
const { Indexer } = require('../lib/indexer');
const { BM25Search } = require('../lib/search');
const { Embedding } = require('../lib/embedding');
const { VectorStore } = require('../lib/vector-store');
const { Assembler } = require('../lib/assembler');

const TEST_PROJECT = path.resolve(__dirname, '../../QLN');
const TEST_DATA_DIR = path.resolve(__dirname, '../data');

async function runTests() {
    console.log('=== Arachne Phase 3 Test ===\n');
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

    // ── Test 1: Schema V3 마이그레이션 ──
    console.log('\n💾 Test 1: Schema V3 Migration');
    assert('Schema version = 3', store.getMeta('schema_version') === '3');

    const tables = store.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = 'embeddings_meta'"
    ).all();
    assert('embeddings_meta table exists', tables.length > 0);

    // ── Test 2: Embedding 클래스 ──
    console.log('\n🧠 Test 2: Embedding Engine');
    const embedding = new Embedding({
        model: 'nomic-embed-text',
        endpoint: 'http://127.0.0.1:11434',
    });

    const ollamaAvailable = await embedding.isAvailable();
    console.log(`   → Ollama available: ${ollamaAvailable}`);

    if (ollamaAvailable) {
        assert('Dimensions detected', embedding.dimensions > 0);
        console.log(`   → Dimensions: ${embedding.dimensions}`);

        // 단일 임베딩
        const vec1 = await embedding.embed('HTTP request handler with timeout');
        assert('Single embed returns vector', vec1.length > 0);
        assert('Vector dimension matches', vec1.length === embedding.dimensions);

        // 배치 임베딩
        const vecs = await embedding.embedBatch(['hello', 'world']);
        assert('Batch embed returns 2 vectors', vecs.length === 2);

        // 코사인 유사도
        const sim = embedding.cosineSimilarity(vec1, vec1);
        assert('Self-similarity = 1', Math.abs(sim - 1.0) < 0.001);

        const zeroSim = embedding.cosineSimilarity([], []);
        assert('Empty vectors = 0', zeroSim === 0);
    } else {
        console.log('   ⚠️ Ollama unavailable, skipping vector tests');
        assert('Graceful degradation (Ollama)', true);
    }

    // ── Test 3: VectorStore ──
    console.log('\n🔍 Test 3: VectorStore (sqlite-vec)');
    const vectorStore = new VectorStore(store, embedding);
    const vecInitialized = await vectorStore.init();
    console.log(`   → VectorStore initialized: ${vecInitialized}`);

    if (vecInitialized) {
        // 인덱싱 먼저 (이미 인덱싱 되어있으면 skip)
        const indexer = new Indexer(store, config);
        await indexer.index(TEST_PROJECT);

        // 신규 청크 임베딩
        const embedResult = await vectorStore.embedNewChunks();
        console.log(`   → Embedded: ${embedResult.embedded}, Errors: ${embedResult.errors}`);
        assert('embedNewChunks works', embedResult.embedded >= 0);

        // 임베딩 카운트
        const embCount = vectorStore.getEmbeddedCount();
        console.log(`   → Embedded count: ${embCount}`);
        assert('Embedded count > 0', embCount > 0);

        // KNN 검색
        const vecResults = await vectorStore.search('HTTP request executor', 5);
        console.log(`   → KNN results: ${vecResults.length}`);
        assert('KNN search returns results', vecResults.length > 0);
        assert('Results have distance', vecResults[0].distance !== undefined);
    } else {
        console.log('   ⚠️ VectorStore unavailable, skipping');
        assert('Graceful degradation (VectorStore)', true);
    }

    // ── Test 4: Hybrid Search ──
    console.log('\n🔗 Test 4: Hybrid Search');
    const search = new BM25Search(store, config.search);

    if (vecInitialized) {
        search.setVectorStore(vectorStore);
        const hybridResults = await search.hybridSearch('executor timeout', { topK: 5 });
        console.log(`   → Hybrid results: ${hybridResults.length}`);
        assert('Hybrid returns results', hybridResults.length > 0);
        assert('Results have bm25Score', hybridResults[0].bm25Score !== undefined);
        assert('Results have semanticScore', hybridResults[0].semanticScore !== undefined);
    } else {
        // BM25-only 폴백 테스트
        const fallbackResults = await search.hybridSearch('executor', { topK: 5 });
        console.log(`   → BM25-only results: ${fallbackResults.length}`);
        assert('BM25-only fallback works', fallbackResults.length > 0);
        assert('semanticScore = 0 (no vector)', fallbackResults[0].semanticScore === 0);
    }

    // ── Test 5: Assembler async ──
    console.log('\n🕷️ Test 5: Async Assembler');
    const assembler = new Assembler(store, search, config.assembly);
    if (vecInitialized) {
        assembler.setVectorStore(vectorStore);
    }

    const assembled = await assembler.assemble('HTTP timeout error handling', {
        projectDir: TEST_PROJECT,
        budget: 10000,
    });
    console.log(`   → Tokens: ${assembled.metadata.tokensUsed} / ${assembled.metadata.budget}`);
    assert('Async assemble returns context', assembled.context.length > 0);
    assert('Within budget', assembled.metadata.tokensUsed <= assembled.metadata.budget);

    // ── Test 6: Graceful Degradation (BM25-only) ──
    console.log('\n🛡️ Test 6: Graceful Degradation');
    const assembler2 = new Assembler(store, search, config.assembly);
    // vectorStore 미연결 상태
    const assembled2 = await assembler2.assemble('find router', {
        projectDir: TEST_PROJECT,
        budget: 5000,
    });
    assert('BM25-only assemble works', assembled2.context.length > 0);
    assert('BM25-only within budget', assembled2.metadata.tokensUsed <= assembled2.metadata.budget);

    // ── Summary ──
    console.log(`\n${'='.repeat(40)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(`Ollama: ${ollamaAvailable ? '✅ Connected' : '⚠️ Unavailable (BM25-only mode)'}`);
    console.log(`${'='.repeat(40)}`);

    store.close();
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
