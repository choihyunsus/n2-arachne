// Parse binary documents in an OS-limited Rust process with bounded transport and cleanup.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { integer } from './store-values';
import { hashFile } from './file-hash';

export const DOCUMENT_FORMATS = new Set(['pdf', 'docx', 'xlsx', 'pptx']);
export const MAX_DOCUMENT_BYTES = 32 * 1048576;
const MAX_TEXT_BYTES = 8 * 1048576;
const MAX_OUTPUT_BYTES = 16 * 1048576;
let activeWorkers = 0;
let workerFingerprint: {
  filename: string;
  size: number;
  modified: number;
  changed: number;
  sha256: string;
} | null = null;

export function documentWorkerPath(): string {
  const configured = process.env.N2_ARACHNE_DOCUMENT_WORKER;
  if (configured) return path.resolve(configured);
  const suffix = process.platform === 'win32' ? '.exe' : '';
  return path.resolve(
    __dirname,
    '../../bin',
    `n2-arachne-doc-${process.platform}-${process.arch}${suffix}`,
  );
}

export async function extractDocument(
  root: string,
  filename: string,
  maximum = MAX_DOCUMENT_BYTES,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const { resolved, stat: before } = checkedDocument(root, filename, maximum);
  const worker = documentWorkerPath();
  if (!fs.existsSync(worker))
    throw new Error(
      'Document parser is unavailable. Run npm run build:documents or configure N2_ARACHNE_DOCUMENT_WORKER.',
    );
  if (activeWorkers >= 2)
    throw new Error('Two document parsers are already running. Retry this file after they finish.');
  activeWorkers++;
  try {
    const text = await runWorker(worker, root, resolved, signal);
    const after = fs.statSync(resolved);
    if (
      fs.realpathSync(filename) !== resolved ||
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error(
        'Document changed while being parsed. Retry indexing after the write completes.',
      );
    return text;
  } finally {
    activeWorkers--;
  }
}

export function documentFingerprint(
  root: string,
  filename: string,
  maximum = MAX_DOCUMENT_BYTES,
): string {
  const { resolved } = checkedDocument(root, filename, maximum);
  return createHash('sha256')
    .update(hashFile(resolved, maximum).sha256)
    .update('\0')
    .update(parserFingerprint())
    .digest('hex');
}

function parserFingerprint(): string {
  const filename = documentWorkerPath();
  if (!fs.existsSync(filename))
    throw new Error('Document parser is unavailable. Run npm run build:documents.');
  const stat = fs.statSync(filename);
  if (
    workerFingerprint?.filename === filename &&
    workerFingerprint.size === stat.size &&
    workerFingerprint.modified === stat.mtimeMs &&
    workerFingerprint.changed === stat.ctimeMs
  )
    return workerFingerprint.sha256;
  const result = hashFile(filename, 128 * 1048576);
  workerFingerprint = {
    filename,
    size: stat.size,
    modified: stat.mtimeMs,
    changed: stat.ctimeMs,
    sha256: result.sha256,
  };
  return result.sha256;
}

function checkedDocument(
  root: string,
  filename: string,
  maximum: number,
): { resolved: string; stat: fs.Stats } {
  integer(maximum, 'document byte limit', MAX_DOCUMENT_BYTES);
  const resolved = fs.realpathSync(filename);
  const within = path.relative(root, resolved);
  if (within === '..' || within.startsWith('..' + path.sep) || path.isAbsolute(within))
    throw new Error('Document resolves outside its source root');
  if (!DOCUMENT_FORMATS.has(path.extname(resolved).slice(1).toLowerCase()))
    throw new Error('Unsupported document format');
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size > maximum)
    throw new Error('Document exceeds the configured input limit or is not a regular file');
  return { resolved, stat };
}

function workerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

async function runWorker(
  executable: string,
  root: string,
  filename: string,
  signal?: AbortSignal,
): Promise<string> {
  const child = spawnWorker(executable, root, filename);
  const output: Buffer[] = [];
  let bytes = 0,
    stderr = '',
    failure: Error | null = null;
  const terminate = () => {
    child.kill();
  };
  const abort = () => {
    failure = new Error('Document extraction was cancelled');
    terminate();
  };
  const timeout = setTimeout(() => {
    failure = new Error('Document parsing exceeded its time limit');
    terminate();
  }, 22000);
  process.once('exit', terminate);
  signal?.addEventListener('abort', abort, { once: true });
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_OUTPUT_BYTES) {
      failure = new Error('Document parser output exceeded its limit');
      terminate();
    } else output.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4096);
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (failure) throw failure;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(output, bytes));
    return decodeOutput(code, text, stderr);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    process.removeListener('exit', terminate);
    terminate();
  }
}

function spawnWorker(executable: string, root: string, filename: string) {
  return spawn(executable, [root, filename], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: workerEnvironment(),
  });
}

function decodeOutput(code: number | null, output: string, stderr: string): string {
  if (code === 124) throw new Error('Document parsing exceeded its 20 second limit');
  if (!output.trim())
    throw new Error(`Document parser stopped (exit ${code}, 256 MiB memory limit). ${stderr}`);
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error('Document parser returned invalid JSON');
  }
  if (code !== 0) {
    const detail =
      value && typeof value === 'object' ? (value as { error?: unknown }).error : undefined;
    throw new Error(typeof detail === 'string' ? detail.slice(0, 4096) : 'Document parsing failed');
  }
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_TEXT_BYTES)
    throw new Error('Invalid or oversized extracted document text');
  return value;
}
