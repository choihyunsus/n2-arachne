// Keep long functions and documents searchable with bounded overlapping source windows.
import type { ChunkRecord } from '../types';
export const MAX_CHUNK_CHARS = 8192;
const OVERLAP_CHARS = 256;

export function splitWindows(chunk: ChunkRecord, multiplier: number): ChunkRecord[] {
  if (chunk.content.length <= MAX_CHUNK_CHARS) return [chunk];
  const windows: ChunkRecord[] = [];
  let start = 0;
  let line = chunk.startLine;
  while (start < chunk.content.length) {
    const end = windowEnd(chunk.content, start);
    const content = chunk.content.slice(start, end);
    windows.push({
      ...chunk,
      content,
      startLine: line,
      endLine: line + newlines(content),
      tokenCount: Math.ceil(content.length / multiplier),
      searchText: [chunk.type, chunk.name ?? '', content].join(' ').toLowerCase(),
    });
    if (end === chunk.content.length) break;
    let next = Math.max(start + 1, end - OVERLAP_CHARS);
    if (/[\uDC00-\uDFFF]/.test(chunk.content[next]!)) next++;
    line += newlines(chunk.content.slice(start, next));
    start = next;
  }
  return windows;
}

function windowEnd(content: string, start: number): number {
  let end = Math.min(start + MAX_CHUNK_CHARS, content.length);
  if (end === content.length) return end;
  const paragraph = content.lastIndexOf('\n\n', end - 1);
  const newline = content.lastIndexOf('\n', end - 1);
  const minimum = start + MAX_CHUNK_CHARS / 2;
  if (paragraph > minimum) end = paragraph + 1;
  else if (newline > minimum) end = newline + 1;
  if (/[\uD800-\uDBFF]/.test(content[end - 1]!)) end--;
  return end;
}

function newlines(content: string): number {
  let count = 0;
  for (const character of content) if (character === '\n') count++;
  return count;
}
