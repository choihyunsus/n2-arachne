// Quick scale memory test — 10MB search text corpus
'use strict';
const fs = require('fs');
const path = require('path');
const { Store } = require('../dist/lib/store');
const { BM25Search } = require('../dist/lib/search');

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  📊 10MB Corpus — Memory & Speed Impact                        ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');

  const benchDir = path.join(__dirname, '../data-10mb-bench');
  if (fs.existsSync(benchDir)) { try { fs.rmSync(benchDir, { recursive: true, force: true }); } catch {} }
  fs.mkdirSync(benchDir, { recursive: true });

  const store = new Store(benchDir);
  await store.init();

  // Seed ~10MB of search text (50K chunks × ~200 bytes each)
  const keywords = ['timeout','error','handling','function','class','async','promise','database','query','config','router','middleware','authentication','validation','cache','stream','buffer','socket'];
  const NUM_CHUNKS = 50000;
  const numFiles = 500;
  const chunksPerFile = NUM_CHUNKS / numFiles;
  let totalSearchBytes = 0;

  console.log(`\n  Seeding ${NUM_CHUNKS.toLocaleString()} chunks (~10MB search text)...`);
  for (let f = 0; f < numFiles; f++) {
    const res = store.upsertFile(`src/mod_${f}.ts`, `h_${f}`, 'typescript', 5000, new Date().toISOString());
    const chunks = [];
    for (let c = 0; c < chunksPerFile; c++) {
      const kws = Array.from({length:8+Math.floor(Math.random()*8)}, () => keywords[Math.floor(Math.random()*keywords.length)]);
      const content = `export function fn_${c}() { const ${kws.join(' = ')}; return ${kws[0]}; }`;
      const searchText = `fn_${c} ${kws.join(' ')} module_${f} implementation details description`;
      totalSearchBytes += searchText.length;
      chunks.push({ type:'function', name:`fn_${c}`, startLine:c*5, endLine:c*5+4, content, tokenCount:60, searchText });
    }
    store.insertChunks(res.fileId, chunks);
  }
  console.log(`  Search text total: ${(totalSearchBytes/1024/1024).toFixed(2)} MB`);

  const search = new BM25Search(store, { bm25: { k1: 1.2, b: 0.75 }, topK: 10 });

  // Memory before
  global.gc && global.gc();
  const mem0 = process.memoryUsage();

  // Warm cache
  const ws = performance.now();
  search.warmCache();
  const warmMs = performance.now() - ws;

  global.gc && global.gc();
  const mem1 = process.memoryUsage();

  console.log('\n━━━ Memory Impact ━━━');
  console.log(`  JS Heap:  +${((mem1.heapUsed-mem0.heapUsed)/1024/1024).toFixed(1)} MB`);
  console.log(`  RSS:      +${((mem1.rss-mem0.rss)/1024/1024).toFixed(1)} MB`);
  console.log(`  Warm:     ${warmMs.toFixed(0)}ms`);
  console.log(`  Bloat:    ${((mem1.rss-mem0.rss)/totalSearchBytes).toFixed(1)}x vs raw data`);

  // Search speed
  const queries = ['timeout error handling','async database query','authentication middleware'];
  const times = [];
  for (let i = 0; i < 5; i++) search.search(queries[0], { topK: 10 }); // warmup
  for (let i = 0; i < 50; i++) {
    const s = performance.now();
    search.search(queries[i%3], { topK: 10 });
    times.push(performance.now() - s);
  }
  times.sort((a,b)=>a-b);
  const avg = times.reduce((s,t)=>s+t,0)/times.length;
  const med = times[Math.floor(times.length/2)];

  console.log('\n━━━ Search Speed (50K chunks) ━━━');
  console.log(`  avg: ${avg.toFixed(2)}ms  med: ${med.toFixed(2)}ms`);
  console.log(`  PLAN target: < 5ms → ${avg < 5 ? '✅' : avg < 10 ? '⚠️' : '❌'}`);

  store.close();
}

main().catch(console.error);
