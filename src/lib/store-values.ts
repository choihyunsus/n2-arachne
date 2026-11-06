// Validate stored fields and caller paths before they influence scoped operations.
import path from 'node:path';
import type { ChunkRecord, ChunkRow, FileRow, DependencyRow, AccessLogRow } from '../types';

export function integer(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

export function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${name}`);
  return value;
}

export function optionalText(value: unknown, name: string): string | null {
  return value === null ? null : text(value, name);
}

export function relativePath(value: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    value.includes('\0') ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new Error('Expected a relative project path');
  }
  const normalized = value.replace(/\\/g, '/');
  if (normalized.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    throw new Error('Project path must use normalized components');
  }
  return normalized;
}

export function scopeName(value: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Buffer.byteLength(value) > 512 ||
    value.includes('\0')
  ) {
    throw new Error('Project and agent names must contain 1-512 bytes');
  }
  return value;
}

export function fileRow(value: unknown): FileRow {
  if (!value || typeof value !== 'object') throw new Error('Invalid stored file');
  const row = value as Record<string, unknown>;
  const sourceHash =
    row.source_hash === undefined ? null : optionalText(row.source_hash, 'source fingerprint');
  if (sourceHash !== null && !/^[a-f0-9]{64}$/i.test(sourceHash))
    throw new Error('Invalid source fingerprint');
  return {
    ...row,
    id: integer(row.id, 'file ID'),
    path: relativePath(text(row.path, 'file path')),
    hash: text(row.hash, 'file hash'),
    source_hash: sourceHash,
    language: optionalText(row.language, 'file language'),
    size_bytes: row.size_bytes === null ? 0 : integer(row.size_bytes, 'file size'),
    chunk_count: integer(row.chunk_count, 'chunk count'),
    indexed_at: text(row.indexed_at, 'index timestamp'),
    modified_at: optionalText(row.modified_at, 'file timestamp'),
  };
}

export function chunkRow(value: unknown): ChunkRow {
  if (!value || typeof value !== 'object') throw new Error('Invalid stored chunk');
  const row = value as Record<string, unknown>;
  const start = integer(row.start_line, 'chunk start line');
  const end = integer(row.end_line, 'chunk end line');
  if (end < start) throw new Error('Chunk end precedes its start');
  const result: ChunkRow = {
    id: integer(row.id, 'chunk ID'),
    file_id: integer(row.file_id, 'chunk file ID'),
    chunk_type: text(row.chunk_type, 'chunk type'),
    name: optionalText(row.name, 'chunk name'),
    start_line: start,
    end_line: end,
    content: text(row.content, 'chunk content'),
    token_count: integer(row.token_count, 'chunk token count'),
    search_text: optionalText(row.search_text, 'chunk search text'),
    created_at: text(row.created_at, 'chunk timestamp'),
  };
  if (row.file_path !== undefined)
    result.file_path = relativePath(text(row.file_path, 'chunk file path'));
  if (row.language !== undefined && row.language !== null)
    result.language = text(row.language, 'chunk language');
  return result;
}

export function validateChunk(value: ChunkRecord): void {
  text(value.type, 'chunk type');
  optionalText(value.name, 'chunk name');
  text(value.content, 'chunk content');
  text(value.searchText, 'chunk search text');
  integer(value.startLine, 'chunk start line');
  integer(value.endLine, 'chunk end line');
  integer(value.tokenCount, 'chunk token count');
  if (value.endLine < value.startLine) throw new Error('Chunk end precedes its start');
}

export function dependencyRow(value: unknown): DependencyRow {
  if (!value || typeof value !== 'object') throw new Error('Invalid stored dependency');
  const row = value as Record<string, unknown>;
  const result: DependencyRow = {
    source_file_id: integer(row.source_file_id, 'dependency source'),
    target_file_id:
      row.target_file_id === null ? null : integer(row.target_file_id, 'dependency target'),
    target_path: text(row.target_path, 'dependency import'),
    dep_type: text(row.dep_type, 'dependency type'),
  };
  if (row.target_resolved_path != null)
    result.target_resolved_path = relativePath(
      text(row.target_resolved_path, 'resolved dependency path'),
    );
  if (row.source_path != null)
    result.source_path = relativePath(text(row.source_path, 'dependency source path'));
  return result;
}

export function accessRow(value: unknown): AccessLogRow {
  if (!value || typeof value !== 'object') throw new Error('Invalid stored access record');
  const row = value as Record<string, unknown>;
  const result: AccessLogRow = {
    file_id: integer(row.file_id, 'access file'),
    path: relativePath(text(row.path, 'access path')),
  };
  if (row.last_access !== undefined) result.last_access = text(row.last_access, 'access timestamp');
  if (row.access_count !== undefined)
    result.access_count = integer(row.access_count, 'access count');
  return result;
}
