// Arachne v4.0 Hybrid Engine Benchmark — TS vs Rust vs sqlite-vec (3-way)
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Store } = require('../dist/lib/store');
const { VectorStore } = require('../dist/lib/vector-store');

// ── Constants ──────────────────────────────────────────────────────────
const DIMS = 768;
const BM25_DOCS = 10000;
const BM25_QUERIES = 200;
const VEC_CANDIDATES = 5000;
const VEC_QUERIES = 200;
const COSINE_PAIRS = 10000;
const CHUNKER_LINES = 5000;
const SQLITE_VEC_QUERIES = 500;
const TOP_K = 10;

// ── Load Native ────────────────────────────────────────────────────────
let native = null;
try {
  native = require('../native/arachne-native.node');
} catch {
  console.error('[WARN] Rust native module not found — Rust benchmarks skipped');
}

// ── Utilities ──────────────────────────────────────────────────────────

function bench(fn, iterations) {
  for (let i = 0; i < Math.min(3, iterations); i++) fn();
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const s = performance.now();
    fn();
    times.push(performance.now() - s);
  }
  times.sort((a, b) => a - b);
  const total = times.reduce((s, t) => s + t, 0);
  return {
    avg: total / iterations,
    median: times[Math.floor(iterations / 2)],
    p99: times[Math.floor(iterations * 0.99)],
    min: times[0],
    max: times[times.length - 1],
    total, iterations,
  };
}

function fmtMs(ms) {
  if (ms < 0.001) return `${(ms * 1000).toFixed(1)}μs`;
  if (ms < 1) return `${ms.toFixed(3)}ms`;
  return `${ms.toFixed(2)}ms`;
}

function fmtSpeedup(baseMs, targetMs) {
  if (targetMs === 0) return 'N/A';
  const r = baseMs / targetMs;
  return r >= 1 ? `🟧 ${r.toFixed(1)}x faster` : `🟦 ${(1/r).toFixed(1)}x slower`;
}

function randVec(dims) {
  const a = new Float64Array(dims);
  for (let i = 0; i < dims; i++) a[i] = Math.random() * 2 - 1;
  return a;
}

function randVecF32(dims) {
  const a = new Float32Array(dims);
  for (let i = 0; i < dims; i++) a[i] = Math.random() * 2 - 1;
  return a;
}

// ── TS Implementations ─────────────────────────────────────────────────

function tsBm25(query, ids, texts, topK, k1, b) {
  const terms = query.toLowerCase().replace(/[^a-z0-9_\s]/g, ' ').split(/\s+/).filter(t => t.length >= 2);
  if (!terms.length || !ids.length) return [];
  const n = ids.length;
  const avgDl = texts.reduce((s, t) => s + t.length, 0) / n;
  const df = {};
  for (const t of terms) df[t] = texts.filter(x => x.toLowerCase().includes(t)).length;
  const scored = [];
  for (let i = 0; i < n; i++) {
    const doc = texts[i].toLowerCase(); const dl = doc.length; let score = 0;
    for (const t of terms) {
      let tf = 0, p = 0;
      while ((p = doc.indexOf(t, p)) !== -1) { tf++; p += t.length; }
      if (!tf) continue;
      const idf = Math.log((n - (df[t]||0) + 0.5) / ((df[t]||0) + 0.5) + 1);
      score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgDl)));
    }
    if (score > 0) scored.push({ chunkId: ids[i], score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

function tsCosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function tsBatchCosine(q, cands, topK) {
  const qn = Math.sqrt(q.reduce((s, v) => s + v*v, 0));
  if (!qn) return [];
  const hits = cands.map((c, i) => {
    let d = 0, cn = 0;
    for (let j = 0; j < q.length; j++) { d += q[j]*c[j]; cn += c[j]*c[j]; }
    return cn ? { index: i, similarity: d / (qn * Math.sqrt(cn)) } : null;
  }).filter(Boolean);
  hits.sort((a, b) => b.similarity - a.similarity);
  return hits.slice(0, topK);
}

function tsEstimateTokens(text, m) { return text ? Math.ceil(text.length / (m || 3.5)) : 0; }

function tsBlockEnd(lines, start) {
  let depth = 0, found = false;
  for (let i = start; i < lines.length; i++) {
    for (const c of lines[i]) { if (c==='{') { depth++; found=true; } if (c==='}') depth--; }
    if (found && depth <= 0) return i;
  }
  return lines.length - 1;
}

function tsIndentEnd(lines, start) {
  if (start >= lines.length - 1) return start;
  const base = lines[start].search(/\S/);
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (lines[i].search(/\S/) <= base) return i - 1;
  }
  return lines.length - 1;
}

// ── Data Gen ───────────────────────────────────────────────────────────

function genBm25Data(n) {
  const kw = ['timeout','error','handling','function','class','async','promise','database',
              'query','config','router','middleware','auth','validate','cache','stream'];
  const ids = [], texts = [];
  for (let i = 0; i < n; i++) {
    ids.push(i+1);
    const w = Array.from({length: 3+Math.floor(Math.random()*4)}, () => kw[Math.floor(Math.random()*kw.length)]);
    texts.push(`module_${i} ${w.join(' ')} code chunk ${i}`);
  }
  return { ids, texts };
}

function genChunkerLines(n) {
  return Array.from({length: n}, (_, i) =>
    i%50===0 ? `function f${i}() {` : i%50===49 ? '}' : `  const x${i} = compute(${i});`
  );
}

// ══════════════════════════════════════════════════════════════════════
//                         MAIN BENCHMARK
// ══════════════════════════════════════════════════════════════════════

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  🕸️  Arachne v4.0 — 3-Way Hybrid Benchmark                    ║');
  console.log('║  TypeScript vs Rust (napi-rs) vs sqlite-vec (C++ SIMD)         ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`  Platform: ${os.platform()} ${os.arch()} | CPU: ${os.cpus()[0].model.trim()}`);
  console.log(`  Node: ${process.version} | Rust: ${native ? '✅' : '❌'}`);
  console.log('');

  const results = [];

  // ── 1. BM25 Search ─────────────────────────────────────────────────
  {
    console.log(`━━━ 1. BM25 Search (${BM25_DOCS.toLocaleString()} docs × ${BM25_QUERIES} queries) ━━━`);
    const { ids, texts } = genBm25Data(BM25_DOCS);
    const qs = ['timeout error handling','async promise database','router middleware config'];

    const ts = bench(() => tsBm25(qs[Math.floor(Math.random()*qs.length)], ids, texts, TOP_K, 1.2, 0.75), BM25_QUERIES);
    let rs = null;
    if (native) rs = bench(() => native.bm25Search(qs[Math.floor(Math.random()*qs.length)], ids, texts, TOP_K, 1.2, 0.75), BM25_QUERIES);

    console.log(`  TS:    avg ${fmtMs(ts.avg)}  med ${fmtMs(ts.median)}  p99 ${fmtMs(ts.p99)}`);
    if (rs) console.log(`  Rust:  avg ${fmtMs(rs.avg)}  med ${fmtMs(rs.median)}  p99 ${fmtMs(rs.p99)}  → ${fmtSpeedup(ts.avg, rs.avg)}`);
    results.push({ test: 'BM25 (10K docs)', ts, rust: rs, vec: null });
    console.log('');
  }

  // ── 2. Cosine Similarity (single) ──────────────────────────────────
  {
    console.log(`━━━ 2. Cosine Single (${DIMS}D × ${COSINE_PAIRS.toLocaleString()}) ━━━`);
    const a = randVec(DIMS), b = randVec(DIMS);
    const ts = bench(() => tsCosine(a, b), COSINE_PAIRS);
    let rs = null;
    if (native) rs = bench(() => native.cosineSimilarity(a, b), COSINE_PAIRS);

    console.log(`  TS:    avg ${fmtMs(ts.avg)}  med ${fmtMs(ts.median)}  p99 ${fmtMs(ts.p99)}`);
    if (rs) console.log(`  Rust:  avg ${fmtMs(rs.avg)}  med ${fmtMs(rs.median)}  p99 ${fmtMs(rs.p99)}  → ${fmtSpeedup(ts.avg, rs.avg)}`);
    results.push({ test: 'Cosine (single)', ts, rust: rs, vec: null });
    console.log('');
  }

  // ── 3. Batch Cosine ────────────────────────────────────────────────
  {
    console.log(`━━━ 3. Batch Cosine (${DIMS}D × ${VEC_CANDIDATES.toLocaleString()} cands × ${VEC_QUERIES}) ━━━`);
    const q = randVec(DIMS);
    const cands = Array.from({length: VEC_CANDIDATES}, () => randVec(DIMS));
    const ts = bench(() => tsBatchCosine(Array.from(q), cands.map(c => Array.from(c)), TOP_K), VEC_QUERIES);
    let rs = null;
    if (native) rs = bench(() => native.batchCosineSimilarity(q, cands, TOP_K), VEC_QUERIES);

    console.log(`  TS:    avg ${fmtMs(ts.avg)}  med ${fmtMs(ts.median)}  p99 ${fmtMs(ts.p99)}`);
    if (rs) console.log(`  Rust:  avg ${fmtMs(rs.avg)}  med ${fmtMs(rs.median)}  p99 ${fmtMs(rs.p99)}  → ${fmtSpeedup(ts.avg, rs.avg)}`);
    results.push({ test: 'BatchCosine (5K)', ts, rust: rs, vec: null });
    console.log('');
  }

  // ── 4. sqlite-vec KNN (C++ SIMD in-database) ──────────────────────
  {
    console.log(`━━━ 4. sqlite-vec KNN (${DIMS}D × ${BM25_DOCS.toLocaleString()} vectors × ${SQLITE_VEC_QUERIES} queries) ━━━`);
    const benchDir = path.join(__dirname, '../data-hybrid-bench');
    if (fs.existsSync(benchDir)) {
      try { fs.rmSync(benchDir, { recursive: true, force: true }); } catch {}
    }
    fs.mkdirSync(benchDir, { recursive: true });

    const store = new Store(benchDir);
    await store.init();

    const mockEmbed = { isAvailable: async () => true, dimensions: DIMS, embed: async () => Array.from({length: DIMS}, () => Math.random()) };
    const vstore = new VectorStore(store, mockEmbed);
    await vstore.init();

    // Insert chunks + vectors
    console.log(`  Seeding ${BM25_DOCS.toLocaleString()} chunks + vectors...`);
    const numFiles = 100;
    const chunksPerFile = BM25_DOCS / numFiles;

    for (let f = 0; f < numFiles; f++) {
      const res = store.upsertFile(`file_${f}.ts`, `hash_${f}`, 'typescript', 1000, new Date().toISOString());
      const chunks = [];
      for (let c = 0; c < chunksPerFile; c++) {
        chunks.push({
          type: 'function', name: `func_${c}`,
          startLine: c*10, endLine: c*10+9,
          content: `function func_${c}() { code }`,
          tokenCount: 50,
          searchText: `timeout error handling code sample ${f*chunksPerFile+c}`,
        });
      }
      store.insertChunks(res.fileId, chunks);
    }

    // Insert vectors via raw SQL
    store.db.transaction(() => {
      const ins = store.db.prepare('INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)');
      const meta = store.db.prepare('INSERT INTO embeddings_meta (chunk_id, dimensions) VALUES (?, ?)');
      for (let i = 1; i <= BM25_DOCS; i++) {
        ins.run(BigInt(i), randVecF32(DIMS));
        meta.run(BigInt(i), DIMS);
      }
    })();

    const vecCount = store.db.prepare('SELECT count(*) as c FROM vec_chunks').pluck().get();
    console.log(`  DB ready: ${vecCount} vectors`);

    // Prepare query vec
    const queryVec = randVecF32(DIMS);
    const knnStmt = store.db.prepare(`
      SELECT rowid, distance FROM vec_chunks
      WHERE embedding MATCH ? ORDER BY distance LIMIT ?
    `);

    // sqlite-vec KNN benchmark
    const vecStats = bench(() => knnStmt.all(queryVec, TOP_K), SQLITE_VEC_QUERIES);

    // SQLite FTS5 / LIKE benchmark
    const likeStmt = store.db.prepare(`
      SELECT c.id, c.search_text FROM chunks c
      WHERE LOWER(c.search_text) LIKE '%timeout%' AND LOWER(c.search_text) LIKE '%error%'
      LIMIT ?
    `);
    const ftsStats = bench(() => likeStmt.all(TOP_K), SQLITE_VEC_QUERIES);

    console.log(`  sqlite-vec KNN:  avg ${fmtMs(vecStats.avg)}  med ${fmtMs(vecStats.median)}  p99 ${fmtMs(vecStats.p99)}`);
    console.log(`  SQLite LIKE:     avg ${fmtMs(ftsStats.avg)}  med ${fmtMs(ftsStats.median)}  p99 ${fmtMs(ftsStats.p99)}`);
    results.push({ test: 'sqlite-vec KNN', ts: null, rust: null, vec: vecStats });
    results.push({ test: 'SQLite LIKE', ts: null, rust: null, vec: ftsStats });

    store.close();
    console.log('');
  }

  // ── 5. Token Estimator ─────────────────────────────────────────────
  {
    const text = 'a'.repeat(10000);
    const iters = 50000;
    console.log(`━━━ 5. Token Estimator (10KB × ${iters.toLocaleString()}) ━━━`);
    const ts = bench(() => tsEstimateTokens(text, 3.5), iters);
    let rs = null;
    if (native) rs = bench(() => native.estimateTokensRs(text, 3.5), iters);
    console.log(`  TS:    avg ${fmtMs(ts.avg)}  med ${fmtMs(ts.median)}`);
    if (rs) console.log(`  Rust:  avg ${fmtMs(rs.avg)}  med ${fmtMs(rs.median)}  → ${fmtSpeedup(ts.avg, rs.avg)}`);
    results.push({ test: 'TokenEstimator', ts, rust: rs, vec: null });
    console.log('');
  }

  // ── 6. Block End Finder ────────────────────────────────────────────
  {
    const lines = genChunkerLines(CHUNKER_LINES);
    const iters = 5000;
    console.log(`━━━ 6. Block End Finder (${CHUNKER_LINES.toLocaleString()} lines × ${iters.toLocaleString()}) ━━━`);
    const ts = bench(() => tsBlockEnd(lines, 0), iters);
    let rs = null;
    if (native) rs = bench(() => native.findBlockEndRs(lines, 0), iters);
    console.log(`  TS:    avg ${fmtMs(ts.avg)}  med ${fmtMs(ts.median)}`);
    if (rs) console.log(`  Rust:  avg ${fmtMs(rs.avg)}  med ${fmtMs(rs.median)}  → ${fmtSpeedup(ts.avg, rs.avg)}`);
    results.push({ test: 'BlockEndFinder', ts, rust: rs, vec: null });
    console.log('');
  }

  // ── 7. File Scanner ────────────────────────────────────────────────
  if (native) {
    const dir = path.resolve(__dirname, '../src');
    console.log(`━━━ 7. File Scanner (Rust-only, ${dir}) ━━━`);
    const rs = bench(() => native.scanFiles(dir, ['ts','js','json'], ['node_modules','dist'], 500000), 50);
    const test = native.scanFiles(dir, ['ts','js','json'], ['node_modules','dist'], 500000);
    console.log(`  Rust:  avg ${fmtMs(rs.avg)}  med ${fmtMs(rs.median)}  files: ${test.files.length}`);
    results.push({ test: 'FileScanner', ts: null, rust: rs, vec: null });
    console.log('');
  }

  // ── Summary ────────────────────────────────────────────────────────
  console.log('╔═══════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                            📊 SUMMARY TABLE                                     ║');
  console.log('╠══════════════════════╦═══════════════╦═══════════════╦═══════════════╦════════════╣');
  console.log('║ Test                 ║ TS (avg)      ║ Rust (avg)    ║ vec/DB (avg)  ║ Winner     ║');
  console.log('╠══════════════════════╬═══════════════╬═══════════════╬═══════════════╬════════════╣');

  for (const r of results) {
    const name = r.test.padEnd(20);
    const tsV = r.ts ? fmtMs(r.ts.avg).padEnd(13) : '—'.padEnd(13);
    const rsV = r.rust ? fmtMs(r.rust.avg).padEnd(13) : '—'.padEnd(13);
    const vecV = r.vec ? fmtMs(r.vec.avg).padEnd(13) : '—'.padEnd(13);

    let winner = '—';
    const vals = [];
    if (r.ts) vals.push({ label: 'TS', ms: r.ts.avg });
    if (r.rust) vals.push({ label: 'Rust', ms: r.rust.avg });
    if (r.vec) vals.push({ label: 'DB', ms: r.vec.avg });
    if (vals.length > 0) {
      vals.sort((a, b) => a.ms - b.ms);
      winner = vals[0].label;
    }
    console.log(`║ ${name} ║ ${tsV} ║ ${rsV} ║ ${vecV} ║ ${winner.padEnd(10)} ║`);
  }

  console.log('╚══════════════════════╩═══════════════╩═══════════════╩═══════════════╩════════════╝');

  // ── JSON Report ────────────────────────────────────────────────────
  const report = {
    timestamp: new Date().toISOString(),
    platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0].model.trim(),
    nodeVersion: process.version, rustAvailable: !!native,
    benchmarks: results.map(r => ({
      test: r.test,
      ts: r.ts ? { avgMs: +r.ts.avg.toFixed(4), medMs: +r.ts.median.toFixed(4), p99Ms: +r.ts.p99.toFixed(4) } : null,
      rust: r.rust ? { avgMs: +r.rust.avg.toFixed(4), medMs: +r.rust.median.toFixed(4), p99Ms: +r.rust.p99.toFixed(4) } : null,
      vec: r.vec ? { avgMs: +r.vec.avg.toFixed(4), medMs: +r.vec.median.toFixed(4), p99Ms: +r.vec.p99.toFixed(4) } : null,
      speedup: (r.ts && r.rust) ? +(r.ts.avg / r.rust.avg).toFixed(2) : null,
    })),
  };
  const rp = path.join(__dirname, '../data-hybrid-bench/benchmark-report.json');
  fs.mkdirSync(path.dirname(rp), { recursive: true });
  fs.writeFileSync(rp, JSON.stringify(report, null, 2));
  console.log(`\n📄 Report: ${rp}`);
}

main().catch(console.error);
