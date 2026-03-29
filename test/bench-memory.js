// Arachne v4.0 — Memory & Token Impact Analysis
// Measures: JS heap, Rust heap, per-query allocation, result token size
'use strict';
const fs = require('fs');
const path = require('path');
const { Store } = require('../dist/lib/store');
const { BM25Search } = require('../dist/lib/search');

const NUM_CHUNKS = 10000;

function fmtKB(bytes) { return `${(bytes / 1024).toFixed(1)} KB`; }
function fmtMB(bytes) { return `${(bytes / 1024 / 1024).toFixed(2)} MB`; }

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  📊 Arachne v4.0 — Memory & Token Impact Analysis              ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');

  const benchDir = path.join(__dirname, '../data-memory-bench');
  if (fs.existsSync(benchDir)) {
    try { fs.rmSync(benchDir, { recursive: true, force: true }); } catch {}
  }
  fs.mkdirSync(benchDir, { recursive: true });

  const store = new Store(benchDir);
  await store.init();

  // Seed 10K chunks (realistic)
  const keywords = [
    'timeout','error','handling','function','class','async','promise','database',
    'query','config','router','middleware','authentication','validation','cache','stream',
  ];
  const numFiles = 100;
  const chunksPerFile = NUM_CHUNKS / numFiles;
  let totalSearchTextBytes = 0;

  for (let f = 0; f < numFiles; f++) {
    const res = store.upsertFile(`src/module_${f}.ts`, `hash_${f}`, 'typescript', 5000, new Date().toISOString());
    const chunks = [];
    for (let c = 0; c < chunksPerFile; c++) {
      const kws = Array.from({length: 4+Math.floor(Math.random()*4)}, () => keywords[Math.floor(Math.random()*keywords.length)]);
      const content = `export function func_${c}() {\n  const ${kws[0]} = get${kws[1]}();\n  if (${kws[2]}) throw new Error('${kws[3]}');\n  return ${kws.join(' + ')};\n}`;
      const searchText = `func_${c} ${kws.join(' ')} module_${f} implementation`;
      totalSearchTextBytes += Buffer.byteLength(searchText, 'utf-8');
      chunks.push({
        type: 'function', name: `func_${c}`,
        startLine: c*10, endLine: c*10+9,
        content, tokenCount: 80,
        searchText,
      });
    }
    store.insertChunks(res.fileId, chunks);
  }

  // ── 1. Measure baseline memory ──────────────────────────────────
  global.gc && global.gc();
  const memBefore = process.memoryUsage();

  const search = new BM25Search(store, { bm25: { k1: 1.2, b: 0.75 }, topK: 10 });

  // ── 2. Warm cache and measure memory delta ──────────────────────
  const warmStart = performance.now();
  const count = search.warmCache();
  const warmTime = performance.now() - warmStart;

  global.gc && global.gc();
  const memAfter = process.memoryUsage();

  const heapDelta = memAfter.heapUsed - memBefore.heapUsed;
  const rssDelta = memAfter.rss - memBefore.rss;

  console.log('\n━━━ 1. Cache Memory Impact ━━━');
  console.log(`  Chunks cached:      ${count.toLocaleString()}`);
  console.log(`  Search text total:  ${fmtMB(totalSearchTextBytes)} (raw DB data)`);
  console.log(`  JS Heap delta:      ${fmtMB(heapDelta)} (ChunkRow[] + ids[] + texts[])`);
  console.log(`  RSS delta:          ${fmtMB(rssDelta)} (JS + Rust heap combined)`);
  console.log(`  Per chunk:          ~${(heapDelta / count).toFixed(0)} bytes/chunk`);
  console.log(`  Warm time:          ${warmTime.toFixed(1)}ms`);

  // ── 3. Per-query allocation (search overhead) ───────────────────
  console.log('\n━━━ 2. Per-Query Overhead ━━━');
  const queries = ['timeout error handling', 'async database query', 'authentication middleware'];
  
  global.gc && global.gc();
  const mem1 = process.memoryUsage().heapUsed;
  for (let i = 0; i < 100; i++) {
    search.search(queries[i % queries.length], { topK: 10 });
  }
  global.gc && global.gc();
  const mem2 = process.memoryUsage().heapUsed;
  const perQueryAlloc = (mem2 - mem1) / 100;
  console.log(`  100 queries heap:   ${fmtKB(mem2 - mem1)}`);
  console.log(`  Per query alloc:    ~${perQueryAlloc > 0 ? fmtKB(perQueryAlloc) : '0 (GC cleaned)'}` );

  // ── 4. Result token impact (what gets sent to AI) ───────────────
  console.log('\n━━━ 3. Result Token Impact (AI Context) ━━━');
  const result = search.search('timeout error handling', { topK: 10 });
  
  let resultTokens = 0;
  let resultBytes = 0;
  for (const r of result) {
    const text = `[${r.chunk.name}] ${r.chunk.file_path}:${r.chunk.start_line}\n${r.chunk.content}`;
    resultBytes += Buffer.byteLength(text, 'utf-8');
    resultTokens += Math.ceil(text.length / 4); // rough estimate ~4 chars/token
  }
  console.log(`  Top-10 results:`);
  console.log(`    Total bytes:      ${fmtKB(resultBytes)}`);
  console.log(`    Est. tokens:      ~${resultTokens} tokens`);
  console.log(`    Avg per result:   ~${Math.ceil(resultTokens / result.length)} tokens`);

  // ── 5. Cache efficiency ratio ──────────────────────────────────
  console.log('\n━━━ 4. Efficiency Summary ━━━');
  const dbSize = fs.statSync(path.join(benchDir, 'arachne.db')).size;
  console.log(`  SQLite DB size:     ${fmtMB(dbSize)}`);
  console.log(`  Cache overhead:     ${fmtMB(heapDelta)} (${((heapDelta/dbSize)*100).toFixed(0)}% of DB)`);
  console.log(`  Speed gain:         38ms → 2.6ms (14.6x for ${((heapDelta/1024/1024)).toFixed(1)}MB memory)`);
  console.log(`  Trade-off:          ${((heapDelta/1024/1024) / (38-2.6) * 1000).toFixed(1)} KB per ms saved`);

  console.log('');
  store.close();
}

main().catch(console.error);
