// Arachne v4.0 — Cached Pipeline Benchmark
// Tests warm cache (in-memory) vs cold (DB load every call) vs PLAN target
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Store } = require('../dist/lib/store');
const { BM25Search } = require('../dist/lib/search');

const NUM_CHUNKS = 10000;
const QUERIES = 200;
const TOP_K = 10;

function bench(fn, iters) {
  for (let i = 0; i < 5; i++) fn(); // warmup
  const times = [];
  for (let i = 0; i < iters; i++) {
    const s = performance.now();
    fn();
    times.push(performance.now() - s);
  }
  times.sort((a, b) => a - b);
  return { avg: times.reduce((s,t) => s+t,0) / iters, median: times[Math.floor(iters/2)], p99: times[Math.floor(iters*0.99)] };
}
function fmtMs(ms) { return ms < 1 ? `${(ms*1000).toFixed(0)}μs` : `${ms.toFixed(2)}ms`; }

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  🕸️  Arachne v4.0 — Cached Pipeline Benchmark                 ║');
  console.log('║  Cold (DB load) vs Warm (in-memory cache) vs PLAN target       ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`  CPU: ${os.cpus()[0].model.trim()} | Node: ${process.version}`);

  // ── Setup ─────────────────────────────────────────────────────────
  const benchDir = path.join(__dirname, '../data-cache-bench');
  if (fs.existsSync(benchDir)) {
    try { fs.rmSync(benchDir, { recursive: true, force: true }); } catch {}
  }
  fs.mkdirSync(benchDir, { recursive: true });

  const store = new Store(benchDir);
  await store.init();

  // Seed realistic chunks (10K)
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
  console.log(`  DB ready: ${store.db.prepare('SELECT count(*) as c FROM chunks').pluck().get()} chunks`);

  const queries = [
    'timeout error handling',
    'async database query config',
    'authentication middleware router',
    'stream buffer socket request',
    'cache validation session token',
    'promise response header cookie',
    'function class module implementation',
  ];

  const search = new BM25Search(store, { bm25: { k1: 1.2, b: 0.75 }, topK: TOP_K });

  // ── Test 1: COLD — invalidate cache each time ──────────────────────
  console.log(`\n━━━ 1. COLD: DB load every query (no cache) ━━━`);
  const coldStats = bench(() => {
    search.invalidateCache();
    search.search(queries[Math.floor(Math.random() * queries.length)], { topK: TOP_K });
  }, QUERIES);
  console.log(`  avg: ${fmtMs(coldStats.avg)}  med: ${fmtMs(coldStats.median)}  p99: ${fmtMs(coldStats.p99)}`);

  // ── Test 2: WARM — cache pre-loaded ────────────────────────────────
  console.log('\n━━━ 2. WARM: In-memory cache (DB load once) ━━━');
  const warmStart = performance.now();
  const cachedCount = search.warmCache();
  const warmTime = performance.now() - warmStart;
  console.log(`  Cache warm: ${fmtMs(warmTime)} (${cachedCount} chunks loaded)`);

  const warmStats = bench(() => {
    search.search(queries[Math.floor(Math.random() * queries.length)], { topK: TOP_K });
  }, QUERIES);
  console.log(`  avg: ${fmtMs(warmStats.avg)}  med: ${fmtMs(warmStats.median)}  p99: ${fmtMs(warmStats.p99)}`);

  // ── Test 3: Verify results are identical ──────────────────────────
  console.log('\n━━━ 3. Result Verification ━━━');
  search.invalidateCache();
  const coldResults = search.search('timeout error handling', { topK: 5 });
  search.warmCache();
  const warmResults = search.search('timeout error handling', { topK: 5 });
  const match = coldResults.length === warmResults.length &&
    coldResults.every((r, i) => r.chunk.id === warmResults[i].chunk.id);
  console.log(`  Cold vs Warm results: ${match ? '✅ IDENTICAL' : '❌ MISMATCH'}`);

  // ── Summary ────────────────────────────────────────────────────────
  const { isNativeAvailable } = require('../dist/lib/native-bridge');
  const rustUsed = isNativeAvailable();
  const speedup = coldStats.avg / warmStats.avg;

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║                        📊 FINAL COMPARISON                         ║');
  console.log('╠══════════════════════════════════════════════════════════════════════╣');
  console.log(`║  Engine:         ${rustUsed ? '🦀 Rust (memchr + rayon)' : '🟦 TypeScript'}                            ║`);
  console.log(`║  COLD (no cache): ${fmtMs(coldStats.avg).padEnd(10)} / query  (DB load every time)       ║`);
  console.log(`║  WARM (cached):   ${fmtMs(warmStats.avg).padEnd(10)} / query  (in-memory, zero DB)      ║`);
  console.log(`║  Speedup:         ${speedup.toFixed(1)}x                                           ║`);
  console.log(`║  PLAN target:     < 5ms                                             ║`);
  console.log(`║  Status:          ${warmStats.avg < 5 ? '✅ TARGET MET!' : warmStats.avg < 10 ? '⚠️ Close' : '❌ Not met'}                                           ║`);
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  store.close();
}

main().catch(console.error);
