// Importing the library has no server, network or database side effects.
export * from './types';
export { Store, type StoreOptions } from './lib/store';
export { Indexer } from './lib/indexer';
export { BM25Search } from './lib/search';
export { Assembler } from './lib/assembler';
export { Backup } from './lib/backup';
export { Embedding } from './lib/embedding';
export { VectorStore } from './lib/vector-store';
export { KVBridge } from './lib/kv-bridge';
export { chunkCode, estimateTokens } from './lib/chunker';
export { extractDependencies, resolveImport } from './lib/dependency';
export { loadConfig, deepMerge } from './lib/config';
export { extractDocument, documentWorkerPath } from './lib/document-worker';
export { buildHealthReport, type GraphHealthReport } from './lib/graph-health';

// Preserve `node <package-directory>` as a CLI entry point.
if (require.main === module) require('./index');
