// vector-store.js — sqlite-vec 기반 벡터 저장/KNN 검색
// 청크 임베딩을 SQLite에 저장하고 시맨틱 유사도 검색 수행
const sqliteVec = require('sqlite-vec');

class VectorStore {
    /**
     * @param {import('./store').Store} store
     * @param {import('./embedding').Embedding} embedding
     */
    constructor(store, embedding) {
        this._store = store;
        this._embedding = embedding;
        this._dimensions = null;
        this._initialized = false;
    }

    /**
     * sqlite-vec 확장 로드 + vec0 테이블 생성
     * @returns {Promise<boolean>}
     */
    async init() {
        if (this._initialized) return true;

        try {
            // 1. sqlite-vec 확장 로드
            sqliteVec.load(this._store.db);

            // 2. 임베딩 가용성 체크 (차원 수 확인)
            const available = await this._embedding.isAvailable();
            if (!available) {
                console.error('[vector-store] Ollama unavailable, vector search disabled');
                return false;
            }
            this._dimensions = this._embedding.dimensions;

            // 3. vec0 가상 테이블 생성
            this._store.db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks
                USING vec0(embedding float[${this._dimensions}])
            `);

            this._initialized = true;
            console.error(`[vector-store] Initialized: ${this._dimensions}D vectors`);
            return true;
        } catch (err) {
            console.error(`[vector-store] Init failed: ${err.message}`);
            return false;
        }
    }

    /** 초기화 여부 */
    get isReady() {
        return this._initialized;
    }

    /**
     * 아직 임베딩 안 된 청크만 처리
     * @returns {Promise<{embedded: number, skipped: number, errors: number}>}
     */
    async embedNewChunks() {
        if (!this._initialized) return { embedded: 0, skipped: 0, errors: 0 };

        // 벡터 테이블에 없는 청크 ID 조회
        const unembedded = this._store.db.prepare(`
            SELECT c.id, c.content, c.name, c.chunk_type
            FROM chunks c
            LEFT JOIN vec_chunks vc ON vc.rowid = c.id
            WHERE vc.rowid IS NULL
        `).all();

        let embedded = 0;
        let errors = 0;

        const insertStmt = this._store.db.prepare(
            'INSERT INTO vec_chunks(rowid, embedding) VALUES (?, ?)'
        );

        for (const chunk of unembedded) {
            try {
                const text = this._buildEmbeddingText(chunk);
                const vector = await this._embedding.embed(text);
                if (vector.length === 0) { errors++; continue; }

                insertStmt.run(BigInt(chunk.id), new Float32Array(vector));
                embedded++;
            } catch {
                errors++;
            }
        }

        return { embedded, skipped: unembedded.length - embedded - errors, errors };
    }

    /**
     * KNN 벡터 검색
     * @param {string} query - 검색 쿼리 텍스트
     * @param {number} [topK=10]
     * @returns {Promise<Array<{chunkId: number, distance: number}>>}
     */
    async search(query, topK = 10) {
        if (!this._initialized) return [];

        const queryVector = await this._embedding.embed(query);
        if (queryVector.length === 0) return [];

        const rows = this._store.db.prepare(`
            SELECT rowid, distance
            FROM vec_chunks
            WHERE embedding MATCH ?
            ORDER BY distance
            LIMIT ?
        `).all(new Float32Array(queryVector), topK);

        return rows.map(r => ({
            chunkId: Number(r.rowid),
            distance: r.distance,
        }));
    }

    /**
     * 임베딩된 청크 수
     * @returns {number}
     */
    getEmbeddedCount() {
        if (!this._initialized) return 0;
        try {
            return this._store.db.prepare('SELECT COUNT(*) as cnt FROM vec_chunks').get().cnt;
        } catch {
            return 0;
        }
    }

    /**
     * 특정 청크 임베딩 삭제 (인덱스 재빌드 시)
     * @param {number[]} chunkIds
     */
    deleteByChunkIds(chunkIds) {
        if (!this._initialized || chunkIds.length === 0) return;
        const del = this._store.db.prepare('DELETE FROM vec_chunks WHERE rowid = ?');
        const tx = this._store.db.transaction((ids) => {
            for (const id of ids) del.run(BigInt(id));
        });
        tx(chunkIds);
    }

    /**
     * 임베딩용 텍스트 생성 (청크 메타 + 내용 결합)
     * @private
     */
    _buildEmbeddingText(chunk) {
        const parts = [];
        if (chunk.name) parts.push(chunk.name);
        if (chunk.chunk_type) parts.push(`[${chunk.chunk_type}]`);
        parts.push(chunk.content);
        return parts.join(' ').slice(0, 2000);
    }
}

module.exports = { VectorStore };
