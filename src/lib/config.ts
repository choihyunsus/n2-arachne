// Configuration loader (config.default.js → config.local.js override)
import path from 'path';
import fs from 'fs';
import type { ArachneConfig } from '../types';
import { validateConfig, booleanEnvironment } from './config-validation';

/**
 * Deep merge — config.local.js overrides config.default.js
 * Arrays are replaced, objects are recursively merged.
 * Note: as-casts are structurally required for generic deep merge.
 */
export function deepMerge(target: ArachneConfig, source: Partial<ArachneConfig>): ArachneConfig {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key))
      throw new Error('Invalid configuration property');
    const sourceVal = (source as unknown as Record<string, unknown>)[key];
    const targetVal = (target as unknown as Record<string, unknown>)[key];
    if (
      sourceVal &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        { ...(targetVal as ArachneConfig) },
        sourceVal as Partial<ArachneConfig>,
      );
    } else {
      result[key] = sourceVal;
    }
  }
  return result as unknown as ArachneConfig;
}

/**
 * Environment variable override mapping
 */
const ENV_OVERRIDES: Record<string, (c: ArachneConfig, v: string) => void> = {
  N2_DATA_DIR: (c, v) => {
    c.dataDir = v;
  },
  N2_CONTEXT_DB_PATH: (c, v) => {
    c.dbPath = v;
  },
  N2_PROJECT: (c, v) => {
    c.project = v;
  },
  N2_AGENT_NAME: (c, v) => {
    c.agent = v;
  },
  N2_CONTEXT_DATA_DIR: (c, v) => {
    c.dataDir = v;
  },
  N2_CONTEXT_PROJECT_DIR: (c, v) => {
    c.projectDir = v;
  },
  N2_CONTEXT_MAX_FILES: (c, v) => {
    c.indexing.maxFiles = Number(v);
  },
  N2_CONTEXT_BUDGET: (c, v) => {
    c.assembly.defaultBudget = Number(v);
  },
  N2_CONTEXT_AUTO_INDEX: (c, v) => {
    c.indexing.autoIndex = booleanEnvironment(v);
  },
  N2_CONTEXT_EMBEDDING_ENABLED: (c, v) => {
    c.embedding.enabled = booleanEnvironment(v);
  },
  N2_CONTEXT_EMBEDDING_ENDPOINT: (c, v) => {
    c.embedding.endpoint = v;
  },
  N2_CONTEXT_EMBEDDING_MODEL: (c, v) => {
    c.embedding.model = v;
  },
  N2_CONTEXT_EMBEDDING_KEY: (c, v) => {
    c.embedding.apiKey = v;
  },
  N2_CONTEXT_EMBEDDING_TIMEOUT: (c, v) => {
    c.embedding.timeoutMs = Number(v);
  },
  N2_CONTEXT_BACKUP_DIR: (c, v) => {
    c.backup.dir = v;
  },
  N2_CONTEXT_EXTERNAL_BACKUP: (c, v) => {
    c.backup.externalBackupDir = v;
  },
};

function applyEnvOverrides(config: ArachneConfig): ArachneConfig {
  for (const [envKey, applier] of Object.entries(ENV_OVERRIDES)) {
    const envVal = process.env[envKey];
    if (envVal) {
      applier(config, envVal);
    }
  }
  return config;
}

/**
 * Load config: default → local → env
 */
export function loadConfig(baseDir?: string): ArachneConfig {
  const root = baseDir || path.resolve(__dirname, '..', '..');

  // 1. Load default config
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const defaultConfig = structuredClone(
    require(path.join(root, 'config.default.js')),
  ) as ArachneConfig;

  // 2. Local override (if exists)
  const localPath = path.join(root, 'config.local.js');
  let merged: ArachneConfig = { ...defaultConfig };
  if (fs.existsSync(localPath)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const localConfig = require(localPath) as Partial<ArachneConfig>;
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
  merged.projectDir = fs.realpathSync(path.resolve(merged.projectDir));
  if (merged.dbPath) merged.dbPath = path.resolve(merged.dbPath);
  validateConfig(merged);
  return merged;
}
