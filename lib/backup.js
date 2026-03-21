// backup.js — 백업/복구/GC (Soul의 n2_kv_backup 패턴)
const fs = require('fs');
const path = require('path');

class Backup {
    /**
     * @param {import('./store').Store} store
     * @param {object} config - backup 설정 (config.backup)
     */
    constructor(store, config) {
        this._store = store;
        this._config = config;
        this._metaPath = path.join(store.backupDir, 'backups.json');
    }

    /**
     * 현재 DB 백업
     * @param {string} [label] - 사람이 읽을 수 있는 라벨
     * @param {string} [trigger] - 트리거 유형 (manual, pre-reindex, scheduled, pre-migration)
     * @returns {Promise<{id:string, filename:string, size:number}>}
     */
    async create(label, trigger = 'manual') {
        fs.mkdirSync(this._store.backupDir, { recursive: true });

        const id = this._generateId();
        const filename = `context-${id}.db`;
        const dest = path.join(this._store.backupDir, filename);

        // better-sqlite3의 .backup() — 온라인 백업, 락 최소화
        await this._store.db.backup(dest);

        const size = fs.statSync(dest).size;
        const stats = this._store.getStats();

        // 메타데이터 기록
        const meta = this._loadMeta();
        meta.backups.push({
            id,
            filename,
            label: label || null,
            trigger,
            created_at: new Date().toISOString(),
            file_count: stats.fileCount,
            chunk_count: stats.chunkCount,
            size_bytes: size,
        });
        this._saveMeta(meta);

        // 자동 GC (최대 수 초과 시)
        await this.gc();

        return { id, filename, size, files: stats.fileCount, chunks: stats.chunkCount };
    }

    /**
     * 백업에서 복구
     * @param {string} [backupId] - 백업 ID (없으면 최신)
     */
    async restore(backupId) {
        const meta = this._loadMeta();
        let entry;

        if (backupId) {
            entry = meta.backups.find(b => b.id === backupId);
        } else {
            entry = meta.backups[meta.backups.length - 1]; // 최신
        }

        if (!entry) {
            throw new Error(`Backup not found: ${backupId || 'latest'}`);
        }

        const src = path.join(this._store.backupDir, entry.filename);
        if (!fs.existsSync(src)) {
            throw new Error(`Backup file missing: ${entry.filename}`);
        }

        // DB 닫기 → 백업으로 교체 → 다시 열기
        this._store.close();
        fs.copyFileSync(src, this._store.dbPath);

        // Store를 다시 초기화해야 함 (호출자 책임)
        return { restored: entry.id, label: entry.label, files: entry.file_count };
    }

    /**
     * 백업 목록
     */
    list() {
        const meta = this._loadMeta();
        return meta.backups.map(b => ({
            id: b.id,
            label: b.label,
            trigger: b.trigger,
            created_at: b.created_at,
            files: b.file_count,
            chunks: b.chunk_count,
            sizeMB: (b.size_bytes / 1024 / 1024).toFixed(2),
        }));
    }

    /**
     * 백업 DB 내 검색 (ATTACH DATABASE)
     * @param {string} backupId - 백업 ID
     * @param {string} query - 검색어
     * @param {number} [limit=10]
     */
    searchBackup(backupId, query, limit = 10) {
        const meta = this._loadMeta();
        const entry = meta.backups.find(b => b.id === backupId);
        if (!entry) throw new Error(`Backup not found: ${backupId}`);

        const backupPath = path.join(this._store.backupDir, entry.filename);
        if (!fs.existsSync(backupPath)) throw new Error(`Backup file missing: ${entry.filename}`);

        const db = this._store.db;
        const safeAlias = 'bk_' + backupId.replace(/[^a-z0-9]/gi, '_');

        db.exec(`ATTACH DATABASE '${backupPath.replace(/'/g, "''")}' AS ${safeAlias}`);
        try {
            const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
            if (terms.length === 0) return [];

            const conditions = terms.map(() => `LOWER(search_text) LIKE ?`).join(' AND ');
            const params = terms.map(t => `%${t}%`);

            return db.prepare(`
                SELECT *, '${backupId}' as backup_id
                FROM ${safeAlias}.chunks
                WHERE ${conditions}
                LIMIT ?
            `).all(...params, limit);
        } finally {
            db.exec(`DETACH DATABASE ${safeAlias}`);
        }
    }

    /**
     * GC: 오래된/초과 백업 삭제
     */
    async gc(maxAgeDays, maxCount) {
        const maxAge = maxAgeDays || this._config.maxAgeDays || 30;
        const maxBackups = maxCount || this._config.maxBackups || 10;
        const meta = this._loadMeta();
        let removed = 0;
        const cutoff = Date.now() - maxAge * 86400000;

        // 오래된 백업 삭제
        meta.backups = meta.backups.filter(b => {
            const age = new Date(b.created_at).getTime();
            if (age < cutoff) {
                this._deleteBackupFile(b.filename);
                removed++;
                return false;
            }
            return true;
        });

        // 최대 수 초과 시 오래된 것부터 삭제
        while (meta.backups.length > maxBackups) {
            const oldest = meta.backups.shift();
            this._deleteBackupFile(oldest.filename);
            removed++;
        }

        this._saveMeta(meta);
        return removed;
    }

    /**
     * 외부 경로로 백업 내보내기
     */
    exportTo(externalDir) {
        if (!externalDir) return null;
        fs.mkdirSync(externalDir, { recursive: true });

        const meta = this._loadMeta();
        if (meta.backups.length === 0) return null;

        const latest = meta.backups[meta.backups.length - 1];
        const src = path.join(this._store.backupDir, latest.filename);
        const dest = path.join(externalDir, latest.filename);

        if (fs.existsSync(src)) {
            fs.copyFileSync(src, dest);
            // 메타도 복사
            fs.copyFileSync(this._metaPath, path.join(externalDir, 'backups.json'));
            return { exported: latest.id, dest };
        }
        return null;
    }

    // ── Private ──

    _generateId() {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    }

    _loadMeta() {
        if (!fs.existsSync(this._metaPath)) {
            return { backups: [] };
        }
        return JSON.parse(fs.readFileSync(this._metaPath, 'utf-8'));
    }

    _saveMeta(meta) {
        fs.writeFileSync(this._metaPath, JSON.stringify(meta, null, 2));
    }

    _deleteBackupFile(filename) {
        const filePath = path.join(this._store.backupDir, filename);
        try { fs.unlinkSync(filePath); } catch { /* ignore if already gone */ }
    }
}

module.exports = { Backup };
