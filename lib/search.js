// search.js — BM25 키워드 검색 (QLN 라우터 경량 버전)
// QLN의 Router._stage2BM25 로직을 코드 검색에 최적화

class BM25Search {
    /**
     * @param {object} store - Store 인스턴스
     * @param {object} config - search 설정 (config.search)
     */
    constructor(store, config) {
        this._store = store;
        this._k1 = config.bm25?.k1 || 1.2;
        this._b = config.bm25?.b || 0.75;
        this._topK = config.topK || 10;
    }

    /**
     * BM25 검색 실행
     * @param {string} query - 검색 쿼리
     * @param {object} [options]
     * @param {number} [options.topK] - 결과 수
     * @param {string} [options.language] - 언어 필터
     * @returns {Array<{chunk: object, score: number}>}
     */
    search(query, options = {}) {
        if (!query || typeof query !== 'string') return [];
        const topK = options.topK || this._topK;
        const terms = this._tokenize(query);
        if (terms.length === 0) return [];

        // 모든 청크 로드 (언어 필터 적용)
        const chunks = this._loadChunks(options.language);
        if (chunks.length === 0) return [];

        // 문서 통계 계산
        const N = chunks.length;
        const avgDl = chunks.reduce((sum, c) => sum + (c.search_text || '').length, 0) / N;

        // DF(문서 빈도) 계산
        const df = {};
        for (const term of terms) {
            df[term] = chunks.filter(c => (c.search_text || '').toLowerCase().includes(term)).length;
        }

        // BM25 스코어 계산
        const scored = [];
        for (const chunk of chunks) {
            const doc = (chunk.search_text || '').toLowerCase();
            const dl = doc.length;
            let score = 0;

            for (const term of terms) {
                const tf = this._countOccurrences(doc, term);
                if (tf === 0) continue;
                const idf = Math.log((N - df[term] + 0.5) / (df[term] + 0.5) + 1);
                const numerator = tf * (this._k1 + 1);
                const denominator = tf + this._k1 * (1 - this._b + this._b * (dl / avgDl));
                score += idf * (numerator / denominator);
            }

            if (score > 0) {
                score = this._applyBonuses(score, chunk, terms);
                scored.push({ chunk, score });
            }
        }

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topK);
    }

    /** 파일명/함수명 매칭 보너스 적용 */
    _applyBonuses(score, chunk, terms) {
        const filePath = (chunk.file_path || '').toLowerCase();
        for (const term of terms) {
            if (filePath.includes(term)) score *= 1.3;
        }
        if (chunk.name) {
            const chunkName = chunk.name.toLowerCase();
            for (const term of terms) {
                if (chunkName.includes(term)) score *= 1.5;
            }
        }
        return score;
    }

    /** 청크 로드 (언어 필터 옵션) */
    _loadChunks(language) {
        const sql = language
            ? `SELECT c.*, f.path as file_path, f.language FROM chunks c JOIN files f ON c.file_id = f.id WHERE f.language = ?`
            : `SELECT c.*, f.path as file_path, f.language FROM chunks c JOIN files f ON c.file_id = f.id`;
        return language ? this._store.db.prepare(sql).all(language) : this._store.db.prepare(sql).all();
    }

    /**
     * 텍스트 토큰화
     */
    _tokenize(text) {
        return text
            .toLowerCase()
            .replace(/[^a-z0-9가-힣_\s]/g, ' ')
            .split(/\s+/)
            .filter(t => t.length >= 2);
    }

    /**
     * 문자열 내 용어 출현 횟수
     */
    _countOccurrences(text, term) {
        let count = 0;
        let pos = 0;
        while ((pos = text.indexOf(term, pos)) !== -1) {
            count++;
            pos += term.length;
        }
        return count;
    }

    /**
     * VectorStore 연결 (Phase 3)
     * @param {import('./vector-store').VectorStore} vectorStore
     */
    setVectorStore(vectorStore) {
        this._vectorStore = vectorStore;
    }

    /**
     * 하이브리드 검색: BM25 + 시맨틱 가중 합산
     * @param {string} query
     * @param {object} [options]
     * @param {number} [options.topK=10]
     * @param {number} [options.alpha=0.5] - 시맨틱 가중치 (0=BM25 only, 1=semantic only)
     * @returns {Promise<Array<{chunk: object, score: number, bm25Score: number, semanticScore: number}>>}
     */
    async hybridSearch(query, options = {}) {
        if (!query || typeof query !== 'string') return [];
        const topK = options.topK || 10;
        const alpha = options.alpha ?? 0.5;

        // BM25 검색
        const bm25Results = this.search(query, { topK: topK * 2 });

        // VectorStore 없으면 BM25-only
        if (!this._vectorStore || !this._vectorStore.isReady) {
            return bm25Results.map(r => ({
                chunk: r.chunk,
                score: r.score,
                bm25Score: r.score,
                semanticScore: 0,
            })).slice(0, topK);
        }

        // 시맨틱 검색
        const vecResults = await this._vectorStore.search(query, topK * 2);

        // BM25 스코어 정규화 (0~1)
        const maxBm25 = bm25Results.length > 0 ? bm25Results[0].score : 1;
        const bm25Map = new Map();
        for (const r of bm25Results) {
            bm25Map.set(r.chunk.id, {
                chunk: r.chunk,
                normalizedScore: maxBm25 > 0 ? r.score / maxBm25 : 0,
                rawScore: r.score,
            });
        }

        // 시맨틱 거리 → 유사도 (distance가 작을수록 유사)
        const maxDist = vecResults.length > 0 ? Math.max(...vecResults.map(v => v.distance), 1) : 1;
        const vecMap = new Map();
        for (const v of vecResults) {
            vecMap.set(v.chunkId, maxDist > 0 ? 1 - (v.distance / maxDist) : 0);
        }

        // 병합: 모든 후보 수집
        const allIds = new Set([...bm25Map.keys(), ...vecMap.keys()]);
        const merged = [];

        for (const id of allIds) {
            const bm25Entry = bm25Map.get(id);
            const semanticScore = vecMap.get(id) || 0;
            const bm25Normalized = bm25Entry ? bm25Entry.normalizedScore : 0;

            const hybridScore = (1 - alpha) * bm25Normalized + alpha * semanticScore;

            // 청크 정보: BM25에 있으면 그것 사용, 없으면 DB 조회
            let chunk = bm25Entry ? bm25Entry.chunk : null;
            if (!chunk) {
                const row = this._store.db.prepare(
                    `SELECT c.*, f.path as file_path, f.language
                     FROM chunks c JOIN files f ON c.file_id = f.id
                     WHERE c.id = ?`
                ).get(id);
                if (!row) continue;
                chunk = row;
            }

            merged.push({
                chunk,
                score: hybridScore,
                bm25Score: bm25Entry ? bm25Entry.rawScore : 0,
                semanticScore,
            });
        }

        merged.sort((a, b) => b.score - a.score);
        return merged.slice(0, topK);
    }
}

module.exports = { BM25Search };
