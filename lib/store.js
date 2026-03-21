// store.js — SQLite DB 관리 (스키마 생성, 마이그레이션, 기본 쿼리)
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 3;

const SCHEMA_SQL = `
-- 메타 정보 (버전, 프로젝트 경로 등)
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 파일 인덱스
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    hash TEXT NOT NULL,
    language TEXT,
    size_bytes INTEGER,
    chunk_count INTEGER DEFAULT 0,
    indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    modified_at DATETIME
);

-- 코드 청크 (함수/클래스/블록 단위)
CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    chunk_type TEXT NOT NULL,
    name TEXT,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    content TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    search_text TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 검색 인덱스
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
`;

// Phase 2 스키마 — 의존성 그래프 + 접근 이력
const SCHEMA_V2_SQL = `
-- 의존성 그래프 (import/require 관계)
CREATE TABLE IF NOT EXISTS dependencies (
    source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    target_path TEXT NOT NULL,
    target_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
    dep_type TEXT DEFAULT 'import',
    PRIMARY KEY (source_file_id, target_path)
);

-- 접근 이력 (자주 사용하는 파일 추적)
CREATE TABLE IF NOT EXISTS access_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    query TEXT,
    accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_deps_source ON dependencies(source_file_id);
CREATE INDEX IF NOT EXISTS idx_deps_target ON dependencies(target_file_id);
CREATE INDEX IF NOT EXISTS idx_access_file ON access_log(file_id);
CREATE INDEX IF NOT EXISTS idx_access_time ON access_log(accessed_at);
`;

// Phase 3 스키마 — 임베딩 메타 정보 (벡터 자체는 sqlite-vec vec0 테이블)
const SCHEMA_V3_SQL = `
CREATE TABLE IF NOT EXISTS embeddings_meta (
    chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    model TEXT DEFAULT 'nomic-embed-text',
    dimensions INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

class Store {
    /**
     * @param {string} dataDir - 데이터 디렉토리 경로
     */
    constructor(dataDir) {
        this._dataDir = dataDir;
        this._dbPath = path.join(dataDir, 'context.db');
        this._backupDir = path.join(dataDir, 'backups');
        this._db = null;
    }

    /** DB 초기화 (디렉토리 생성 + 스키마 적용) */
    async init() {
        // 디렉토리 생성
        fs.mkdirSync(this._dataDir, { recursive: true });
        fs.mkdirSync(this._backupDir, { recursive: true });

        // SQLite 연결
        this._db = new Database(this._dbPath);

        // WAL 모드 (동시성 향상)
        this._db.pragma('journal_mode = WAL');
        // 외래키 활성화
        this._db.pragma('foreign_keys = ON');

        // 스키마 적용
        this._db.exec(SCHEMA_SQL);

        // Phase 2 마이그레이션
        this._migrate();

        // 버전 기록
        this._setMeta('schema_version', String(SCHEMA_VERSION));
        this._setMeta('created_at', new Date().toISOString());
    }

    /** 마이그레이션 (v1→v2→v3) */
    _migrate() {
        const currentVersion = Number(this.getMeta('schema_version') || '1');
        if (currentVersion < 2) {
            this._db.exec(SCHEMA_V2_SQL);
        }
        if (currentVersion < 3) {
            this._db.exec(SCHEMA_V3_SQL);
        }
    }

    /** DB 인스턴스 */
    get db() { return this._db; }

    /** DB 경로 */
    get dbPath() { return this._dbPath; }

    /** 백업 디렉토리 */
    get backupDir() { return this._backupDir; }

    // ── 메타 ──

    _setMeta(key, value) {
        this._db.prepare(`
            INSERT INTO meta (key, value, updated_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(key, value);
    }

    getMeta(key) {
        const row = this._db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
        return row ? row.value : null;
    }

    // ── 파일 ──

    /**
     * 파일 upsert (존재하면 해시 비교 후 업데이트)
     * @returns {{ action: 'inserted'|'updated'|'skipped', fileId: number }}
     */
    upsertFile(relativePath, hash, language, sizeBytes, modifiedAt) {
        const existing = this._db.prepare('SELECT id, hash FROM files WHERE path = ?').get(relativePath);

        if (existing) {
            if (existing.hash === hash) {
                return { action: 'skipped', fileId: existing.id };
            }
            // 해시 변경 → 청크 삭제 후 파일 업데이트
            this._db.prepare('DELETE FROM chunks WHERE file_id = ?').run(existing.id);
            this._db.prepare(`
                UPDATE files SET hash = ?, language = ?, size_bytes = ?,
                    chunk_count = 0, indexed_at = datetime('now'), modified_at = ?
                WHERE id = ?
            `).run(hash, language, sizeBytes, modifiedAt, existing.id);
            return { action: 'updated', fileId: existing.id };
        }

        const result = this._db.prepare(`
            INSERT INTO files (path, hash, language, size_bytes, modified_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(relativePath, hash, language, sizeBytes, modifiedAt);
        return { action: 'inserted', fileId: result.lastInsertRowid };
    }

    /** 파일에 청크 추가 */
    insertChunks(fileId, chunks) {
        const stmt = this._db.prepare(`
            INSERT INTO chunks (file_id, chunk_type, name, start_line, end_line, content, token_count, search_text)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertMany = this._db.transaction((items) => {
            for (const c of items) {
                stmt.run(fileId, c.type, c.name, c.startLine, c.endLine, c.content, c.tokenCount, c.searchText);
            }
        });

        insertMany(chunks);

        // 파일의 chunk_count 업데이트
        this._db.prepare('UPDATE files SET chunk_count = ? WHERE id = ?').run(chunks.length, fileId);
    }

    /** 파일 삭제 (CASCADE로 청크도 삭제) */
    removeFile(relativePath) {
        return this._db.prepare('DELETE FROM files WHERE path = ?').run(relativePath);
    }

    /** 파일 경로로 ID 조회 */
    getFileByPath(relativePath) {
        return this._db.prepare('SELECT * FROM files WHERE path = ?').get(relativePath);
    }

    /** 전체 인덱스된 파일 목록 */
    getAllFiles(language) {
        if (language) {
            return this._db.prepare('SELECT * FROM files WHERE language = ? ORDER BY path').all(language);
        }
        return this._db.prepare('SELECT * FROM files ORDER BY path').all();
    }

    /** 파일에 속하는 청크 목록 */
    getChunksByFileId(fileId) {
        return this._db.prepare('SELECT * FROM chunks WHERE file_id = ? ORDER BY start_line').all(fileId);
    }

    // ── 검색 ──

    /** search_text에서 LIKE 검색 (간단 키워드 검색) */
    searchChunks(query, limit = 10) {
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        if (terms.length === 0) return [];

        // 모든 검색어를 포함하는 청크 찾기
        const conditions = terms.map(() => "LOWER(c.search_text) LIKE ?").join(' AND ');
        const params = terms.map(t => `%${t}%`);

        return this._db.prepare(`
            SELECT c.*, f.path as file_path, f.language
            FROM chunks c
            JOIN files f ON c.file_id = f.id
            WHERE ${conditions}
            ORDER BY c.token_count ASC
            LIMIT ?
        `).all(...params, limit);
    }

    // ── 통계 ──

    getStats() {
        const fileCount = this._db.prepare('SELECT COUNT(*) as cnt FROM files').get().cnt;
        const chunkCount = this._db.prepare('SELECT COUNT(*) as cnt FROM chunks').get().cnt;
        const totalTokens = this._db.prepare('SELECT COALESCE(SUM(token_count), 0) as total FROM chunks').get().total;
        const languages = this._db.prepare('SELECT language, COUNT(*) as cnt FROM files GROUP BY language ORDER BY cnt DESC').all();

        let dbSize = 0;
        try { dbSize = fs.statSync(this._dbPath).size; } catch { /* ignore */ }

        return {
            fileCount,
            chunkCount,
            totalTokens,
            languages,
            dbSizeBytes: dbSize,
            dbSizeMB: (dbSize / 1024 / 1024).toFixed(2),
            lastIndexed: this.getMeta('last_indexed_at'),
            schemaVersion: this.getMeta('schema_version'),
        };
    }

    // ── stale 파일 정리 ──

    /** 존재하지 않는 파일 제거 */
    cleanStaleFiles(projectDir) {
        const allFiles = this._db.prepare('SELECT id, path FROM files').all();
        let removed = 0;

        const deleteStmt = this._db.prepare('DELETE FROM files WHERE id = ?');
        const cleanTransaction = this._db.transaction((files) => {
            for (const f of files) {
                const fullPath = path.join(projectDir, f.path);
                if (!fs.existsSync(fullPath)) {
                    deleteStmt.run(f.id);
                    removed++;
                }
            }
        });

        cleanTransaction(allFiles);
        return removed;
    }

    // ── 의존성 (Phase 2) ──

    /** 파일의 의존성 일괄 저장 */
    insertDependencies(fileId, deps) {
        const stmt = this._db.prepare(`
            INSERT OR REPLACE INTO dependencies (source_file_id, target_path, target_file_id, dep_type)
            VALUES (?, ?, ?, ?)
        `);
        const insertMany = this._db.transaction((items) => {
            for (const d of items) {
                stmt.run(fileId, d.targetPath, d.targetFileId || null, d.depType || 'import');
            }
        });
        insertMany(deps);
    }

    /** 파일의 의존성 초기화 */
    clearDependencies(fileId) {
        this._db.prepare('DELETE FROM dependencies WHERE source_file_id = ?').run(fileId);
    }

    /** 직접 의존성 조회 (depth=1) */
    getDirectDependencies(fileId) {
        return this._db.prepare(`
            SELECT d.*, f.path as target_resolved_path
            FROM dependencies d
            LEFT JOIN files f ON d.target_file_id = f.id
            WHERE d.source_file_id = ?
        `).all(fileId);
    }

    /** 재귀 의존성 탐색 (depth-limited BFS) */
    getTransitiveDependencies(fileId, maxDepth = 2) {
        const visited = new Set();
        const result = [];
        let queue = [{ fileId, depth: 0 }];

        while (queue.length > 0) {
            const { fileId: fid, depth } = queue.shift();
            if (visited.has(fid) || depth >= maxDepth) continue;
            visited.add(fid);

            const deps = this.getDirectDependencies(fid);
            for (const dep of deps) {
                result.push({ ...dep, depth: depth + 1 });
                if (dep.target_file_id && !visited.has(dep.target_file_id)) {
                    queue.push({ fileId: dep.target_file_id, depth: depth + 1 });
                }
            }
        }
        return result;
    }

    /** 역방향 의존성: 이 파일을 import하는 파일 목록 */
    getReverseDependencies(fileId) {
        return this._db.prepare(`
            SELECT d.*, f.path as source_path
            FROM dependencies d
            JOIN files f ON d.source_file_id = f.id
            WHERE d.target_file_id = ?
        `).all(fileId);
    }

    // ── 접근 로그 (Phase 2) ──

    /** 파일 접근 기록 */
    logAccess(fileId, query) {
        this._db.prepare(`
            INSERT INTO access_log (file_id, query) VALUES (?, ?)
        `).run(fileId, query || null);
    }

    /** 최근 접근 파일 ID + 경로 (중복 제거, 최신순) */
    getRecentFiles(limit = 10) {
        return this._db.prepare(`
            SELECT DISTINCT a.file_id, f.path, MAX(a.accessed_at) as last_access
            FROM access_log a
            JOIN files f ON a.file_id = f.id
            GROUP BY a.file_id
            ORDER BY last_access DESC
            LIMIT ?
        `).all(limit);
    }

    /** 자주 접근하는 파일 (횟수순) */
    getMostAccessedFiles(limit = 5) {
        return this._db.prepare(`
            SELECT a.file_id, f.path, COUNT(*) as access_count
            FROM access_log a
            JOIN files f ON a.file_id = f.id
            GROUP BY a.file_id
            ORDER BY access_count DESC
            LIMIT ?
        `).all(limit);
    }

    /** 여러 파일의 청크를 한 번에 조회 */
    getChunksByFileIds(fileIds) {
        if (!fileIds || fileIds.length === 0) return [];
        const placeholders = fileIds.map(() => '?').join(',');
        return this._db.prepare(`
            SELECT c.*, f.path as file_path, f.language
            FROM chunks c
            JOIN files f ON c.file_id = f.id
            WHERE c.file_id IN (${placeholders})
            ORDER BY c.file_id, c.start_line
        `).all(...fileIds);
    }

    /** 오래된 접근 로그 정리 */
    cleanAccessLog(maxAgeDays = 30) {
        const result = this._db.prepare(`
            DELETE FROM access_log
            WHERE accessed_at < datetime('now', '-' || ? || ' days')
        `).run(maxAgeDays);
        return result.changes;
    }

    /** DB 닫기 */
    close() {
        if (this._db) {
            this._db.close();
            this._db = null;
        }
    }
}

module.exports = { Store };
