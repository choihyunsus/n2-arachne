// Arachne v4.0 Production Pipeline Benchmark
// Tests the ACTUAL search pipeline (BM25Search class) not raw functions
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Store } = require('../dist/lib/store');
const { VectorStore } = require('../dist/lib/vector-store');
const { BM25Search } = require('../dist/lib/search');

const DIMS = 768;
const NUM_CHUNKS = 10000;
const QUERIES = 100;
const TOP_K = 10;

function bench(fn, iters) {
  for (let i = 0; i < 3; i++) fn();
  const times = [];
  for (let i = 0; i < iters; i++) {
    const s = performance.now();
    fn();
    times.push(performance.now() - s);
  }
  times.sort((a, b) => a - b);
  return { avg: times.reduce((s,t) => s+t,0) / iters, median: times[Math.floor(iters/2)], p99: times[Math.floor(iters*0.99)] };
}
function fmtMs(ms) { return ms < 1 ? `${ms.toFixed(3)}ms` : `${ms.toFixed(2)}ms`; }
function randVecF32(dims) {
  const a = new Float32Array(dims);
  for (let i = 0; i < dims; i++) a[i] = Math.random() * 2 - 1;
  return a;
}

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  🕸️  Arachne v4.0 — Production Pipeline Benchmark             ║');
  console.log('║  Actual BM25Search class + VectorStore (Rust ↔ TS fallback)    ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`  CPU: ${os.cpus()[0].model.trim()} | Node: ${process.version}`);

  // ── Setup DB with real data ────────────────────────────────────────
  const benchDir = path.join(__dirname, '../data-pipeline-bench');
  if (fs.existsSync(benchDir)) {
    try { fs.rmSync(benchDir, { recursive: true, force: true }); } catch {}
  }
  fs.mkdirSync(benchDir, { recursive: true });

  const store = new Store(benchDir);
  await store.init();

  // Seed realistic chunks
  console.log(`\n  Seeding ${NUM_CHUNKS.toLocaleString()} chunks...`);
  const keywords = [
    'timeout','error','handling','function','class','async','promise','database',
    'query','config','router','middleware','authentication','validation','cache','stream',
    'buffer','socket','request','response','header','session','cookie','token',
  ];
  const numFiles = 100;
  const chunksPerFile = NUM_CHUNKS / numFiles;

  for (let f = 0; f < numFiles; f++) {
    const res = store.upsertFile(`src/module_${f}.ts`, `hash_${f}`, 'typescript', 5000, new Date().toISOString());
    const chunks = [];
    for (let c = 0; c < chunksPerFile; c++) {
      const kws = Array.from({length: 4+Math.floor(Math.random()*4)}, () => keywords[Math.floor(Math.random()*keywords.length)]);
      const content = `export function func_${c}() {\n  const ${kws[0]} = get${kws[1]}();\n  if (${kws[2]}) throw new Error('${kws[3]}');\n  return ${kws.join(' + ')};\n}`;
      chunks.push({
        type: 'function', name: `func_${c}`,
        startLine: c*10, endLine: c*10+9,
        content,
        tokenCount: 80,
        searchText: `func_${c} ${kws.join(' ')} module_${f} implementation`,
      });
    }
    store.insertChunks(res.fileId, chunks);
  }

  // Seed vectors for semantic search
  const mockEmbed = { isAvailable: async () => true, dimensions: DIMS, embed: async () => Array.from({length: DIMS}, () => Math.random()) };
  const vstore = new VectorStore(store, mockEmbed);
  await vstore.init();

  console.log('  Seeding vectors...');
  store.db.transaction(() => {
    const ins = store.db.prepare('INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)');
    const meta = store.db.prepare('INSERT INTO embeddings_meta (chunk_id, dimensions) VALUES (?, ?)');
    for (let i = 1; i <= NUM_CHUNKS; i++) {
      ins.run(BigInt(i), randVecF32(DIMS));
      meta.run(BigInt(i), DIMS);
    }
  })();
  console.log(`  DB ready: ${store.db.prepare('SELECT count(*) as c FROM chunks').pluck().get()} chunks, ${store.db.prepare('SELECT count(*) as c FROM vec_chunks').pluck().get()} vectors`);

  // ── Test 1: BM25Search.search() via production class ───────────────
  const queries = [
    'timeout error handling',
    'async database query config',
    'authentication middleware router',
    'stream buffer socket request',
    'cache validation session token',
  ];

  // With Rust native
  const searchRust = new BM25Search(store, { bm25: { k1: 1.2, b: 0.75 }, topK: TOP_K });
  console.log('\n━━━ 1. Production BM25Search.search() ━━━');
  const prodStats = bench(() => {
    searchRust.search(queries[Math.floor(Math.random() * queries.length)], { topK: TOP_K });
  }, QUERIES);

  // Check if native was used
  const { isNativeAvailable } = require('../dist/lib/native-bridge');
  const nativeUsed = isNativeAvailable();

  console.log(`  Engine:    ${nativeUsed ? '🦀 Rust (memchr + rayon)' : '🟦 TypeScript fallback'}`);
  console.log(`  Pipeline:  DB load → ${nativeUsed ? 'Rust BM25' : 'TS BM25'} → bonus → sort`);
  console.log(`  Result:    avg ${fmtMs(prodStats.avg)}  med ${fmtMs(prodStats.median)}  p99 ${fmtMs(prodStats.p99)}`);

  // ── Test 2: sqlite-vec KNN (baseline) ──────────────────────────────
  console.log('\n━━━ 2. sqlite-vec KNN Search (C++ SIMD, baseline) ━━━');
  const queryVec = randVecF32(DIMS);
  const knnStmt = store.db.prepare('SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT ?');
  const vecStats = bench(() => knnStmt.all(queryVec, TOP_K), QUERIES);
  console.log(`  Engine:    C++ SIMD (sqlite-vec)`)
  console.log(`  Result:    avg ${fmtMs(vecStats.avg)}  med ${fmtMs(vecStats.median)}  p99 ${fmtMs(vecStats.p99)}`);

  // ── Test 3: Rust batchCosineSimilarity (if native available) ───────
  let batchStats = null;
  let native = null;
  try { native = require('../native/arachne-native.node'); } catch {}
  if (native) {
    console.log('\n━━━ 3. Rust Batch Cosine (simulated searchNative path) ━━━');
    // Simulate: load vectors from DB + Rust batch cosine
    const allRows = store.db.prepare('SELECT rowid, embedding FROM vec_chunks').all();
    const chunkIds = allRows.map(r => Number(r.rowid));
    const candidates = allRows.map(r => {
      const f32 = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
      return Float64Array.from(f32);
    });
    const queryF64 = Float64Array.from(randVecF32(DIMS));

    // Benchmark: DB load time (one-time) + Rust search
    const loadTime = (() => {
      const s = performance.now();
      const rows = store.db.prepare('SELECT rowid, embedding FROM vec_chunks').all();
      rows.map(r => {
        const f32 = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
        return Float64Array.from(f32);
      });
      return performance.now() - s;
    })();

    const rustSearchStats = bench(() => {
      native.batchCosineSimilarity(queryF64, candidates, TOP_K);
    }, QUERIES);

    batchStats = { loadMs: loadTime, searchMs: rustSearchStats.avg, totalMs: loadTime + rustSearchStats.avg };
    console.log(`  DB Load:   ${fmtMs(loadTime)} (one-time, ${allRows.length} vectors × ${DIMS}D)`);
    console.log(`  Search:    avg ${fmtMs(rustSearchStats.avg)}  med ${fmtMs(rustSearchStats.median)}`);
    console.log(`  Total:     ${fmtMs(batchStats.totalMs)} (load + search)`);
    console.log(`  vs vec:    ${vecStats.avg > rustSearchStats.avg ? `🦀 Rust search ${(vecStats.avg / rustSearchStats.avg).toFixed(1)}x faster (search only)` : '🟢 sqlite-vec faster'}`);
  }

  // ── Summary ────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║                       📊 PRODUCTION SUMMARY                    ║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  console.log(`║  BM25 Pipeline (${NUM_CHUNKS/1000}K chunks):  ${fmtMs(prodStats.avg)} / query  [${nativeUsed ? '🦀 Rust' : 'TS'}]`);
  console.log(`║  sqlite-vec KNN (${NUM_CHUNKS/1000}K vectors): ${fmtMs(vecStats.avg)} / query  [C++ SIMD]`);
  if (batchStats) {
    console.log(`║  Rust Batch Cosine:         ${fmtMs(batchStats.searchMs)} search + ${fmtMs(batchStats.loadMs)} load`);
  }
  console.log('╚══════════════════════════════════════════════════════════════════╝');

  store.close();
}

main().catch(console.error);
