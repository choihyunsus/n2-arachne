'use strict';
const fs = require('fs');
const path = require('path');

let native;
try { native = require('../native/arachne-native.node'); } catch(e) { console.error('Rust module not found'); process.exit(1); }

// Simulate a 1GB string corpus without writing to SQLite to save time
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  🔥 1GB Corpus — Extreme Scale Memory stability Test             ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');

  // Let's use 200,000 chunks of 5000 chars = 1,000,000,000 bytes = 1GB
  const CHUNK_COUNT = 200000;
  const CHARS_PER_CHUNK = 5000;

  console.log(`\n  [1] Generating ${CHUNK_COUNT.toLocaleString()} chunks (~1 GB search text)...`);
  
  // We don't want to OOM Node generating 1GB of distinct strings.
  // V8 max string size is 1GB, max heap size is ~2GB by default.
  // We'll generate an array of chunks in chunks
  
  const ids = [];
  const baseString = "export function sample() { const target = compute(); return target; } ".repeat(100); 
  // base string is ~7000 chars long

  const texts = [];
  for(let i=0; i<CHUNK_COUNT; i++) {
    ids.push(i+1);
    texts.push(baseString.slice(0, CHARS_PER_CHUNK - 20) + ` token_target_${i} end`);
  }

  const totalBytes = texts.reduce((s,t) => s + t.length, 0);
  console.log(`  Target corpus size: ${(totalBytes/1024/1024).toFixed(2)} MB`);

  global.gc && global.gc();
  const mem0 = process.memoryUsage();

  console.log(`\n  [2] Heating up Rust Cache (Zero-Marshaling FFI transfer)...`);
  const s1 = performance.now();
  
  // Simulate warmCache by transferring to Rust
  native.bm25InitStore(ids, texts);
  
  const marshalMs = performance.now() - s1;
  console.log(`  Transfer + Indexing time: ${marshalMs.toFixed(0)} ms`);

  // Force GC on JS side. 
  // In our old architecture, returning 1GB of vectors back to JS would crash here.
  // Since we push to Rust and keep in Rust, JS heap should be clean.
  global.gc && global.gc();
  const mem1 = process.memoryUsage();
  
  console.log('\n━━━ V8 Memory Impact ━━━');
  console.log(`  Starting Heap: ${(mem0.heapUsed/1024/1024).toFixed(1)} MB`);
  console.log(`  Current Heap:  ${(mem1.heapUsed/1024/1024).toFixed(1)} MB`);
  console.log(`  Native RSS:    ${((mem1.rss - mem0.rss)/1024/1024).toFixed(1)} MB (Safe out-of-V8 heap)`);

  console.log(`\n  [3] Executing BM25 Queries over 1GB native cache...`);
  const queries = ['token_target_1500', 'compute target return', 'not_found_token'];
  const times = [];
  
  // Warmup
  for(let i=0; i<3; i++) native.bm25SearchCached(queries[1], 10, 1.2, 0.75);

  // Bench
  for(let i=0; i<30; i++) {
    const s = performance.now();
    native.bm25SearchCached(queries[i % 3], 10, 1.2, 0.75);
    times.push(performance.now() - s);
  }
  
  times.sort((a,b)=>a-b);
  const avg = times.reduce((s,t)=>s+t,0)/times.length;
  console.log('\n━━━ Search Speed (1GB corpus) ━━━');
  console.log(`  Average Latency: ${avg.toFixed(2)}ms`); 
}

main().catch(console.error);
