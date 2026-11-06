// Validate persisted session fields before merging concurrent history updates.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ArachneKVData, SearchHistoryEntry } from '../types';
import type { Store } from './store';
import { integer, relativePath, text } from './store-values';

export const MAX_SESSION_BYTES = 8 * 1024 * 1024;

export function readSession(raw: string, store: Store, legacy = false): ArachneKVData {
  if (Buffer.byteLength(raw) > MAX_SESSION_BYTES) throw new Error('Session data exceeds 8 MiB');
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object') throw new Error('Invalid session data');
  const row = value as Record<string, unknown>;
  const expectedVersion = legacy ? '4.0.0' : '5.0.0';
  if (row.version !== expectedVersion) throw new Error('Unsupported session data version');
  const sourceRoot = legacy ? legacyRoot(row.projectDir) : row.projectDir;
  if (sourceRoot !== store.projectRoot) throw new Error('Session source root differs');
  if (!legacy && (row.project !== store.project || row.agent !== store.agent))
    throw new Error('Session owner differs');
  if (
    !Array.isArray(row.searchHistory) ||
    row.searchHistory.length > 1000 ||
    !Array.isArray(row.hotFiles) ||
    row.hotFiles.length > 10000
  )
    throw new Error('Invalid session collection size');
  return {
    version: expectedVersion,
    lastSavedAt: timestamp(row.lastSavedAt),
    projectDir: store.projectRoot,
    project: store.project,
    agent: store.agent,
    fileCount: integer(row.fileCount, 'session file count'),
    chunkCount: integer(row.chunkCount, 'session chunk count'),
    totalTokens: integer(row.totalTokens, 'session token count'),
    hotFiles: row.hotFiles.map((value) => relativePath(text(value, 'session file path'))),
    searchHistory: row.searchHistory.map(historyEntry),
  };
}

function legacyRoot(value: unknown): string {
  try {
    return fs.realpathSync(path.resolve(text(value, 'legacy source root')));
  } catch {
    throw new Error('Session source root differs or is unavailable');
  }
}

export function historyEntry(value: unknown): SearchHistoryEntry {
  if (!value || typeof value !== 'object') throw new Error('Invalid search history entry');
  const row = value as Record<string, unknown>;
  const query = text(row.query, 'history query').trim();
  if (!query || query.length > 4096) throw new Error('Invalid history query length');
  const entry = {
    query,
    timestamp: timestamp(row.timestamp),
    resultCount: integer(row.resultCount, 'history result count'),
  };
  const id =
    row.id === undefined
      ? createHash('sha256').update(JSON.stringify(entry)).digest('hex')
      : text(row.id, 'history ID');
  if (!id || id.length > 128) throw new Error('Invalid history ID');
  return { id, ...entry };
}

function timestamp(value: unknown): string {
  const result = text(value, 'session timestamp');
  if (!Number.isFinite(Date.parse(result))) throw new Error('Invalid session timestamp');
  return result;
}

export function mergeHistory(
  persisted: SearchHistoryEntry[],
  pending: SearchHistoryEntry[],
  limit: number,
): SearchHistoryEntry[] {
  if (limit === 0) return [];
  const entries = new Map<string, SearchHistoryEntry>();
  for (const entry of [...persisted, ...pending]) entries.set(entry.id!, entry);
  return [...entries.values()]
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id!.localeCompare(b.id!))
    .slice(-limit);
}
