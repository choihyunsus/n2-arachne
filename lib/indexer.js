// indexer.js — 프로젝트 파일 스캔 + 증분 인덱싱
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { IgnoreFilter } = require('./ignore');
const { chunkCode, detectLanguage } = require('./chunker');
const { indexFileDependencies } = require('./dependency');

class Indexer {
    /**
     * @param {import('./store').Store} store
     * @param {object} config - 전체 설정 객체
     */
    constructor(store, config) {
        this._store = store;
        this._config = config;
        this._ignoreFilter = null;
    }

    /**
     * 프로젝트 인덱싱 (증분 — 변경된 파일만)
     * @param {string} projectDir - 프로젝트 루트 경로
     * @param {object} [options]
     * @param {boolean} [options.force] - true면 전체 재인덱싱
     * @param {string} [options.subPath] - 하위 경로만 인덱싱
     * @returns {Promise<{indexed:number, skipped:number, removed:number, elapsed:number}>}
     */
    async index(projectDir, options = {}) {
        const startTime = Date.now();
        const scanDir = options.subPath
            ? path.resolve(projectDir, options.subPath)
            : projectDir;

        // 무시 필터 초기화
        this._ignoreFilter = new IgnoreFilter(this._config.ignore, projectDir);

        // 1. 파일 목록 스캔
        const files = this._scanFiles(scanDir, projectDir);

        // 최대 파일 수 체크
        const maxFiles = this._config.indexing.maxFiles || 50000;
        if (files.length > maxFiles) {
            console.error(`[n2-context] Warning: ${files.length} files found, limiting to ${maxFiles}`);
            files.length = maxFiles;
        }

        // 2. 전체 재인덱싱이면 기존 데이터 클리어
        if (options.force) {
            this._store.db.exec('DELETE FROM chunks');
            this._store.db.exec('DELETE FROM files');
        }

        // 3. 증분 인덱싱
        let indexed = 0;
        let skipped = 0;

        for (const fileMeta of files) {
            const result = this._indexFile(fileMeta, projectDir);
            if (result === 'indexed') indexed++;
            else skipped++;
        }

        // 4. stale 파일 정리
        const removed = this._store.cleanStaleFiles(projectDir);

        // 5. 메타 업데이트
        this._store._setMeta('last_indexed_at', new Date().toISOString());
        this._store._setMeta('project_dir', projectDir);
        this._store._setMeta('file_count', String(indexed + skipped));

        const elapsed = Date.now() - startTime;
        return { indexed, skipped, removed, elapsed, total: files.length };
    }

    /**
     * 디렉토리 재귀 스캔
     * @returns {Array<{absolutePath:string, relativePath:string, stat:fs.Stats}>}
     */
    _scanFiles(dir, projectRoot) {
        const results = [];
        const maxFileSize = this._config.indexing.maxFileSize || 1024 * 1024;
        const supported = new Set([
            ...(this._config.indexing.supportedLanguages || []),
            ...(this._config.indexing.alsoIndexAsText || []),
        ]);

        const scan = (currentDir) => {
            let entries;
            try {
                entries = fs.readdirSync(currentDir, { withFileTypes: true });
            } catch {
                return; // 권한 없는 디렉토리 무시
            }

            for (const entry of entries) {
                const fullPath = path.join(currentDir, entry.name);
                const relativePath = path.relative(projectRoot, fullPath);

                // 무시 필터 체크
                if (this._ignoreFilter.isIgnored(relativePath)) continue;

                if (entry.isDirectory()) {
                    // 디렉토리 자체도 무시 체크
                    if (this._ignoreFilter.isIgnored(relativePath + '/')) continue;
                    scan(fullPath);
                } else if (entry.isFile()) {
                    // 확장자 체크
                    const ext = path.extname(entry.name).slice(1).toLowerCase();
                    if (!supported.has(ext)) continue;

                    // 파일 크기 체크
                    let stat;
                    try { stat = fs.statSync(fullPath); } catch { continue; }
                    if (stat.size > maxFileSize) continue;
                    if (stat.size === 0) continue;

                    results.push({
                        absolutePath: fullPath,
                        relativePath: relativePath.replace(/\\/g, '/'),
                        stat,
                    });
                }
            }
        };

        scan(dir);
        return results;
    }

    /**
     * 개별 파일 인덱싱
     * @returns {'indexed'|'skipped'}
     */
    _indexFile(fileMeta, projectDir) {
        const { absolutePath, relativePath, stat } = fileMeta;

        // 파일 내용 읽기 + 해시 계산
        let content;
        try {
            content = fs.readFileSync(absolutePath, 'utf-8');
        } catch {
            return 'skipped';
        }

        const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
        const ext = path.extname(absolutePath).slice(1).toLowerCase();
        const modifiedAt = stat.mtime.toISOString();

        // DB upsert (해시 비교로 변경 여부 판단)
        const { action, fileId } = this._store.upsertFile(
            relativePath, hash, ext, stat.size, modifiedAt
        );

        if (action === 'skipped') return 'skipped';

        // 청킹
        const chunks = chunkCode(content, ext);

        // 청크 DB 저장
        if (chunks.length > 0) {
            this._store.insertChunks(fileId, chunks);
        }

        // Phase 2: 의존성 추출
        try {
            indexFileDependencies(this._store, fileId, content, ext, relativePath);
        } catch {
            // 의존성 추출 실패는 치명적이지 않음
        }

        return 'indexed';
    }

    /**
     * 인덱스된 파일 목록 조회
     */
    getFiles(options = {}) {
        return this._store.getAllFiles(options.language);
    }

    /**
     * 인덱스 통계
     */
    getStats() {
        return this._store.getStats();
    }
}

module.exports = { Indexer };
