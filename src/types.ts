// Shared type definitions for Arachne v4.0

// ── Config Types ──

export interface ArachneConfig {
  dataDir: string;
  projectDir?: string;
  indexing: IndexingConfig;
  assembly: AssemblyConfig;
  search: SearchConfig;
  embedding: EmbeddingConfig;
  ignore: IgnoreConfig;
  backup: BackupConfig;
  integrations: IntegrationsConfig;
  kvCache?: KVBridgeConfig;
}

export interface IndexingConfig {
  autoIndex: boolean;
  incremental: boolean;
  maxFileSize: number;
  maxFiles: number;
  chunkStrategy: 'regex' | 'ast';
  tokenMultiplier: number;
  supportedLanguages: string[];
  alsoIndexAsText: string[];
}

export interface AssemblyConfig {
  defaultBudget: number;
  layers: LayerWeights;
  dependencyDepth: number;
}

export interface LayerWeights {
  fixed: number;
  shortTerm: number;
  associative: number;
  spare: number;
}

export interface SearchConfig {
  bm25: { k1: number; b: number };
  topK: number;
}

export interface EmbeddingConfig {
  enabled: boolean;
  provider: string;
  model: string;
  endpoint: string;
}

export interface IgnoreConfig {
  useGitignore: boolean;
  useContextignore: boolean;
  patterns: string[];
}

export interface BackupConfig {
  enabled: boolean;
  dir: string;
  maxBackups: number;
  maxAgeDays: number;
  autoBackupOnReindex: boolean;
  externalBackupDir: string | null;
}

export interface IntegrationsConfig {
  soul: { enabled: boolean; dataDir: string | null };
  qln: { enabled: boolean };
  ark: { enabled: boolean; rulesDir: string | null };
}

// ── Data Types ──

export interface ChunkRecord {
  type: string;
  name: string | null;
  startLine: number;
  endLine: number;
  content: string;
  tokenCount: number;
  searchText: string;
}

export interface ChunkRow {
  id: number;
  file_id: number;
  chunk_type: string;
  name: string | null;
  start_line: number;
  end_line: number;
  content: string;
  token_count: number;
  search_text: string | null;
  created_at: string;
  file_path?: string;
  language?: string;
}

export interface FileRow {
  id: number;
  path: string;
  hash: string;
  language: string | null;
  size_bytes: number;
  chunk_count: number;
  indexed_at: string;
  modified_at: string | null;
}

export interface UpsertResult {
  action: 'inserted' | 'updated' | 'skipped';
  fileId: number;
}

export interface DependencyRow {
  source_file_id: number;
  target_path: string;
  target_file_id: number | null;
  dep_type: string;
  target_resolved_path?: string;
  source_path?: string;
  depth?: number;
}

export interface AccessLogRow {
  file_id: number;
  path: string;
  last_access?: string;
  access_count?: number;
}

export interface StoreStats {
  fileCount: number;
  chunkCount: number;
  totalTokens: number;
  languages: Array<{ language: string | null; cnt: number }>;
  dbSizeBytes: number;
  dbSizeMB: string;
  lastIndexed: string | null;
  schemaVersion: string | null;
}

// ── Search Types ──

export interface SearchResult {
  chunk: ChunkRow;
  score: number;
}

export interface HybridSearchResult extends SearchResult {
  bm25Score: number;
  semanticScore: number;
}

export interface SearchOptions {
  topK?: number;
  language?: string;
}

export interface HybridSearchOptions extends SearchOptions {
  alpha?: number;
}

// ── Assembler Types ──

export interface LayerResult {
  text: string;
  tokens: number;
  items: LayerItem[];
}

export interface LayerItem {
  type: string;
  path?: string;
  chunk?: string;
  tokens?: number;
  score?: number;
  accessCount?: number;
}

export interface AssembleOptions {
  activeFile?: string;
  budget?: number;
  layers?: string[];
  projectDir?: string;
}

export interface AssembleResult {
  context: string;
  metadata: AssembleMetadata;
}

export interface AssembleMetadata {
  query: string;
  budget: number;
  tokensUsed: number;
  tokensRemaining: number;
  layers: Record<string, { tokens: number; itemCount: number }>;
}

// ── Indexer Types ──

export interface IndexOptions {
  force?: boolean;
  subPath?: string;
}

export interface IndexResult {
  indexed: number;
  skipped: number;
  removed: number;
  elapsed: number;
  total: number;
}

export interface FileMeta {
  absolutePath: string;
  relativePath: string;
  stat: import('fs').Stats;
}

// ── Backup Types ──

export interface BackupEntry {
  id: string;
  filename: string;
  label: string | null;
  trigger: string;
  created_at: string;
  file_count: number;
  chunk_count: number;
  size_bytes: number;
}

export interface BackupMeta {
  backups: BackupEntry[];
}

export interface BackupCreateResult {
  id: string;
  filename: string;
  size: number;
  files: number;
  chunks: number;
}

export interface BackupRestoreResult {
  restored: string;
  label: string | null;
  files: number;
}

export interface BackupListItem {
  id: string;
  label: string | null;
  trigger: string;
  created_at: string;
  files: number;
  chunks: number;
  sizeMB: string;
}

// ── Dependency Types ──

export interface ExtractedDep {
  importPath: string;
  depType: string;
}

export interface ResolvedImport {
  resolvedPath: string;
  fileId: number;
}

export interface ResolvedDep {
  targetPath: string;
  targetFileId: number | null;
  depType: string;
}

// ── Vector Types ──

export interface VectorSearchResult {
  chunkId: number;
  distance: number;
}

export interface EmbedResult {
  embedded: number;
  skipped: number;
  errors: number;
}

// ── Chunker Types ──

export interface ChunkPattern {
  type: string;
  regex: RegExp;
}

export type SupportedLanguage = 'js' | 'ts' | 'py' | 'rs' | 'go' | 'java';

// ── Embedding Types ──

export interface OllamaEmbeddingResponse {
  embedding?: number[];
  embeddings?: number[][];
}

// ── KV-Cache Types (Phase 2) ──

export interface SearchHistoryEntry {
  query: string;
  timestamp: string;
  resultCount: number;
}

export interface ArachneKVData {
  version: string;
  lastSavedAt: string;
  projectDir: string;
  fileCount: number;
  chunkCount: number;
  totalTokens: number;
  hotFiles: string[];
  searchHistory: SearchHistoryEntry[];
}

export interface KVBridgeConfig {
  enabled: boolean;
  maxSearchHistory: number;
  maxHotFiles: number;
  autoSaveOnExit: boolean;
}
