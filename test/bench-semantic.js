// Real-world semantic benchmark: Rust vs TS with actual Ollama embeddings
'use strict';
const path = require('path');
const { getNative } = require('../dist/lib/native-bridge');
const native = getNative();

if (!native) { console.log('Native not available'); process.exit(1); }

async function main() {
    console.log('\n=== Real-World Semantic Benchmark (Ollama Embeddings) ===\n');

    // Generate real 768D embeddings via Ollama
    const http = require('http');
    async function embed(text) {
        return new Promise((resolve, reject) => {
            const data = JSON.stringify({ model: 'nomic-embed-text', prompt: text });
            const req = http.request({
                hostname: '127.0.0.1', port: 11434, path: '/api/embeddings', method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            }, (res) => {
                let body = '';
                res.on('data', d => body += d);
                res.on('end', () => { try { resolve(JSON.parse(body).embedding); } catch (e) { reject(e); } });
            });
            req.on('error', reject);
            req.write(data);
            req.end();
        });
    }

    // Generate query + candidate embeddings
    console.log('Generating embeddings via Ollama nomic-embed-text...');
    const queryVec = await embed('HTTP request timeout error handling in login module');
    console.log(`  Query vector: ${queryVec.length}D`);

    const codeSnippets = [
        'function handleTimeout() { return retry(3); }',
        'class UserService { async login(user, pass) {} }',
        'const DEFAULT_TIMEOUT = 30000;',
        'import express from "express";',
        'async function fetchData(url) { const res = await fetch(url); }',
        'function calculateSum(a, b) { return a + b; }',
        'class DatabaseConnection { constructor(host, port) {} }',
        'const router = express.Router();',
        'function validateEmail(email) { return /^[^@]+@[^@]+$/.test(email); }',
        'async function retryWithBackoff(fn, maxRetries) {}',
        'class AuthMiddleware { verify(token) {} }',
        'function parseJSON(str) { try { return JSON.parse(str); } catch {} }',
        'const API_ENDPOINT = process.env.API_URL;',
        'async function sendRequest(method, url, body) {}',
        'class ErrorHandler { static handle(err) {} }',
        'function debounce(fn, ms) { let timer; return (...args) => {} }',
        'class SessionStore { get(key) {} set(key, val) {} }',
        'function hashPassword(password) { return bcrypt.hash(password, 10); }',
        'const logger = winston.createLogger({ level: "info" });',
        'async function healthCheck() { return { status: "ok" }; }',
    ];

    console.log(`  Embedding ${codeSnippets.length} code snippets...`);
    const candidateVecs = [];
    for (const snippet of codeSnippets) {
        const vec = await embed(snippet);
        candidateVecs.push(new Float64Array(vec));
    }
    console.log(`  Done: ${candidateVecs.length} × ${candidateVecs[0].length}D\n`);

    const queryF64 = new Float64Array(queryVec);

    // Scale test: duplicate candidates to simulate larger datasets
    const scales = [20, 100, 500, 1000];

    for (const scale of scales) {
        const bigCandidates = [];
        for (let i = 0; i < scale; i++) {
            bigCandidates.push(candidateVecs[i % candidateVecs.length]);
        }

        const iterations = Math.max(10, Math.floor(5000 / scale));

        // TS benchmark
        const tsStart = performance.now();
        for (let iter = 0; iter < iterations; iter++) {
            const hits = bigCandidates.map((c, idx) => {
                let dot = 0, nA = 0, nB = 0;
                for (let i = 0; i < 768; i++) { dot += queryF64[i] * c[i]; nA += queryF64[i] * queryF64[i]; nB += c[i] * c[i]; }
                return { index: idx, sim: dot / (Math.sqrt(nA) * Math.sqrt(nB)) };
            });
            hits.sort((a, b) => b.sim - a.sim);
            hits.slice(0, 10);
        }
        const tsElapsed = performance.now() - tsStart;

        // Rust benchmark
        const rsStart = performance.now();
        for (let iter = 0; iter < iterations; iter++) {
            native.batchCosineSimilarity(queryF64, bigCandidates, 10);
        }
        const rsElapsed = performance.now() - rsStart;

        const speedup = (tsElapsed / rsElapsed).toFixed(1);
        console.log(`batchCosine ${scale} candidates × ${iterations} iters:`);
        console.log(`  TS: ${tsElapsed.toFixed(1)}ms | Rust: ${rsElapsed.toFixed(1)}ms | Speedup: ${speedup}x`);
    }

    console.log('\n=== Benchmark Complete ===\n');
}

main().catch(console.error);
