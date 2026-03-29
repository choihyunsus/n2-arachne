// 10,000 chunks benchmark showing true hybrid engine (sqlite-vec) speed
'use strict';
const fs = require('fs');
const path = require('path');
const { Store } = require('../dist/lib/store');
const { VectorStore } = require('../dist/lib/vector-store');

async function bench(label, fn, iterations) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) await fn();
    const elapsed = performance.now() - start;
    return { label, elapsed, opsPerSec: Math.round(iterations / (elapsed / 1000)) };
}

async function main() {
    console.log('\n=== REAL Hybrid Engine Benchmark (sqlite-vec C++ SIMD) ===\n');

    const testDir = path.join(__dirname, '../data-hybrid-bench');
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    fs.mkdirSync(testDir, { recursive: true });

    const store = new Store(testDir, false);
    await store.init();

    // Mock Embedding class
    const mockEmbedding = {
        isAvailable: async () => true,
        dimensions: 768,
        embed: async () => Array.from({ length: 768 }, () => Math.random())
    };

    const vstore = new VectorStore(store, mockEmbedding);
    await vstore.init();

    const numChunks = 10000;
    console.log(`Inserting ${numChunks} chunks (Mock 768D embeddings)...`);

    const dims = 768;
    const numFiles = 100;
    const chunksPerFile = numChunks / numFiles;

    let globalChunkId = 0;

    for (let f = 0; f < numFiles; f++) {
        const res = store.upsertFile(`file_${f}.ts`, 'hash', 'typescript', 1000, new Date().toISOString());
        const fileId = res.fileId;

        const fileChunks = [];
        for (let c = 0; c < chunksPerFile; c++) {
            globalChunkId++;
            const vec = new Float64Array(dims);
            for (let d = 0; d < dims; d++) vec[d] = Math.random();

            const chunkRecord = {
                type: 'function',
                name: `func_${c}`,
                startLine: c * 10,
                endLine: c * 10 + 9,
                content: `function func_${c}() { /* timeout error handling code */ }`,
                tokenCount: 50,
                searchText: `timeout error handling code sample ${globalChunkId}`
            };

            fileChunks.push(chunkRecord);
        }
        store.insertChunks(fileId, fileChunks);
    }

    console.log(`Inserting ${numChunks} vectors manually into vec_chunks...`);
    store.db.transaction(() => {
        const insertVec = store.db.prepare('INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)');
        for (let i = 1; i <= numChunks; i++) {
            const vec = new Float32Array(dims);
            for (let d = 0; d < dims; d++) vec[d] = Math.random();
            insertVec.run(BigInt(i), Buffer.from(vec.buffer)); // BigInt fixes sqlite-vec strict integer check
        }
        const updateMeta = store.db.prepare('INSERT INTO embeddings_meta (chunk_id, dimensions) VALUES (?, ?)');
        for (let i = 1; i <= numChunks; i++) {
            updateMeta.run(BigInt(i), dims);
        }
    })();

    console.log(`Ready. DB contains ${store.db.prepare('SELECT COUNT(*) FROM chunks').pluck().get()} chunks.`);
    console.log(`Vectors initialized: ${store.db.prepare('SELECT count(*) FROM vec_chunks').pluck().get()} vectors.\n`);

    const queryVec = [];
    for (let d = 0; d < dims; d++) queryVec.push(Math.random());

    await new Promise(r => setTimeout(r, 1000));

    const queryText = "timeout error handling";

    console.log(`Searching across ${numChunks} items (Top 10 results, 1,000 queries)`);
    console.log(`-----------------------------------------------------------------`);

    // FTS5 Benchmark
    const bm25Res = await bench('SQLite FTS5 (BM25)', async () => {
        store.searchChunks(queryText, 10);
    }, 1000);

    // Semantic Benchmark
    const semRes = await bench('sqlite-vec (Semantic KNN)', async () => {
        await vstore.search(queryText, 10);
    }, 1000);

    console.log(` 1. BM25 Search (SQLite FTS5):      ${(bm25Res.elapsed / 1000).toFixed(2)} ms/query (${bm25Res.opsPerSec.toLocaleString()} ops/sec)`);
    console.log(` 2. Semantic Search (sqlite-vec):   ${(semRes.elapsed / 1000).toFixed(2)} ms/query (${semRes.opsPerSec.toLocaleString()} ops/sec)`);

    console.log(`\n> RESULT: A C++ SIMD vector search over 10,000 vectors runs in ${(semRes.elapsed / 1000).toFixed(2)} ms!`);
    console.log(`> That is equivalent to ranking 7.6 Million dimensions blazing fast.`);

    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
}

main().catch(console.error);
