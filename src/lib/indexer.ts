// Incremental indexing commits each complete file and reports partial scans explicitly.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chunkCode } from './chunker';
import { extractDependencies, resolveImport } from './dependency';
import { acquireIndex } from './index-lock';
import { discoverFiles, readSource, type ScanPlan } from './scan-files';
import type { Store } from './store';
import type {
  ArachneConfig,
  IndexingConfig,
  IndexOptions,
  IndexResult,
  FileMeta,
  FileRow,
} from '../types';
import { validateIndexing } from './config-validation';
import { DOCUMENT_FORMATS, documentFingerprint, extractDocument } from './document-worker';
import { buildHealthReport } from './graph-health';

export class Indexer {
  private running = false;
  private lastResult: IndexResult | null = null;
  private controller: AbortController | null = null;

  constructor(
    private readonly store: Store,
    private readonly config: ArachneConfig,
  ) {}
  get isIndexing(): boolean {
    return this.running;
  }
  get latestResult(): IndexResult | null {
    return this.lastResult;
  }
  get hasIncompleteScan(): boolean {
    return this.store.getMeta('last_scan_complete') === 'false';
  }

  cancel(): void {
    this.controller?.abort();
  }

  async index(projectDir: string, options: IndexOptions = {}): Promise<IndexResult> {
    validateIndexing(this.config);
    if (options.force !== undefined && typeof options.force !== 'boolean')
      throw new Error('Index force must be boolean');
    const root = fs.realpathSync(projectDir);
    if (root !== this.store.projectRoot || !fs.statSync(root).isDirectory())
      throw new Error('Index root differs from the configured source directory');
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    signal.throwIfAborted();
    const release = acquireIndex(this.store);
    this.controller = controller;
    this.running = true;
    try {
      this.store._setMeta('last_scan_complete', 'false');
      this.lastResult = await this.scan(root, options, signal);
      this.store._setMeta('last_scan_complete', String(this.lastResult.complete));
      return this.lastResult;
    } finally {
      this.running = false;
      this.controller = null;
      release();
    }
  }

  private async scan(
    root: string,
    options: IndexOptions,
    signal: AbortSignal,
  ): Promise<IndexResult> {
    const started = Date.now();
    const plan = await discoverFiles(root, this.config, options.subPath, signal);
    const result: IndexResult = {
      indexed: 0,
      skipped: 0,
      removed: 0,
      total: plan.files.length,
      elapsed: 0,
      complete: false,
      issues: plan.issues,
    };
    for (let index = 0; index < plan.files.length; index++) {
      signal.throwIfAborted();
      if (Date.now() - started > 120000 || result.issues.length >= 1000) {
        result.issues.push({
          path: root,
          message: 'Indexing resource limit reached',
        });
        break;
      }
      if (index % 100 === 0) await new Promise((resolve) => setImmediate(resolve));
      const file = plan.files[index]!;
      try {
        const status = await this.indexFile(file, Boolean(options.force), signal);
        if (status === 'indexed') result.indexed++;
        else result.skipped++;
      } catch (error) {
        result.issues.push({
          path: file.relativePath,
          message: (error as Error).message,
        });
      }
    }
    signal.throwIfAborted();
    if (!result.issues.length) {
      try {
        result.removed = this.publishSelection(plan);
      } catch (error) {
        result.issues.push({ path: root, message: (error as Error).message });
      }
    }
    result.complete = result.issues.length === 0;
    result.elapsed = Date.now() - started;
    return result;
  }

  private publishSelection(plan: ScanPlan): number {
    return this.store.db
      .transaction(() => {
        this.resolveDependencies();
        const selected = new Set(plan.files.map((file) => file.relativePath));
        let removed = 0;
        for (const file of this.store.getAllFiles()) {
          if (plan.within && file.path !== plan.within && !file.path.startsWith(plan.within + '/'))
            continue;
          if (!selected.has(file.path)) removed += this.store.removeFile(file.path).changes;
        }
        this.store._setMeta('last_indexed_at', new Date().toISOString());
        this.store._setMeta('file_count', String(this.store.getStats().fileCount));
        return removed;
      })
      .immediate();
  }

  private async indexFile(
    file: FileMeta,
    force: boolean,
    signal: AbortSignal,
  ): Promise<'indexed' | 'skipped'> {
    const language = path.extname(file.absolutePath).slice(1).toLowerCase();
    const fingerprint = DOCUMENT_FORMATS.has(language)
      ? indexHash(
          documentFingerprint(
            this.store.projectRoot,
            file.absolutePath,
            this.config.indexing.maxDocumentSize,
          ),
          language,
          this.config.indexing,
        )
      : null;
    if (
      !force &&
      this.config.indexing.incremental !== false &&
      fingerprint &&
      this.store.getFileByPath(file.relativePath)?.source_hash === fingerprint
    )
      return 'skipped';
    const content = DOCUMENT_FORMATS.has(language)
      ? await extractDocument(
          this.store.projectRoot,
          file.absolutePath,
          this.config.indexing.maxDocumentSize,
          signal,
        )
      : readSource(this.store.projectRoot, file.absolutePath, this.config.indexing.maxFileSize);
    signal.throwIfAborted();
    return this.publishFile(file, language, content, fingerprint, force);
  }

  private publishFile(
    file: FileMeta,
    language: string,
    content: string,
    fingerprint: string | null,
    force: boolean,
  ): 'indexed' | 'skipped' {
    const hash = indexHash(content, language, this.config.indexing);
    const chunks = chunkCode(content, language, this.config.indexing.tokenMultiplier);
    const dependencies = DOCUMENT_FORMATS.has(language)
      ? []
      : extractDependencies(content, language);
    return this.store.db
      .transaction(() => {
        const missingFingerprint =
          fingerprint !== null && this.store.getFileByPath(file.relativePath)?.source_hash == null;
        const result = this.store.upsertFile(
          file.relativePath,
          hash,
          language,
          file.stat.size,
          file.stat.mtime.toISOString(),
          force || this.config.indexing.incremental === false || missingFingerprint,
        );
        if (result.action === 'skipped') {
          this.saveFingerprint(file, result.fileId, fingerprint);
          return 'skipped' as const;
        }
        this.store.db
          .prepare('UPDATE arachne_files SET content=? WHERE id=?')
          .run(content, result.fileId);
        this.store.insertChunks(result.fileId, chunks);
        this.store.insertDependencies(
          result.fileId,
          dependencies.map((dependency) => ({
            targetPath: dependency.importPath,
            targetFileId: null,
            depType: dependency.depType,
          })),
        );
        this.saveFingerprint(file, result.fileId, fingerprint);
        return 'indexed' as const;
      })
      .immediate();
  }

  private saveFingerprint(file: FileMeta, fileId: number, fingerprint: string | null): void {
    if (fingerprint === null) return;
    this.store.db
      .prepare('UPDATE arachne_files SET source_hash=?,size_bytes=?,modified_at=? WHERE id=?')
      .run(fingerprint, file.stat.size, file.stat.mtime.toISOString(), fileId);
  }

  private resolveDependencies(): void {
    const files = this.store.getAllFiles();
    const ids = new Map(files.map((file) => [file.path, file.id]));
    const dependencies = this.store.db
      .prepare(
        `SELECT d.source_file_id,d.target_path,d.dep_type,f.path AS source_path
      FROM arachne_dependencies d JOIN arachne_files f ON f.id=d.source_file_id WHERE f.project=? AND f.agent=?`,
      )
      .all(this.store.project, this.store.agent) as Array<{
      source_file_id: number;
      target_path: string;
      source_path: string;
      dep_type: string;
    }>;
    const update = this.store.db.prepare(
      'UPDATE arachne_dependencies SET target_file_id=? WHERE source_file_id=? AND target_path=?',
    );
    for (const dependency of dependencies) {
      const resolved = resolveImport(
        dependency.source_path,
        dependency.target_path,
        ids,
        dependency.dep_type,
      );
      update.run(resolved?.fileId ?? null, dependency.source_file_id, dependency.target_path);
    }
  }

  getFiles(options: { language?: string } = {}): FileRow[] {
    return this.store.getAllFiles(options.language);
  }
  getStats() {
    return this.store.getStats();
  }
  getHealth() {
    return buildHealthReport(this.store);
  }
}

function indexHash(content: string | Buffer, language: string, config: IndexingConfig): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([2, language, config.tokenMultiplier, config.chunkStrategy]))
    .update('\0')
    .update(content)
    .digest('hex');
}
