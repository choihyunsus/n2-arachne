// config.js — 설정 로더 (config.default.js → config.local.js 오버라이드)
const path = require('path');
const fs = require('fs');

/**
 * 깊은 병합 (deep merge) — config.local.js가 config.default.js를 오버라이드
 * 배열은 교체, 객체는 재귀 병합
 */
function deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        if (
            source[key] &&
            typeof source[key] === 'object' &&
            !Array.isArray(source[key]) &&
            target[key] &&
            typeof target[key] === 'object' &&
            !Array.isArray(target[key])
        ) {
            result[key] = deepMerge(target[key], source[key]);
        } else {
            result[key] = source[key];
        }
    }
    return result;
}

/**
 * 환경변수 오버라이드 매핑
 */
function applyEnvOverrides(config) {
    const envMap = {
        'N2_CONTEXT_DATA_DIR': (c, v) => { c.dataDir = v; },
        'N2_CONTEXT_PROJECT_DIR': (c, v) => { c.projectDir = v; },
        'N2_CONTEXT_MAX_FILES': (c, v) => { c.indexing.maxFiles = parseInt(v, 10); },
        'N2_CONTEXT_BUDGET': (c, v) => { c.assembly.defaultBudget = parseInt(v, 10); },
        'N2_CONTEXT_EMBEDDING_ENABLED': (c, v) => { c.embedding.enabled = v === 'true'; },
        'N2_CONTEXT_EMBEDDING_ENDPOINT': (c, v) => { c.embedding.endpoint = v; },
        'N2_CONTEXT_BACKUP_DIR': (c, v) => { c.backup.dir = v; },
        'N2_CONTEXT_EXTERNAL_BACKUP': (c, v) => { c.backup.externalBackupDir = v; },
    };

    for (const [envKey, applier] of Object.entries(envMap)) {
        if (process.env[envKey]) {
            applier(config, process.env[envKey]);
        }
    }
    return config;
}

/**
 * 설정 로드: default → local → env
 * @param {string} [baseDir] - config 파일 기준 디렉토리 (기본: 패키지 루트)
 * @returns {object} 병합된 설정 객체
 */
function loadConfig(baseDir) {
    const root = baseDir || path.resolve(__dirname, '..');
    
    // 1. 기본 설정 로드
    const defaultConfig = require(path.join(root, 'config.default.js'));

    // 2. 로컬 오버라이드 (존재하면)
    const localPath = path.join(root, 'config.local.js');
    let merged = { ...defaultConfig };
    if (fs.existsSync(localPath)) {
        const localConfig = require(localPath);
        merged = deepMerge(defaultConfig, localConfig);
    }

    // 3. 환경변수 오버라이드
    merged = applyEnvOverrides(merged);

    // 4. 경로 정규화 (상대 → 절대)
    if (!path.isAbsolute(merged.dataDir)) {
        merged.dataDir = path.resolve(root, merged.dataDir);
    }
    if (merged.backup.dir && !path.isAbsolute(merged.backup.dir)) {
        merged.backup.dir = path.resolve(root, merged.backup.dir);
    }

    // 5. projectDir 기본값
    if (!merged.projectDir) {
        merged.projectDir = process.cwd();
    }

    return merged;
}

module.exports = { loadConfig, deepMerge };
