// context-tools.js — MCP 도구 등록 (n2_context 통합 도구)
// QLN의 n2_qln_call과 동일한 패턴: 1 도구, 여러 액션

/**
 * MCP 도구 등록
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {typeof import('zod')} z
 * @param {import('../lib/search').BM25Search} search
 * @param {import('../lib/indexer').Indexer} indexer
 * @param {import('../lib/backup').Backup} backup
 * @param {object} config
 */
function registerContextTools(server, z, search, indexer, backup, assembler, config, vectorStore) {
    server.tool(
        'n2_arachne',
        'Arachne — 거미줄처럼 코드를 엮어 AI에게 최적의 컨텍스트를 제공하는 도구. 검색/인덱싱/백업 지원.',
        {
            action: z.enum(['assemble', 'search', 'index', 'status', 'files', 'backup', 'restore', 'gc'])
                .describe('실행할 액션 (assemble: AI 컨텍스트 자동 조립 ★핵심)'),
            // search 파라미터
            query: z.string().optional()
                .describe('검색 쿼리 (search 액션 시 필수)'),
            topK: z.number().optional()
                .describe('검색 결과 수 (기본: 10)'),
            language: z.string().optional()
                .describe('언어 필터 (js, ts, py, rs, ...)'),
            // index 파라미터
            path: z.string().optional()
                .describe('인덱싱 대상 경로 (기본: 프로젝트 루트)'),
            force: z.boolean().optional()
                .describe('true면 전체 재인덱싱'),
            // backup 파라미터
            label: z.string().optional()
                .describe('백업 라벨 (사람이 읽을 수 있는 이름)'),
            // restore/searchBackup 파라미터
            backupId: z.string().optional()
                .describe('백업 ID (없으면 최신)'),
            searchBackups: z.boolean().optional()
                .describe('true면 백업 DB도 검색'),
            // gc 파라미터
            maxAge: z.number().optional()
                .describe('N일 이상 된 백업 삭제'),
            maxCount: z.number().optional()
                .describe('최대 백업 수'),
            // files 파라미터
            pattern: z.string().optional()
                .describe('파일 필터 glob 패턴'),
            // assemble 파라미터
            activeFile: z.string().optional()
                .describe('현재 작업 중인 파일 경로 (assemble 시 사용)'),
            budget: z.number().optional()
                .describe('토큰 예산 (기본: 40000)'),
            layers: z.array(z.string()).optional()
                .describe('사용할 레이어 ["fixed", "shortTerm", "associative", "spare"]'),
        },
        async ({ action, query, topK, language, path: subPath, force,
                 label, backupId, searchBackups, maxAge, maxCount, pattern,
                 activeFile, budget, layers }) => {

            try {
                switch (action) {
                    case 'assemble':
                        return await handleAssemble(assembler, { query, activeFile, budget, layers }, config);
                    case 'search':
                        return handleSearch(search, backup, { query, topK, language, searchBackups, backupId });
                    case 'index':
                        return await handleIndex(indexer, backup, config, { subPath, force });
                    case 'status':
                        return handleStatus(indexer, backup, vectorStore);
                    case 'files':
                        return handleFiles(indexer, { language, pattern });
                    case 'backup':
                        return await handleBackup(backup, { label });
                    case 'restore':
                        return await handleRestore(backup, { backupId });
                    case 'gc':
                        return await handleGC(backup, { maxAge, maxCount });
                    default:
                        return { content: [{ type: 'text', text: `Unknown action: ${action}` }], isError: true };
                }
            } catch (err) {
                return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
            }
        }
    );
}

// ── 액션 핸들러 ──

function handleSearch(search, backup, { query, topK, language, searchBackups, backupId }) {
    if (!query) {
        return { content: [{ type: 'text', text: 'Error: query is required for search action' }], isError: true };
    }

    const results = search.search(query, { topK, language });

    let backupResults = [];
    if (searchBackups && backup) {
        try {
            const bkId = backupId || 'latest';
            const backups = backup.list();
            const targetId = bkId === 'latest' && backups.length > 0 ? backups[backups.length - 1].id : bkId;
            if (targetId && targetId !== 'latest') {
                backupResults = backup.searchBackup(targetId, query, topK || 10);
            }
        } catch { /* backup search failure is non-fatal */ }
    }

    const formatted = results.map(r => {
        const c = r.chunk;
        return `📄 ${c.file_path}:${c.start_line}-${c.end_line} [${c.chunk_type}${c.name ? ': ' + c.name : ''}] (score: ${r.score.toFixed(2)}, ${c.token_count} tokens)\n\`\`\`${c.language || ''}\n${c.content}\n\`\`\``;
    });

    if (backupResults.length > 0) {
        formatted.push('\n--- Backup Results ---');
        for (const r of backupResults) {
            formatted.push(`🗃️ [backup:${r.backup_id}] :${r.start_line}-${r.end_line} [${r.chunk_type}${r.name ? ': ' + r.name : ''}]\n\`\`\`\n${r.content}\n\`\`\``);
        }
    }

    const text = results.length > 0
        ? `Found ${results.length} results${backupResults.length > 0 ? ` (+${backupResults.length} from backup)` : ''}:\n\n${formatted.join('\n\n')}`
        : 'No results found.';

    return { content: [{ type: 'text', text }] };
}

async function handleIndex(indexer, backup, config, { subPath, force }) {
    const projectDir = config.projectDir || process.cwd();

    // 전체 재인덱싱 전 자동 백업
    if (force && config.backup?.autoBackupOnReindex && backup) {
        try {
            await backup.create('pre-reindex', 'pre-reindex');
        } catch { /* backup failure is non-fatal */ }
    }

    const result = await indexer.index(projectDir, { force, subPath });
    const text = `Indexing complete:\n- Indexed: ${result.indexed} files\n- Skipped: ${result.skipped} (unchanged)\n- Removed: ${result.removed} (stale)\n- Total: ${result.total} files\n- Elapsed: ${result.elapsed}ms`;
    return { content: [{ type: 'text', text }] };
}

function handleStatus(indexer, backup, vectorStore) {
    const stats = indexer.getStats();
    const backups = backup ? backup.list() : [];

    const lines = [
        `📊 Arachne Status`,
        `- Files: ${stats.fileCount}`,
        `- Chunks: ${stats.chunkCount}`,
        `- Total tokens: ${stats.totalTokens.toLocaleString()}`,
        `- DB size: ${stats.dbSizeMB} MB`,
        `- Last indexed: ${stats.lastIndexed || 'never'}`,
        `- Schema version: ${stats.schemaVersion}`,
        `\n📋 Languages:`,
        ...stats.languages.map(l => `  ${l.language || 'unknown'}: ${l.cnt} files`),
    ];

    // Phase 3: 임베딩 통계
    if (vectorStore) {
        const embeddedCount = vectorStore.getEmbeddedCount();
        lines.push(`\n🧠 Semantic Search:`);
        lines.push(`  Status: ${vectorStore.isReady ? '✅ Active' : '❌ Inactive'}`);
        lines.push(`  Embedded chunks: ${embeddedCount} / ${stats.chunkCount}`);
    }

    if (backups.length > 0) {
        lines.push(`\n🗃️ Backups: ${backups.length}`);
        for (const b of backups.slice(-3)) {
            lines.push(`  ${b.id}${b.label ? ' (' + b.label + ')' : ''} — ${b.files} files, ${b.sizeMB} MB`);
        }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function handleFiles(indexer, { language, pattern }) {
    let files = indexer.getFiles({ language });

    // glob 패턴 필터 (간단 구현)
    if (pattern) {
        const regex = new RegExp(pattern.replace(/\*/g, '.*').replace(/\?/g, '.'), 'i');
        files = files.filter(f => regex.test(f.path));
    }

    const text = files.length > 0
        ? `📁 ${files.length} files:\n${files.map(f => `  ${f.path} (${f.language}, ${f.chunk_count} chunks)`).join('\n')}`
        : 'No files found.';

    return { content: [{ type: 'text', text }] };
}

async function handleBackup(backup, { label }) {
    const result = await backup.create(label);
    return { content: [{ type: 'text', text: `✅ Backup created: ${result.id}\n- Files: ${result.files}\n- Chunks: ${result.chunks}\n- Size: ${(result.size / 1024 / 1024).toFixed(2)} MB` }] };
}

async function handleRestore(backup, { backupId }) {
    const result = await backup.restore(backupId);
    return { content: [{ type: 'text', text: `✅ Restored from backup: ${result.restored}\n- Files: ${result.files}${result.label ? '\n- Label: ' + result.label : ''}\n⚠️ Store needs re-initialization. Restart the MCP server.` }] };
}

async function handleGC(backup, { maxAge, maxCount }) {
    const removed = await backup.gc(maxAge, maxCount);
    return { content: [{ type: 'text', text: `🧹 GC complete: ${removed} backup(s) removed.` }] };
}

function handleAssemble(assembler, { query, activeFile, budget, layers }, config) {
    if (!query) {
        return { content: [{ type: 'text', text: 'Error: query is required for assemble action' }], isError: true };
    }

    const projectDir = config.projectDir || process.cwd();
    // assemble is now async
    return assembler.assemble(query, {
        activeFile,
        budget,
        layers,
        projectDir,
    }).then(result => {

    const meta = result.metadata;
    const header = [
        `🕷️ Arachne Context Assembled`,
        `- Query: "${meta.query}"`,
        `- Tokens: ${meta.tokensUsed.toLocaleString()} / ${meta.budget.toLocaleString()} (${Math.round(meta.tokensUsed / meta.budget * 100)}% used)`,
        `- Layers:`,
        ...Object.entries(meta.layers).map(([k, v]) => `  ${k}: ${v.tokens.toLocaleString()} tokens, ${v.itemCount} items`),
    ];

        const text = `${header.join('\n')}\n\n---\n\n${result.context}`;
        return { content: [{ type: 'text', text }] };
    });
}

module.exports = { registerContextTools };
