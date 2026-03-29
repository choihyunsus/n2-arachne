// Benchmark test: Rust native vs TypeScript fallback performance comparison
// Usage: node test/test-benchmark.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Load modules from dist
const { isNativeAvailable, getNative } = require('../dist/lib/native-bridge');
const { estimateTokens } = require('../dist/lib/chunker');

// Wrap native functions via bridge (same path as production code)
const native = getNative();
function nativeCosineSimilarity(a, b) {
  if (!native) return 0;
  return native.cosineSimilarity(a, b);
}
function nativeBatchCosineSimilarity(query, candidates, topK) {
  if (!native) return [];
  return native.batchCosineSimilarity(query, candidates, topK);
}

/**
 * Run a function N times and return elapsed milliseconds
 */
function benchmark(fn, iterations) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
        fn();
    }
    return performance.now() - start;
}

test('Benchmark: Native module availability', () => {
    const available = isNativeAvailable();
    console.log(`\n  🦀 Rust native module: ${available ? 'LOADED ✅' : 'UNAVAILABLE (TS fallback) ⚠️'}`);
});

test('Benchmark: estimateTokens — 10K iterations', () => {
    const sampleText = 'function hello() {\n  console.log("world");\n}\n'.repeat(100);
    const iterations = 10000;

    const elapsed = benchmark(() => estimateTokens(sampleText), iterations);
    const opsPerSec = Math.round(iterations / (elapsed / 1000));

    console.log(`\n  estimateTokens (${sampleText.length} chars × ${iterations})`);
    console.log(`  ⏱  ${elapsed.toFixed(2)}ms | ${opsPerSec.toLocaleString()} ops/sec`);

    // Correctness check
    const result = estimateTokens(sampleText);
    assert.ok(result > 0, 'Token count should be positive');
    assert.ok(typeof result === 'number', 'Token count should be a number');
});

test('Benchmark: cosineSimilarity — 768D vectors × 10K iterations', () => {
    const dims = 768;
    const a = new Float64Array(dims);
    const b = new Float64Array(dims);
    for (let i = 0; i < dims; i++) {
        a[i] = Math.random();
        b[i] = Math.random();
    }
    const iterations = 10000;

    const elapsed = benchmark(() => nativeCosineSimilarity(a, b), iterations);
    const opsPerSec = Math.round(iterations / (elapsed / 1000));

    console.log(`\n  cosineSimilarity (${dims}D × ${iterations})`);
    console.log(`  ⏱  ${elapsed.toFixed(2)}ms | ${opsPerSec.toLocaleString()} ops/sec`);

    // Correctness check
    const result = nativeCosineSimilarity(a, b);
    assert.ok(result >= -1 && result <= 1, `Similarity should be in [-1,1], got ${result}`);

    // Self-similarity should be ~1.0
    const self = nativeCosineSimilarity(a, a);
    assert.ok(Math.abs(self - 1.0) < 0.001, `Self-similarity should be ~1.0, got ${self}`);
});

test('Benchmark: batchCosineSimilarity — 100 candidates × 768D × 1K iterations', () => {
    const dims = 768;
    const numCandidates = 100;
    const query = new Float64Array(dims);
    for (let i = 0; i < dims; i++) query[i] = Math.random();

    const candidates = [];
    for (let c = 0; c < numCandidates; c++) {
        const vec = new Float64Array(dims);
        for (let i = 0; i < dims; i++) vec[i] = Math.random();
        candidates.push(vec);
    }
    const iterations = 1000;

    const elapsed = benchmark(() => nativeBatchCosineSimilarity(query, candidates, 10), iterations);
    const opsPerSec = Math.round(iterations / (elapsed / 1000));

    console.log(`\n  batchCosineSimilarity (${numCandidates} × ${dims}D, top10 × ${iterations})`);
    console.log(`  ⏱  ${elapsed.toFixed(2)}ms | ${opsPerSec.toLocaleString()} ops/sec`);

    // Correctness check
    const result = nativeBatchCosineSimilarity(query, candidates, 10);
    assert.ok(Array.isArray(result), 'Result should be an array');
    assert.ok(result.length <= 10, `Top-K should be <= 10, got ${result.length}`);
    if (result.length > 1) {
        assert.ok(result[0].similarity >= result[1].similarity, 'Results should be sorted descending');
    }
});

test('Benchmark: edge cases', () => {
    // Empty vector
    const empty = new Float64Array(0);
    assert.strictEqual(nativeCosineSimilarity(empty, empty), 0, 'Empty vectors → 0');

    // Zero vector
    const zero = new Float64Array(10);
    const nonZero = new Float64Array(10);
    for (let i = 0; i < 10; i++) nonZero[i] = 1;
    assert.strictEqual(nativeCosineSimilarity(zero, nonZero), 0, 'Zero vector → 0');

    // Empty text tokens
    assert.strictEqual(estimateTokens(''), 0, 'Empty text → 0 tokens');

    // Batch with empty candidates
    const result = nativeBatchCosineSimilarity(nonZero, [], 5);
    assert.strictEqual(result.length, 0, 'Empty candidates → empty result');

    console.log('\n  Edge cases: ALL PASSED ✅');
});
