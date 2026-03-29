// Configuration loader (config.default.js → config.local.js override)
import path from 'path';
import fs from 'fs';
import type { ArachneConfig } from '../types';

/**
 * Deep merge — config.local.js overrides config.default.js
 * Arrays are replaced, objects are recursively merged.
 * Note: as-casts are structurally required for generic deep merge.
 */
export function deepMerge(target: ArachneConfig, source: Partial<ArachneConfig>): ArachneConfig {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
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
function applyEnvOverrides(config: ArachneConfig): ArachneConfig {
  const envMap: Record<string, (c: ArachneConfig, v: string) => void> = {
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
  const defaultConfig = require(path.join(root, 'config.default.js')) as ArachneConfig;

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

  return merged;
}
