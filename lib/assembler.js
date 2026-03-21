// assembler.js — 4-Layer 페이징 알고리즘으로 AI 컨텍스트 자동 조립
// Arachne의 핵심 가치: "AI에게 지금 필요한 코드를 자동으로 골라준다"
const path = require('path');
const fs = require('fs');

class Assembler {
    /**
     * @param {import('./store').Store} store
     * @param {import('./search').BM25Search} search
     * @param {object} assemblyConfig - config.assembly 객체
     */
    constructor(store, search, assemblyConfig) {
        this._store = store;
        this._search = search;
        this._config = assemblyConfig || {};
        this._defaultBudget = this._config.defaultBudget || 40000;
        this._layers = this._config.layers || {
            fixed: 0.10,
            shortTerm: 0.30,
            associative: 0.40,
            spare: 0.20,
        };
        this._depthLimit = this._config.dependencyDepth || 2;
        this._vectorStore = null;
    }

    /**
     * VectorStore 연결 (Phase 3 시맨틱 검색)
     * @param {import('./vector-store').VectorStore} vectorStore
     */
    setVectorStore(vectorStore) {
        this._vectorStore = vectorStore;
    }

    /**
     * 메인 컨텍스트 조립 함수
     * @param {string} query - 사용자 쿼리 (자연어)
     * @param {object} [options]
     * @param {string} [options.activeFile] - 현재 작업 파일 (상대 경로)
     * @param {number} [options.budget] - 토큰 예산
     * @param {string[]} [options.layers] - 사용할 레이어 (기본: 전부)
     * @param {string} [options.projectDir] - 프로젝트 디렉토리
     * @returns {{context: string, metadata: object}}
     */
    async assemble(query, options = {}) {
        const safeQuery = (query && typeof query === 'string') ? query : '';
        const budget = options.budget || this._defaultBudget;
        const enabledLayers = options.layers || ['fixed', 'shortTerm', 'associative', 'spare'];
        const projectDir = options.projectDir || this._store.getMeta('project_dir') || process.cwd();

        const layerResults = {};
        let totalUsed = 0;

        // ── Layer 1: Fixed (파일 트리) ──
        if (enabledLayers.includes('fixed')) {
            const l1Budget = Math.floor(budget * this._layers.fixed);
            const l1 = this._buildLayer1(projectDir, l1Budget);
            layerResults.fixed = l1;
            totalUsed += l1.tokens;
        }

        // ── Layer 2: Short-term (현재 파일 + 최근 접근) ──
        if (enabledLayers.includes('shortTerm')) {
            const l2Budget = Math.floor(budget * this._layers.shortTerm);
            const l2 = this._buildLayer2(options.activeFile, l2Budget, projectDir);
            layerResults.shortTerm = l2;
            totalUsed += l2.tokens;
        }

        // ── Layer 3: Associative (검색 + 의존성) ── ★핵심
        if (enabledLayers.includes('associative')) {
            const l3Budget = Math.floor(budget * this._layers.associative);
            const l3 = await this._buildLayer3(safeQuery, options.activeFile, l3Budget);
            layerResults.associative = l3;
            totalUsed += l3.tokens;
        }

        // ── Layer 4: Spare (자주 접근한 파일) ──
        if (enabledLayers.includes('spare')) {
            const l4Budget = Math.min(
                Math.floor(budget * this._layers.spare),
                budget - totalUsed // 남은 예산만큼만
            );
            if (l4Budget > 500) { // 최소 500토큰 이상일 때만
                const l4 = this._buildLayer4(l4Budget);
                layerResults.spare = l4;
                totalUsed += l4.tokens;
            }
        }

        // ── 접근 로그 기록 ──
        this._logAccess(safeQuery, options.activeFile, layerResults);

        // ── Lost in the Middle 방지 배치: L1 → L3 → L4 → L2 ──
        const context = this._arrangeOutput(layerResults);

        return {
            context,
            metadata: {
                query: safeQuery,
                budget,
                tokensUsed: totalUsed,
                tokensRemaining: budget - totalUsed,
                layers: Object.fromEntries(
                    Object.entries(layerResults).map(([k, v]) => [k, {
                        tokens: v.tokens,
                        itemCount: v.items?.length || 0,
                    }])
                ),
            },
        };
    }

    // ── Layer Builders ──

    /**
     * Layer 1: 프로젝트 파일 트리 (구조 파악용)
     */
    _buildLayer1(projectDir, budget) {
        const tree = this._generateFileTree(projectDir, 3);
        const tokens = estimateTokens(tree);

        // 예산 초과 시 depth 줄이기
        if (tokens > budget) {
            const shortTree = this._generateFileTree(projectDir, 2);
            const shortTokens = estimateTokens(shortTree);
            if (shortTokens <= budget) {
                return { text: shortTree, tokens: shortTokens, items: [] };
            }
            // 그래도 초과면 truncate
            const truncated = shortTree.slice(0, Math.floor(budget * 3.5));
            return { text: truncated, tokens: estimateTokens(truncated), items: [] };
        }

        return { text: tree, tokens, items: [] };
    }

    /**
     * Layer 2: 현재 작업 파일 + 최근 접근 파일 청크
     */
    _buildLayer2(activeFile, budget, projectDir) {
        let text = '';
        let tokens = 0;
        const items = [];

        // 2-1. 현재 작업 파일 전체 내용
        if (activeFile) {
            const fileRecord = this._store.getFileByPath(activeFile);
            if (fileRecord) {
                const fullPath = path.join(projectDir, activeFile);
                try {
                    const content = fs.readFileSync(fullPath, 'utf-8');
                    const fileTokens = estimateTokens(content);

                    if (fileTokens <= budget * 0.7) { // 예산의 70%까지만 사용
                        text += `\n## 현재 파일: ${activeFile}\n\`\`\`${fileRecord.language || ''}\n${content}\n\`\`\`\n`;
                        tokens += fileTokens;
                        items.push({ type: 'activeFile', path: activeFile, tokens: fileTokens });
                    } else {
                        // 파일이 너무 크면 청크만 포함
                        const chunks = this._store.getChunksByFileId(fileRecord.id);
                        let chunkText = '';
                        let chunkTokens = 0;
                        for (const chunk of chunks) {
                            if (chunkTokens + chunk.token_count > budget * 0.7) break;
                            chunkText += `// ${chunk.name || chunk.chunk_type} (L${chunk.start_line}-${chunk.end_line})\n${chunk.content}\n\n`;
                            chunkTokens += chunk.token_count;
                        }
                        text += `\n## 현재 파일: ${activeFile} (핵심 청크)\n\`\`\`${fileRecord.language || ''}\n${chunkText}\`\`\`\n`;
                        tokens += chunkTokens;
                        items.push({ type: 'activeFileChunks', path: activeFile, tokens: chunkTokens });
                    }
                } catch {
                    // 파일 읽기 실패 무시
                }
            }
        }

        // 2-2. 최근 접근 파일 청크
        const remaining = budget - tokens;
        if (remaining > 500) {
            const recentFiles = this._store.getRecentFiles(5);
            for (const rf of recentFiles) {
                if (rf.path === activeFile) continue; // 이미 포함
                const chunks = this._store.getChunksByFileId(rf.file_id);
                if (chunks.length === 0) continue;

                // 최상위 청크만 추가
                const topChunk = chunks[0];
                const chunkTokens = topChunk.token_count;
                if (tokens + chunkTokens > budget) break;

                text += `\n## 최근 파일: ${rf.path}\n\`\`\`${topChunk.language || ''}\n${topChunk.content}\n\`\`\`\n`;
                tokens += chunkTokens;
                items.push({ type: 'recentFile', path: rf.path, tokens: chunkTokens });
            }
        }

        return { text, tokens, items };
    }

    /**
     * Layer 3: BM25 검색 + 의존성 체인 통합 ★핵심
     */
    async _buildLayer3(query, activeFile, budget) {
        let text = '';
        let tokens = 0;
        const items = [];

        // 3-1. 시맨틱 enabled면 hybridSearch, 아니면 BM25-only
        let searchResults;
        if (this._vectorStore?.isReady) {
            const hybridResults = await this._search.hybridSearch(query, { topK: 20 });
            searchResults = hybridResults.map(r => ({ chunk: r.chunk, score: r.score }));
        } else {
            searchResults = this._search.search(query, { topK: 20 });
        }
        const depChunks = this._getDependencyChunks(activeFile);
        const merged = this._mergeSearchAndDeps(searchResults, depChunks);

        // 3-2. 예산 내에서 선택
        for (const item of merged) {
            const chunkTokens = item.chunk.token_count || estimateTokens(item.chunk.content);
            if (tokens + chunkTokens > budget) continue;

            const filePath = item.chunk.file_path;
            const tag = item.source === 'dependency' ? ' [dep]' : '';
            const chunkLabel = item.chunk.name
                ? `${item.chunk.chunk_type}: ${item.chunk.name}`
                : item.chunk.chunk_type;

            text += `\n## ${filePath}:${item.chunk.start_line}-${item.chunk.end_line} [${chunkLabel}]${tag}\n\`\`\`${item.chunk.language || ''}\n${item.chunk.content}\n\`\`\`\n`;
            tokens += chunkTokens;
            items.push({
                type: item.source, path: filePath, chunk: chunkLabel,
                score: item.score, tokens: chunkTokens,
            });
        }

        return { text, tokens, items };
    }

    /** activeFile의 의존성 체인에서 청크 추출 */
    _getDependencyChunks(activeFile) {
        if (!activeFile) return [];
        const fileRecord = this._store.getFileByPath(activeFile);
        if (!fileRecord) return [];

        const deps = this._store.getTransitiveDependencies(fileRecord.id, this._depthLimit);
        const depFileIds = deps.filter(d => d.target_file_id).map(d => d.target_file_id);
        return depFileIds.length > 0 ? this._store.getChunksByFileIds(depFileIds) : [];
    }

    /** 검색 결과 + 의존성 청크를 스코어순 병합 */
    _mergeSearchAndDeps(searchResults, depChunks) {
        const merged = searchResults.map(r => ({ chunk: r.chunk, score: r.score, source: 'search' }));

        const baseDepScore = searchResults.length > 0
            ? searchResults[searchResults.length - 1].score * 0.8 : 1.0;

        for (const chunk of depChunks) {
            const key = `${chunk.file_path}:${chunk.start_line}`;
            if (merged.some(m => `${m.chunk.file_path}:${m.chunk.start_line}` === key)) continue;
            merged.push({ chunk, score: baseDepScore, source: 'dependency' });
        }

        merged.sort((a, b) => b.score - a.score);
        return merged;
    }


    /**
     * Layer 4: 자주 접근하는 파일의 베스트 청크
     */
    _buildLayer4(budget) {
        let text = '';
        let tokens = 0;
        const items = [];

        const frequentFiles = this._store.getMostAccessedFiles(5);

        for (const ff of frequentFiles) {
            const chunks = this._store.getChunksByFileId(ff.file_id);
            if (chunks.length === 0) continue;

            // 가장 작은 토큰의 대표 청크
            const sortedChunks = [...chunks].sort((a, b) => a.token_count - b.token_count);
            for (const chunk of sortedChunks) {
                if (tokens + chunk.token_count > budget) break;
                text += `\n## ${ff.path}:${chunk.start_line}-${chunk.end_line} [${chunk.name || chunk.chunk_type}] (freq: ${ff.access_count})\n\`\`\`${chunk.language || ''}\n${chunk.content}\n\`\`\`\n`;
                tokens += chunk.token_count;
                items.push({
                    type: 'frequent',
                    path: ff.path,
                    chunk: chunk.name || chunk.chunk_type,
                    accessCount: ff.access_count,
                    tokens: chunk.token_count,
                });
                break; // 파일당 1개만
            }
        }

        return { text, tokens, items };
    }

    // ── Output Arrangement ──

    /**
     * Lost in the Middle 방지: 중요한 것을 앞/뒤, 덜 중요한 것을 가운데
     * 배치 순서: L1(구조) → L3(연관/검색) → L4(자주 접근) → L2(현재 파일)
     */
    _arrangeOutput(layerResults) {
        const sections = [];

        // L1: 프로젝트 구조 (앞쪽 — 전체 파악)
        if (layerResults.fixed?.text) {
            sections.push(`# 📁 프로젝트 구조\n${layerResults.fixed.text}`);
        }

        // L3: 연관 코드 (앞쪽 — 핵심 정보)
        if (layerResults.associative?.text) {
            sections.push(`# 🔗 연관 코드\n${layerResults.associative.text}`);
        }

        // L4: 자주 접근 (가운데)
        if (layerResults.spare?.text) {
            sections.push(`# 📊 자주 참조하는 코드\n${layerResults.spare.text}`);
        }

        // L2: 현재 파일 (뒤쪽 — 가장 최근 맥락)
        if (layerResults.shortTerm?.text) {
            sections.push(`# 📄 현재 작업 컨텍스트\n${layerResults.shortTerm.text}`);
        }

        return sections.join('\n---\n');
    }

    // ── Utilities ──

    /**
     * 프로젝트 파일 트리 생성 (DB 기반)
     */
    _generateFileTree(projectDir, maxDepth) {
        const files = this._store.getAllFiles();
        if (files.length === 0) return '(인덱싱된 파일 없음)';

        // 트리 구조 빌드
        const tree = {};
        for (const f of files) {
            const parts = f.path.split('/');
            if (parts.length - 1 > maxDepth) continue; // depth 제한

            let node = tree;
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                if (i === parts.length - 1) {
                    // 파일 (리프 노드)
                    node[part] = { _file: true, _lang: f.language, _chunks: f.chunk_count };
                } else {
                    // 디렉토리
                    if (!node[part]) node[part] = {};
                    node = node[part];
                }
            }
        }

        // 트리 → 텍스트
        return this._renderTree(tree, '', true);
    }

    _renderTree(node, prefix, isRoot) {
        const lines = [];
        const entries = Object.entries(node).filter(([k]) => !k.startsWith('_'));
        entries.sort((a, b) => {
            // 디렉토리 먼저
            const aIsDir = !a[1]._file;
            const bIsDir = !b[1]._file;
            if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
            return a[0].localeCompare(b[0]);
        });

        for (let i = 0; i < entries.length; i++) {
            const [name, child] = entries[i];
            const isLast = i === entries.length - 1;
            const connector = isRoot ? '' : (isLast ? '└── ' : '├── ');
            const childPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ');

            if (child._file) {
                lines.push(`${prefix}${connector}${name}`);
            } else {
                lines.push(`${prefix}${connector}${name}/`);
                lines.push(this._renderTree(child, childPrefix, false));
            }
        }

        return lines.filter(Boolean).join('\n');
    }

    /**
     * 조립 시 접근한 파일 로그 기록
     */
    _logAccess(query, activeFile, layerResults) {
        try {
            // 현재 파일 접근 기록
            if (activeFile) {
                const fileRecord = this._store.getFileByPath(activeFile);
                if (fileRecord) {
                    this._store.logAccess(fileRecord.id, query);
                }
            }

            // Layer 3에서 사용된 파일들 접근 기록
            if (layerResults.associative?.items) {
                const loggedPaths = new Set();
                for (const item of layerResults.associative.items) {
                    if (loggedPaths.has(item.path)) continue;
                    loggedPaths.add(item.path);
                    const fileRecord = this._store.getFileByPath(item.path);
                    if (fileRecord) {
                        this._store.logAccess(fileRecord.id, query);
                    }
                }
            }
        } catch {
            // 접근 로그 실패는 치명적이지 않음
        }
    }
}

/**
 * 토큰 수 추정 (정확한 토크나이저 없이)
 * 영어: ~4글자=1토큰, 한글: ~2글자=1토큰, 코드: ~3.5글자=1토큰
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 3.5);
}

module.exports = { Assembler, estimateTokens };
