// embedding.js — Ollama 임베딩 엔진 (QLN embedding.js 재활용)
// 로컬 Ollama에서 nomic-embed-text 벡터 생성, Ollama 없으면 graceful degradation
const http = require('http');

class Embedding {
    /**
     * @param {object} config - config.embedding 객체
     */
    constructor(config = {}) {
        this.model = config.model || 'nomic-embed-text';
        this.endpoint = config.endpoint || 'http://127.0.0.1:11434';
        this.dimensions = null;
        this._available = null;
    }

    /**
     * Ollama 가용성 체크 (캐시, 한 번만 확인)
     * @returns {Promise<boolean>}
     */
    async isAvailable() {
        if (this._available !== null) return this._available;
        try {
            const vec = await this.embed('test');
            this._available = vec.length > 0;
            this.dimensions = vec.length;
            return this._available;
        } catch {
            this._available = false;
            return false;
        }
    }

    /** 캐시 리셋 (재연결 시도 시) */
    resetAvailability() {
        this._available = null;
        this.dimensions = null;
    }

    /**
     * 텍스트 → 벡터 임베딩 생성
     * @param {string} text
     * @returns {Promise<number[]>}
     */
    async embed(text) {
        if (!text || text.trim().length === 0) return [];
        const input = text.length > 2000 ? text.slice(0, 2000) : text;

        for (const apiPath of ['/api/embeddings', '/api/embed']) {
            try {
                const body = apiPath === '/api/embeddings'
                    ? { model: this.model, prompt: input }
                    : { model: this.model, input: input };
                const result = await this._post(apiPath, body);

                if (result.embedding && Array.isArray(result.embedding)) {
                    this.dimensions = result.embedding.length;
                    return result.embedding;
                }
                if (result.embeddings && Array.isArray(result.embeddings) && result.embeddings[0]) {
                    this.dimensions = result.embeddings[0].length;
                    return result.embeddings[0];
                }
            } catch { continue; }
        }
        return [];
    }

    /**
     * 배치 임베딩 생성
     * @param {string[]} texts
     * @returns {Promise<number[][]>}
     */
    async embedBatch(texts) {
        const results = [];
        for (const text of texts) {
            results.push(await this.embed(text));
        }
        return results;
    }

    /**
     * 코사인 유사도 계산
     * @param {number[]} a
     * @param {number[]} b
     * @returns {number} 0~1
     */
    cosineSimilarity(a, b) {
        if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom === 0 ? 0 : dot / denom;
    }

    /** @private HTTP POST to Ollama API */
    _post(apiPath, body) {
        return new Promise((resolve, reject) => {
            const url = new URL(this.endpoint);
            const options = {
                hostname: url.hostname,
                port: url.port || 11434,
                path: apiPath,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                timeout: 30000,
            };
            const req = http.request(options, res => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode >= 400) {
                        reject(new Error(`Ollama ${res.statusCode}: ${data.slice(0, 200)}`));
                        return;
                    }
                    try { resolve(JSON.parse(data)); }
                    catch { reject(new Error(`Invalid JSON: ${data.slice(0, 100)}`)); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            req.write(JSON.stringify(body));
            req.end();
        });
    }
}

module.exports = { Embedding };
