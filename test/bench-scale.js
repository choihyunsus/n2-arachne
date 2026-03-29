// Arachne Scale Benchmark — Real-world data sizes (10MB+ corpus)
// Tests BM25 at various data scales to find the TS↔Rust crossover point
'use strict';
const os = require('os');

let native = null;
try { native = require('../native/arachne-native.node'); } catch {}

function bench(fn, iters) {
  for (let i = 0; i < 3; i++) fn();
  const times = [];
  for (let i = 0; i < iters; i++) {
    const s = performance.now();
    fn();
    times.push(performance.now() - s);
  }
  times.sort((a, b) => a - b);
  return { avg: times.reduce((s,t) => s+t, 0) / iters, median: times[Math.floor(iters/2)] };
}

function fmtMs(ms) { return ms < 1 ? `${ms.toFixed(3)}ms` : `${ms.toFixed(1)}ms`; }

// TS BM25 implementation
function tsBm25(query, ids, texts, topK, k1, b) {
  const terms = query.toLowerCase().replace(/[^a-z0-9_\s]/g, ' ').split(/\s+/).filter(t => t.length >= 2);
  if (!terms.length) return [];
  const n = ids.length;
  const avgDl = texts.reduce((s, t) => s + t.length, 0) / n;
  const df = {};
  for (const t of terms) df[t] = texts.filter(x => x.toLowerCase().includes(t)).length;
  const scored = [];
  for (let i = 0; i < n; i++) {
    const doc = texts[i].toLowerCase();
    const dl = doc.length;
    let score = 0;
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

// Generate realistic code-like text chunks
function genRealisticChunk(avgChars) {
  const keywords = [
    'function', 'const', 'let', 'return', 'async', 'await', 'import', 'export',
    'class', 'constructor', 'this', 'throw', 'Error', 'try', 'catch', 'finally',
    'timeout', 'error', 'handling', 'database', 'query', 'config', 'router',
    'middleware', 'authentication', 'validation', 'serialize', 'transform',
    'interface', 'type', 'extends', 'implements', 'private', 'public', 'static',
    'Promise', 'Observable', 'subscribe', 'unsubscribe', 'EventEmitter',
    'request', 'response', 'header', 'body', 'session', 'cookie', 'token',
    'parse', 'stringify', 'buffer', 'stream', 'pipe', 'readable', 'writable',
  ];
  const lines = [];
  let chars = 0;
  while (chars < avgChars) {
    const lineLen = 40 + Math.floor(Math.random() * 80);
    const words = [];
    let lineChars = 0;
    while (lineChars < lineLen) {
      const w = keywords[Math.floor(Math.random() * keywords.length)];
      words.push(w);
      lineChars += w.length + 1;
    }
    const line = '  ' + words.join(' ') + ';';
    lines.push(line);
    chars += line.length + 1;
  }
  return lines.join('\n');
}

function genCorpus(numChunks, avgCharsPerChunk) {
  const ids = [];
  const texts = [];
  for (let i = 0; i < numChunks; i++) {
    ids.push(i + 1);
    texts.push(genRealisticChunk(avgCharsPerChunk));
  }
  const totalBytes = texts.reduce((s, t) => s + t.length, 0);
  return { ids, texts, totalMB: (totalBytes / 1024 / 1024).toFixed(1) };
}

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  🔬 Arachne Scale Benchmark — TS vs Rust BM25 Crossover       ║');
  console.log('║  Finding where Rust FFI overhead < Rust compute advantage      ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`  CPU: ${os.cpus()[0].model.trim()} | Node: ${process.version} | Rust: ${native ? '✅' : '❌'}`);
  console.log('');

  const scenarios = [
    { chunks: 1000,  avgChars: 100,   label: 'S: 1K × 100B' },
    { chunks: 5000,  avgChars: 200,   label: 'M: 5K × 200B' },
    { chunks: 10000, avgChars: 500,   label: 'L: 10K × 500B' },
    { chunks: 10000, avgChars: 1000,  label: 'XL: 10K × 1KB' },
    { chunks: 20000, avgChars: 500,   label: 'XXL: 20K × 500B' },
    { chunks: 10000, avgChars: 2000,  label: 'HUGE: 10K × 2KB' },
    { chunks: 50000, avgChars: 200,   label: 'MASS: 50K × 200B' },
  ];

  const queries = ['timeout error handling', 'async database query', 'authentication middleware config'];
  const ITERS = 20;

  console.log(`  Running ${scenarios.length} scale scenarios × ${ITERS} iterations each...`);
  console.log('');
  console.log('╔══════════════════╦════════════╦═══════════════╦═══════════════╦═══════════════╗');
  console.log('║ Scale            ║ Data Size  ║ TS BM25 (avg) ║ Rust BM25     ║ Winner        ║');
  console.log('╠══════════════════╬════════════╬═══════════════╬═══════════════╬═══════════════╣');

  for (const sc of scenarios) {
    const corpus = genCorpus(sc.chunks, sc.avgChars);

    const tsStats = bench(() => {
      tsBm25(queries[Math.floor(Math.random() * queries.length)], corpus.ids, corpus.texts, 10, 1.2, 0.75);
    }, ITERS);

    let rustStats = null;
    if (native) {
      rustStats = bench(() => {
        native.bm25Search(queries[Math.floor(Math.random() * queries.length)], corpus.ids, corpus.texts, 10, 1.2, 0.75);
      }, ITERS);
    }

    const label = sc.label.padEnd(16);
    const size = `${corpus.totalMB} MB`.padEnd(10);
    const tsAvg = fmtMs(tsStats.avg).padEnd(13);
    const rustAvg = rustStats ? fmtMs(rustStats.avg).padEnd(13) : '—'.padEnd(13);

    let winner = 'TS';
    let winStr = '';
    if (rustStats) {
      const ratio = tsStats.avg / rustStats.avg;
      if (ratio > 1.05) {
        winner = 'Rust';
        winStr = `🦀 Rust ${ratio.toFixed(1)}x`;
      } else if (ratio < 0.95) {
        winStr = `🟦 TS ${(1/ratio).toFixed(1)}x`;
      } else {
        winStr = '🟰 Tie';
      }
    }
    console.log(`║ ${label} ║ ${size} ║ ${tsAvg} ║ ${rustAvg} ║ ${winStr.padEnd(13)} ║`);
  }

  console.log('╚══════════════════╩════════════╩═══════════════╩═══════════════╩═══════════════╝');
  console.log('');
  console.log('💡 Analysis: Watch for the crossover point where Rust starts winning.');
  console.log('   FFI overhead is ~0.5ms fixed. When compute time >> 0.5ms, Rust wins.');
}

main().catch(console.error);
