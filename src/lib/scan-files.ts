// Bounded source discovery and UTF-8 reads with explicit partial-scan diagnostics.
import fs from 'node:fs';
import path from 'node:path';
import { IgnoreFilter } from './ignore';
import type { ArachneConfig, FileMeta } from '../types';
import { integer } from './store-values';
import { DOCUMENT_FORMATS, MAX_DOCUMENT_BYTES } from './document-worker';

export interface ScanPlan {
  files: FileMeta[];
  issues: Array<{ path: string; message: string }>;
  within: string;
}

export async function discoverFiles(
  root: string,
  config: ArachneConfig,
  subPath?: string,
  signal?: AbortSignal,
): Promise<ScanPlan> {
  const { selected, within } = resolveTarget(root, subPath);
  const ignore = new IgnoreFilter(config.ignore, root);
  const supported = supportedExtensions(config);
  const plan: ScanPlan = { files: [], issues: [], within };
  const pending = [{ filename: selected, depth: 0 }];
  const deadline = Date.now() + 120000;
  let visited = 0;
  while (pending.length) {
    signal?.throwIfAborted();
    if (
      ++visited > 100000 ||
      plan.issues.length >= 1000 ||
      plan.files.length >= config.indexing.maxFiles ||
      Date.now() > deadline
    ) {
      addScanIssue(plan, selected, 'Directory scan resource limit reached');
      break;
    }
    if (visited % 200 === 0) await new Promise((resolve) => setImmediate(resolve));
    const entry = pending.pop()!;
    try {
      const stat = fs.lstatSync(entry.filename);
      if (stat.isSymbolicLink()) continue;
      const relative = path.relative(root, entry.filename).replace(/\\/g, '/');
      if (relative && ignore.isIgnored(relative + (stat.isDirectory() ? '/' : ''))) continue;
      if (stat.isDirectory()) {
        if (entry.depth >= 64) throw new Error('Directory depth limit reached');
        readDirectory(entry.filename, entry.depth, pending, 100000 - visited);
      } else {
        const file = selectSource(entry.filename, relative, stat, config, supported);
        if (file) plan.files.push(file);
      }
    } catch (error) {
      addScanIssue(plan, entry.filename, error);
    }
  }
  plan.files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
  return plan;
}

function addScanIssue(plan: ScanPlan, filename: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  plan.issues.push({ path: filename, message: message.slice(0, 4096) });
}

function selectSource(
  filename: string,
  relative: string,
  stat: fs.Stats,
  config: ArachneConfig,
  supported: Set<string>,
): FileMeta | null {
  const extension = path.extname(filename).slice(1).toLowerCase();
  if (!stat.isFile() || !supported.has(extension)) return null;
  const maximum = DOCUMENT_FORMATS.has(extension)
    ? (config.indexing.maxDocumentSize ?? MAX_DOCUMENT_BYTES)
    : config.indexing.maxFileSize;
  if (stat.size > maximum) throw new Error('Source exceeds the configured file size limit');
  return { absolutePath: filename, relativePath: relative, stat };
}

function supportedExtensions(config: ArachneConfig): Set<string> {
  return new Set(
    [
      ...config.indexing.supportedLanguages,
      ...config.indexing.alsoIndexAsText,
      ...(config.indexing.documentFormats ?? []),
    ].map((value) => value.toLowerCase()),
  );
}

function resolveTarget(root: string, subPath?: string): { selected: string; within: string } {
  const selected = path.resolve(root, subPath ?? '.');
  const within = path.relative(root, selected).replace(/\\/g, '/');
  if (within === '..' || within.startsWith('../') || path.isAbsolute(within))
    throw new Error('Index target is outside the configured source root');
  return { selected, within };
}

function readDirectory(
  filename: string,
  depth: number,
  pending: Array<{ filename: string; depth: number }>,
  maximum: number,
): void {
  const directory = fs.opendirSync(filename);
  try {
    let entry: fs.Dirent | null;
    while ((entry = directory.readSync()) !== null) {
      if (pending.length >= maximum) throw new Error('Directory entry limit reached');
      pending.push({
        filename: path.join(filename, entry.name),
        depth: depth + 1,
      });
    }
  } finally {
    directory.closeSync();
  }
}

export function readSource(root: string, filename: string, maximum: number): string {
  integer(maximum, 'source byte limit', 10485760);
  const resolved = fs.realpathSync(filename);
  const relative = path.relative(fs.realpathSync(root), resolved);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw new Error('Source resolves outside the configured root');
  const named = fs.lstatSync(resolved);
  if (!named.isFile()) throw new Error('Source must be a regular file');
  const descriptor = fs.openSync(resolved, 'r');
  try {
    const before = fs.fstatSync(descriptor);
    if (
      before.dev !== named.dev ||
      before.ino !== named.ino ||
      fs.realpathSync(resolved) !== resolved
    )
      throw new Error('Source path changed while opening');
    if (before.size > maximum) throw new Error('Source exceeds the configured file size limit');
    const parts: Buffer[] = [];
    let size = 0;
    while (size <= maximum) {
      const part = Buffer.alloc(Math.min(65536, maximum + 1 - size));
      const count = fs.readSync(descriptor, part, 0, part.length, null);
      if (!count) break;
      parts.push(part.subarray(0, count));
      size += count;
    }
    if (size > maximum) throw new Error('Source grew beyond the configured file size limit');
    const after = fs.fstatSync(descriptor);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      size !== after.size
    )
      throw new Error('Source changed while reading. Retry indexing after the write completes.');
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts, size));
  } finally {
    fs.closeSync(descriptor);
  }
}
