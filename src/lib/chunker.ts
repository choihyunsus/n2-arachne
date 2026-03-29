// Split source code into function/class-level chunks
// Phase 1: Regex-based (no parser needed), Phase 2: AST replacement possible
import type { ChunkRecord, ChunkPattern, SupportedLanguage } from '../types';

// Default: ~3.5 chars/token for English code
let _tokenMultiplier = 3.5;

// Chunk analysis constants
const MAX_SEARCH_IDENTIFIERS = 50;
const MIN_CHUNK_CHAR_LENGTH = 50;
const MIN_CHUNK_TOKEN_COUNT = 30;

/**
 * Set token multiplier (called from config)
 */
export function setTokenMultiplier(multiplier: number): void {
  if (typeof multiplier === 'number' && multiplier > 0) {
    _tokenMultiplier = multiplier;
  }
}

/**
 * Estimate token count (configurable via tokenMultiplier)
 */
export function estimateTokens(text: string, _language?: string): number {
  return Math.ceil(text.length / _tokenMultiplier);
}

// Language-specific chunk detection patterns
const CHUNK_PATTERNS: Record<SupportedLanguage, ChunkPattern[]> = {
  js: [
    { type: 'function', regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/m },
    { type: 'class', regex: /^(?:export\s+)?class\s+(\w+)/m },
    { type: 'arrow', regex: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(?/m },
    { type: 'method', regex: /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/m },
  ],
  ts: [
    { type: 'function', regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/m },
    { type: 'class', regex: /^(?:export\s+)?class\s+(\w+)/m },
    { type: 'interface', regex: /^(?:export\s+)?interface\s+(\w+)/m },
    { type: 'type', regex: /^(?:export\s+)?type\s+(\w+)/m },
    { type: 'arrow', regex: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[=:]/m },
    { type: 'method', regex: /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*[:{]/m },
  ],
  py: [
    { type: 'function', regex: /^(?:async\s+)?def\s+(\w+)/m },
    { type: 'class', regex: /^class\s+(\w+)/m },
  ],
  rs: [
    { type: 'function', regex: /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/m },
    { type: 'struct', regex: /^(?:pub\s+)?struct\s+(\w+)/m },
    { type: 'enum', regex: /^(?:pub\s+)?enum\s+(\w+)/m },
    { type: 'impl', regex: /^impl(?:<[^>]+>)?\s+(\w+)/m },
    { type: 'trait', regex: /^(?:pub\s+)?trait\s+(\w+)/m },
  ],
  go: [
    { type: 'function', regex: /^func\s+(?:\([^)]+\)\s+)?(\w+)/m },
    { type: 'struct', regex: /^type\s+(\w+)\s+struct/m },
    { type: 'interface', regex: /^type\s+(\w+)\s+interface/m },
  ],
  java: [
    { type: 'class', regex: /^(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+)?class\s+(\w+)/m },
    { type: 'interface', regex: /^(?:public\s+|private\s+|protected\s+)?interface\s+(\w+)/m },
    { type: 'enum', regex: /^(?:public\s+|private\s+|protected\s+)?enum\s+(\w+)/m },
    { type: 'method', regex: /^\s+(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:synchronized\s+)?(?:final\s+)?(?:abstract\s+)?(?:\w+(?:<[^>]+>)?\s+)(\w+)\s*\(/m },
    { type: 'annotation', regex: /^(?:public\s+)?@interface\s+(\w+)/m },
  ],
};

// Extension → language key mapping
export const LANG_MAP: Record<string, SupportedLanguage> = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  ts: 'ts', tsx: 'ts', mts: 'ts',
  py: 'py',
  rs: 'rs',
  go: 'go',
  java: 'java',
};

/**
 * Find block end using brace matching (JS/TS/Rust/Go/Java)
 */
function findBlockEnd(lines: string[], startIdx: number): number {
  let depth = 0;
  let found = false;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]!;
    for (const ch of line) {
      if (ch === '{') { depth++; found = true; }
      if (ch === '}') { depth--; }
    }
    if (found && depth <= 0) {
      return i;
    }
  }
  return lines.length - 1;
}

/**
 * Find block end using indentation (Python)
 */
function findIndentEnd(lines: string[], startIdx: number): number {
  if (startIdx >= lines.length - 1) return startIdx;

  const startLine = lines[startIdx]!;
  const baseIndent = (startLine.match(/^(\s*)/) ?? ['', ''])[1]!.length;

  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const indent = (line.match(/^(\s*)/) ?? ['', ''])[1]!.length;
    if (indent <= baseIndent) {
      return i - 1;
    }
  }
  return lines.length - 1;
}

/**
 * Build search text for BM25
 */
function buildSearchText(name: string | null, content: string, type: string): string {
  const parts: string[] = [type];
  if (name) parts.push(name);
  // Extract identifiers from code (alphanumeric + _)
  const identifiers = content.match(/[a-zA-Z_]\w{2,}/g) ?? [];
  const unique = [...new Set(identifiers)];
  parts.push(...unique.slice(0, MAX_SEARCH_IDENTIFIERS));
  return parts.join(' ').toLowerCase();
}

/**
 * Create whole-file chunk (for unsupported languages or match failure)
 */
function makeWholeFileChunk(content: string): ChunkRecord {
  return {
    type: 'module',
    name: null,
    startLine: 1,
    endLine: content.split('\n').length,
    content,
    tokenCount: estimateTokens(content),
    searchText: buildSearchText(null, content, 'module'),
  };
}

/**
 * Match methods inside a container and return sub-chunks
 */
function matchMethods(
  lines: string[], start: number, end: number,
  methodPatterns: ChunkPattern[], lang: string,
): { chunks: ChunkRecord[]; usedLines: Set<number> } {
  const subChunks: ChunkRecord[] = [];
  const subUsed = new Set<number>();

  for (let i = start + 1; i <= end; i++) {
    if (subUsed.has(i)) continue;
    const line = lines[i]!;

    for (const pattern of methodPatterns) {
      const match = line.match(pattern.regex);
      if (!match) continue;

      const name = match[1] ?? null;
      let endIdx = lang === 'py' ? findIndentEnd(lines, i) : findBlockEnd(lines, i);
      endIdx = Math.min(endIdx, end);
      if (endIdx - i < 2) continue;

      for (let j = i; j <= endIdx; j++) subUsed.add(j);
      const chunkContent = lines.slice(i, endIdx + 1).join('\n');
      subChunks.push({
        type: pattern.type, name,
        startLine: i + 1, endLine: endIdx + 1,
        content: chunkContent,
        tokenCount: estimateTokens(chunkContent),
        searchText: buildSearchText(name, chunkContent, pattern.type),
      });
      break;
    }
  }
  return { chunks: subChunks, usedLines: subUsed };
}

/**
 * Build remainder chunk from unused lines in a container
 */
function buildRemainderChunk(
  lines: string[], start: number, end: number, usedLines: Set<number>,
): ChunkRecord | null {
  const remainderLines: string[] = [];
  for (let i = start; i <= end; i++) {
    if (!usedLines.has(i)) remainderLines.push(lines[i]!);
  }
  const content = remainderLines.join('\n').trim();
  if (content.length <= MIN_CHUNK_CHAR_LENGTH || estimateTokens(content) <= MIN_CHUNK_TOKEN_COUNT) return null;

  return {
    type: 'module', name: null,
    startLine: start + 1, endLine: end + 1,
    content, tokenCount: estimateTokens(content),
    searchText: buildSearchText(null, content, 'module'),
  };
}

/**
 * Extract method-level sub-chunks from a container (class/struct/impl)
 * For large containers (>500 tokens), splits into individual methods + remainder
 */
function extractSubChunks(
  lines: string[], containerStart: number, containerEnd: number,
  methodPatterns: ChunkPattern[], lang: string,
): ChunkRecord[] {
  const { chunks, usedLines } = matchMethods(lines, containerStart, containerEnd, methodPatterns, lang);
  if (chunks.length === 0) return [];

  const remainder = buildRemainderChunk(lines, containerStart, containerEnd, usedLines);
  if (remainder) chunks.push(remainder);

  return chunks;
}

/**
 * Match chunk patterns against source lines
 */
function matchChunks(
  lines: string[], patterns: ChunkPattern[], lang: string,
): { chunks: ChunkRecord[]; usedLines: Set<number> } {
  const chunks: ChunkRecord[] = [];
  const usedLines = new Set<number>();
  const containerTypes = new Set(['class', 'struct', 'impl']);

  for (let i = 0; i < lines.length; i++) {
    if (usedLines.has(i)) continue;
    const line = lines[i]!;

    for (const pattern of patterns) {
      const match = line.match(pattern.regex);
      if (!match) continue;

      const name = match[1] ?? null;
      const endIdx = lang === 'py' ? findIndentEnd(lines, i) : findBlockEnd(lines, i);
      if (endIdx - i < 2) continue;

      for (let j = i; j <= endIdx; j++) usedLines.add(j);
      const chunkContent = lines.slice(i, endIdx + 1).join('\n');
      const tokenCount = estimateTokens(chunkContent);

      // Sub-chunk large containers
      if (containerTypes.has(pattern.type) && tokenCount > 500) {
        const methodPatterns = patterns.filter(p => p.type === 'method' || p.type === 'function');
        if (methodPatterns.length > 0) {
          const subChunks = extractSubChunks(lines, i, endIdx, methodPatterns, lang);
          if (subChunks.length > 0) { chunks.push(...subChunks); break; }
        }
      }

      chunks.push({
        type: pattern.type, name,
        startLine: i + 1, endLine: endIdx + 1,
        content: chunkContent, tokenCount,
        searchText: buildSearchText(name, chunkContent, pattern.type),
      });
      break;
    }
  }
  return { chunks, usedLines };
}

/**
 * Collect uncovered lines as remainder "module" chunks
 */
function collectRemainder(lines: string[], usedLines: Set<number>): ChunkRecord[] {
  const uncovered: Array<{ start: number; end: number }> = [];
  let rangeStart: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    if (!usedLines.has(i)) {
      if (rangeStart === null) rangeStart = i;
    } else if (rangeStart !== null) {
      uncovered.push({ start: rangeStart, end: i - 1 });
      rangeStart = null;
    }
  }
  if (rangeStart !== null) uncovered.push({ start: rangeStart, end: lines.length - 1 });

  const chunks: ChunkRecord[] = [];
  for (const range of uncovered) {
    const content = lines.slice(range.start, range.end + 1).join('\n').trim();
    if (content.length > MIN_CHUNK_CHAR_LENGTH && estimateTokens(content) > MIN_CHUNK_TOKEN_COUNT) {
      chunks.push({
        type: 'module', name: null,
        startLine: range.start + 1, endLine: range.end + 1,
        content, tokenCount: estimateTokens(content),
        searchText: buildSearchText(null, content, 'module'),
      });
    }
  }
  return chunks;
}

/**
 * Split source code into chunks
 */
export function chunkCode(content: string, language: string): ChunkRecord[] {
  const lang = LANG_MAP[language] ?? language;
  const patterns = CHUNK_PATTERNS[lang as SupportedLanguage];
  if (!patterns) return [makeWholeFileChunk(content)];

  const lines = content.split('\n');
  const { chunks, usedLines } = matchChunks(lines, patterns, lang);
  const remainder = collectRemainder(lines, usedLines);
  const all = [...chunks, ...remainder].sort((a, b) => a.startLine - b.startLine);

  return all.length > 0 ? all : [makeWholeFileChunk(content)];
}

/**
 * Detect language from file extension
 */
export function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return ext;
}

export { CHUNK_PATTERNS };
