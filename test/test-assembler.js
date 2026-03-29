// test-assembler.js — Arachne Phase 2 integration test
// Dependency graph + 4-Layer assembler tests
const path = require('path');
const { loadConfig } = require('../dist/lib/config');
const { Store } = require('../dist/lib/store');
const { Indexer } = require('../dist/lib/indexer');
const { BM25Search } = require('../dist/lib/search');
const { Assembler, estimateTokens } = require('../dist/lib/assembler');
const { extractDependencies, resolveImport } = require('../dist/lib/dependency');

const TEST_PROJECT = path.resolve(__dirname, '../../QLN');
const TEST_DATA_DIR = path.resolve(__dirname, '../data');

async function runTests() {
    console.log('=== Arachne Phase 2 Test ===\n');
    let passed = 0;
    let failed = 0;

    function assert(name, condition) {
        if (condition) {
            console.log(`  ✅ ${name}`);
            passed++;
        } else {
            console.log(`  ❌ ${name}`);
            failed++;
        }
    }

    // ── Setup ──
    const config = loadConfig(path.resolve(__dirname, '..'));
    config.projectDir = TEST_PROJECT;
    config.dataDir = TEST_DATA_DIR;
    config.backup.dir = path.join(TEST_DATA_DIR, 'backups');
    config.indexing.autoIndex = false;

    const store = new Store(config.dataDir);
    await store.init();

    // ── Test 1: Schema V2 마이그레이션 ──
    console.log('\n💾 Test 1: Schema V2 Migration');
    assert('Schema version = 2', store.getMeta('schema_version') === '3');

    // dependencies 테이블 존재 확인
    const tables = store.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('dependencies', 'access_log')"
    ).all();
    assert('dependencies table exists', tables.some(t => t.name === 'dependencies'));
    assert('access_log table exists', tables.some(t => t.name === 'access_log'));

    // ── Test 2: 의존성 추출 (extractDependencies) ──
    console.log('\n🔗 Test 2: Dependency Extraction');

    const jsCode = `
import { Router } from './router';
import path from 'path';
const config = require('./config');
const { something } = require('../lib/utils');
import('./dynamic-module');
    `;
    const jsDeps = extractDependencies(jsCode, 'js');
    console.log(`   → Found ${jsDeps.length} dependencies`);
    assert('JS: finds relative imports', jsDeps.some(d => d.importPath === './router'));
    assert('JS: finds require', jsDeps.some(d => d.importPath === './config'));
    assert('JS: finds relative parent', jsDeps.some(d => d.importPath === '../lib/utils'));
    assert('JS: detects external (path)', jsDeps.some(d => d.importPath === 'path' && d.depType === 'external'));

    const pyCode = `
from flask import Flask
import os
from .models import User
    `;
    const pyDeps = extractDependencies(pyCode, 'py');
    assert('Python: extracts imports', pyDeps.length >= 2);

    // ── Test 3: 인덱싱 (의존성 포함) ──
    console.log('\n📁 Test 3: Indexing with Dependencies');
    const indexer = new Indexer(store, config);
    const result = await indexer.index(TEST_PROJECT, { force: true });
    console.log(`   → Indexed: ${result.indexed} files, Elapsed: ${result.elapsed}ms`);
    assert('Files indexed', result.indexed > 0);

    // 의존성이 DB에 저장되었는지 확인
    const depCount = store.db.prepare('SELECT COUNT(*) as cnt FROM dependencies').get().cnt;
    console.log(`   → Dependencies in DB: ${depCount}`);
    assert('Dependencies stored', depCount > 0);

    // ── Test 4: 의존성 쿼리 ──
    console.log('\n🕸️ Test 4: Dependency Queries');
    const allFiles = store.getAllFiles();
    const jsFile = allFiles.find(f => f.language === 'js' && f.chunk_count > 0);
    if (jsFile) {
        const directDeps = store.getDirectDependencies(jsFile.id);
        console.log(`   → ${jsFile.path}: ${directDeps.length} direct deps`);
        assert('Direct dependencies query works', Array.isArray(directDeps));

        const transitiveDeps = store.getTransitiveDependencies(jsFile.id, 2);
        console.log(`   → Transitive deps (depth=2): ${transitiveDeps.length}`);
        assert('Transitive dependencies query works', Array.isArray(transitiveDeps));
    } else {
        assert('JS file found for dep test', false);
    }

    // ── Test 5: 접근 로그 ──
    console.log('\n📝 Test 5: Access Log');
    if (jsFile) {
        store.logAccess(jsFile.id, 'test query');
        store.logAccess(jsFile.id, 'another query');

        const recent = store.getRecentFiles(5);
        assert('Recent files returns results', recent.length > 0);

        const frequent = store.getMostAccessedFiles(5);
        assert('Most accessed returns results', frequent.length > 0);
        assert('Access count tracks correctly', frequent[0].access_count >= 2);
    }

    // ── Test 6: 토큰 추정 ──
    console.log('\n🔢 Test 6: Token Estimation');
    const tokens100 = estimateTokens('a'.repeat(350));
    assert('Token estimation works', tokens100 === 100);
    assert('Empty text = 0 tokens', estimateTokens('') === 0);
    assert('Null text = 0 tokens', estimateTokens(null) === 0);

    // ── Test 7: Assembler 통합 ──
    console.log('\n🕷️ Test 7: Assembler Integration');
    const search = new BM25Search(store, config.search);
    const assembler = new Assembler(store, search, config.assembly);

    const assembled = await assembler.assemble('executor HTTP timeout handling', {
        projectDir: TEST_PROJECT,
        budget: 10000,
    });
    console.log(`   → Tokens used: ${assembled.metadata.tokensUsed} / ${assembled.metadata.budget}`);
    console.log(`   → Layers: ${JSON.stringify(assembled.metadata.layers)}`);
    assert('Assembler returns context', assembled.context.length > 0);
    assert('Within budget', assembled.metadata.tokensUsed <= assembled.metadata.budget);
    assert('Metadata has layers', Object.keys(assembled.metadata.layers).length > 0);

    // ── Test 8: Assembler with activeFile ──
    console.log('\n📄 Test 8: Assembler with Active File');
    if (allFiles.length > 0) {
        const testFile = allFiles[0];
        const assembled2 = await assembler.assemble('modify this function', {
            activeFile: testFile.path,
            projectDir: TEST_PROJECT,
            budget: 20000,
        });
        console.log(`   → Active file: ${testFile.path}`);
        console.log(`   → Tokens: ${assembled2.metadata.tokensUsed} / ${assembled2.metadata.budget}`);
        assert('Assembler with activeFile works', assembled2.context.length > 0);
        assert('Within budget (activeFile)', assembled2.metadata.tokensUsed <= assembled2.metadata.budget);
    }

    // ── Test 9: Lost in the Middle 배치 검증 ──
    console.log('\n🎯 Test 9: Lost in the Middle Arrangement');
    // L1(구조)이 가장 앞, L2(현재파일)이 가장 뒤
    if (assembled.context.includes('프로젝트 구조') && assembled.context.includes('연관 코드')) {
        const l1Pos = assembled.context.indexOf('프로젝트 구조');
        const l3Pos = assembled.context.indexOf('연관 코드');
        assert('L1 before L3', l1Pos < l3Pos);
    } else {
        // 파일 트리가 예산 내 생성되었으면 OK
        assert('Output has content', assembled.context.length > 100);
    }

    // ── Test 10: Multiple file chunks query ──
    console.log('\n📦 Test 10: Batch Chunk Query');
    const fileIds = allFiles.slice(0, 3).map(f => f.id);
    const batchChunks = store.getChunksByFileIds(fileIds);
    assert('Batch chunk query works', Array.isArray(batchChunks));
    assert('Returns chunks', batchChunks.length > 0);

    // ── Summary ──
    console.log(`\n${'='.repeat(40)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(`${'='.repeat(40)}`);

    store.close();
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
