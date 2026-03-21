// config.js — Configuration loader (config.default.js → config.local.js override)
const path = require('path');
const fs = require('fs');

/**
 * Deep merge — config.local.js overrides config.default.js
 * Arrays are replaced, objects are recursively merged
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
 * Environment variable override mapping
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
 * Load config: default → local → env
 * @param {string} [baseDir] - Base directory for config files (default: package root)
 * @returns {object} Merged configuration object
 */
function loadConfig(baseDir) {
    const root = baseDir || path.resolve(__dirname, '..');
    
    // 1. Load default config
    const defaultConfig = require(path.join(root, 'config.default.js'));

    // 2. Local override (if exists)
    const localPath = path.join(root, 'config.local.js');
    let merged = { ...defaultConfig };
    if (fs.existsSync(localPath)) {
        const localConfig = require(localPath);
        merged = deepMerge(defaultConfig, localConfig);
    }

    // 3. Environment variable overrides
    merged = applyEnvOverrides(merged);

    // 4. Normalize paths (relative → absolute)
    if (!path.isAbsolute(merged.dataDir)) {
        merged.dataDir = path.resolve(root, merged.dataDir);
    }
    if (merged.backup.dir && !path.isAbsolute(merged.backup.dir)) {
        merged.backup.dir = path.resolve(root, merged.backup.dir);
    }

    // 5. Default projectDir
    if (!merged.projectDir) {
        merged.projectDir = process.cwd();
    }

    return merged;
}

module.exports = { loadConfig, deepMerge };
