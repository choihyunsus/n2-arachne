// Reject unsupported modes and invalid resource budgets before opening persistent storage.
import type { ArachneConfig } from '../types';
import { integer } from './store-values';
import { DOCUMENT_FORMATS, MAX_DOCUMENT_BYTES } from './document-worker';
const MAX_COLLECTION_ITEMS = 10000;

export function validateConfig(config: ArachneConfig): void {
  validateIndexing(config);
  integer(config.assembly.defaultBudget, 'default context budget', 1000000);
  integer(config.assembly.dependencyDepth, 'dependency depth', 20);
  const weights = ['fixed', 'shortTerm', 'associative', 'spare'].map(
    (name) => config.assembly.layers[name as keyof typeof config.assembly.layers],
  );
  if (
    weights.some((value) => !Number.isFinite(value) || value < 0) ||
    weights.reduce((sum, value) => sum + value, 0) > 1
  )
    throw new Error('Invalid context layer weights');
  integer(config.backup.maxBackups, 'backup retention count', MAX_COLLECTION_ITEMS);
  integer(config.backup.maxAgeDays, 'backup retention days', 36500);
  if (config.backup.maxBackups < 1 || config.backup.maxAgeDays < 1)
    throw new Error('Automatic backup retention must keep at least one backup for one day');
  integer(config.search.topK, 'search result limit', MAX_COLLECTION_ITEMS);
  integer(config.search.maxCacheBytes ?? 64 * 1048576, 'search cache bytes', 64 * 1048576);
  const { k1, b } = config.search.bm25;
  if (!Number.isFinite(k1) || k1 <= 0 || k1 > 10 || !Number.isFinite(b) || b < 0 || b > 1)
    throw new Error('Invalid BM25 score parameters');
  validateBooleans(config);
  if (config.kvCache) {
    integer(config.kvCache.maxSearchHistory, 'search history limit', 1000);
    integer(config.kvCache.maxHotFiles, 'hot file limit', MAX_COLLECTION_ITEMS);
  }
}

export function validateIndexing(config: ArachneConfig): void {
  integer(
    config.indexing.maxDocumentSize ?? MAX_DOCUMENT_BYTES,
    'document byte limit',
    MAX_DOCUMENT_BYTES,
  );
  const documents = config.indexing.documentFormats ?? [];
  if (
    !Array.isArray(documents) ||
    documents.some(
      (format) => typeof format !== 'string' || !DOCUMENT_FORMATS.has(format.toLowerCase()),
    )
  )
    throw new Error('Invalid document formats');
  integer(config.indexing.maxFiles, 'indexed file limit', 100000);
  integer(config.indexing.maxFileSize, 'source byte limit', 10485760);
  if (config.indexing.maxFiles < 1 || config.indexing.maxFileSize < 1)
    throw new Error('Indexing resource limits must be positive');
  const multiplier = config.indexing.tokenMultiplier;
  if (!Number.isFinite(multiplier) || multiplier < 0.25 || multiplier > 16)
    throw new Error('Token multiplier must be between 0.25 and 16');
  if (config.indexing.chunkStrategy !== 'regex')
    throw new Error('The supported chunkStrategy is regex. AST mode is unavailable.');
  for (const extensions of [config.indexing.supportedLanguages, config.indexing.alsoIndexAsText]) {
    if (
      !Array.isArray(extensions) ||
      extensions.length > 512 ||
      extensions.some((value) => typeof value !== 'string' || !/^[a-z0-9]{1,16}$/i.test(value))
    )
      throw new Error('Invalid indexing extensions');
  }
}

function validateBooleans(config: ArachneConfig): void {
  for (const value of [
    config.indexing.autoIndex,
    config.indexing.incremental,
    config.embedding.enabled,
    config.ignore.useGitignore,
    config.ignore.useContextignore,
    config.backup.enabled,
    config.backup.autoBackupOnReindex,
  ]) {
    if (typeof value !== 'boolean') throw new Error('Configuration flags must be booleans');
  }
  if (
    config.kvCache &&
    (typeof config.kvCache.enabled !== 'boolean' ||
      typeof config.kvCache.autoSaveOnExit !== 'boolean')
  )
    throw new Error('Session configuration flags must be booleans');
}

export function booleanEnvironment(value: string): boolean {
  if (value !== 'true' && value !== 'false')
    throw new Error('Boolean environment values must be true or false');
  return value === 'true';
}
