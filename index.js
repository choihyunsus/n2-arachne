#!/usr/bin/env node
// Arachne — MCP server entry point
// 거미줄처럼 코드를 엮어 AI에게 최적의 컨텍스트를 제공하는 지능형 코드 어셈블러
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const { loadConfig } = require('./lib/config');
const { Store } = require('./lib/store');
const { Indexer } = require('./lib/indexer');
const { BM25Search } = require('./lib/search');
const { Backup } = require('./lib/backup');
const { Assembler } = require('./lib/assembler');
const { Embedding } = require('./lib/embedding');
const { VectorStore } = require('./lib/vector-store');
const { registerContextTools } = require('./tools/context-tools');

async function main() {
    const config = loadConfig();

    // 1. Store 초기화 (SQLite + Phase 3 마이그레이션)
    const store = new Store(config.dataDir);
    await store.init();
    console.error(`[n2-arachne] DB initialized: ${store.dbPath}`);

    // 2. 엔진 초기화
    const indexer = new Indexer(store, config);
    const search = new BM25Search(store, config.search);
    const backup = new Backup(store, config.backup);
    const assembler = new Assembler(store, search, config.assembly);

    // 3. Phase 3: 시맨틱 검색 (embedding.enabled 시에만)
    let vectorStore = null;
    if (config.embedding?.enabled) {
        const embedding = new Embedding(config.embedding);
        vectorStore = new VectorStore(store, embedding);
        const initialized = await vectorStore.init();
        if (initialized) {
            search.setVectorStore(vectorStore);
            assembler.setVectorStore(vectorStore);
            console.error(`[n2-arachne] Semantic search enabled (${embedding.model})`);
        } else {
            console.error('[n2-arachne] Semantic search unavailable, using BM25-only');
        }
    }

    // 4. 자동 인덱싱 (설정 활성화 시)
    if (config.indexing.autoIndex) {
        const projectDir = config.projectDir || process.cwd();
        console.error(`[n2-arachne] Auto-indexing: ${projectDir}`);

        try {
            const result = await indexer.index(projectDir);
            console.error(`[n2-arachne] Indexed: ${result.indexed} files (${result.skipped} unchanged, ${result.removed} stale) in ${result.elapsed}ms`);

            // 임베딩 자동 생성
            if (vectorStore?.isReady) {
                const embedResult = await vectorStore.embedNewChunks();
                console.error(`[n2-arachne] Embedded: ${embedResult.embedded} chunks (${embedResult.errors} errors)`);
            }
        } catch (err) {
            console.error(`[n2-arachne] Auto-index failed: ${err.message}`);
        }
    }

    // 5. MCP 서버 생성
    const pkg = require('./package.json');
    const server = new McpServer({
        name: 'n2-arachne',
        version: pkg.version,
    });

    // 6. MCP 도구 등록 (Phase 3: vectorStore 추가)
    registerContextTools(server, z, search, indexer, backup, assembler, config, vectorStore);

    // 7. Stdio 트랜스포트 연결
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[n2-arachne] MCP server ready (v${pkg.version})`);
}

main().catch(err => {
    console.error(`[n2-arachne] Fatal: ${err.message}`);
    process.exit(1);
});

