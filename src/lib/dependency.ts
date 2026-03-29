// Dependency graph extraction/resolution module
// Parses import/require via regex → resolves paths → stores in DB
import path from 'path';
import type { Store } from './store';
import type { ExtractedDep, ResolvedImport, ResolvedDep } from '../types';

// ── Language-specific dependency patterns ──

const JS_PATTERNS: RegExp[] = [
  // ES6: import X from './path'  |  import { X } from './path'
  /import\s+(?:[\w{}\s,*]+\s+from\s+)?['"]([^'"]+)['"]/g,
  // CommonJS: require('./path')
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // Dynamic: import('./path')
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const PY_PATTERNS: RegExp[] = [
  /from\s+([\w.]+)\s+import/g,
  /^import\s+([\w.]+)/gm,
];

const RUST_PATTERNS: RegExp[] = [
  /use\s+(crate::[\w:]+)/g,
  /mod\s+(\w+)\s*;/g,
];

const GO_PATTERNS: RegExp[] = [
  /import\s+(?:\(\s*)?["']([^"']+)["']/g,
];

const JAVA_PATTERNS: RegExp[] = [
  /import\s+(?:static\s+)?([\w.]+\.[A-Z]\w*)/gm,
  /import\s+(?:static\s+)?([\w.]+)\.\*/gm,
];

/**
 * Extract dependencies from file content
 */
export function extractDependencies(content: string, language: string): ExtractedDep[] {
  const patterns = getPatternsForLanguage(language);
  if (!patterns) return [];

  const deps: ExtractedDep[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    // RegExp is stateful, reset lastIndex
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const importPath = match[1];
      if (!importPath || seen.has(importPath)) continue;
      seen.add(importPath);

      const depType = classifyDepType(importPath, language);
      deps.push({ importPath, depType });
    }
  }

  return deps;
}

/**
 * Resolve import path to actual file path
 */
export function resolveImport(
  fromFile: string,
  importPath: string,
  indexedFiles: Map<string, number>,
): ResolvedImport | null {
  // External package (not a relative path) → skip
  if (!isRelativePath(importPath)) return null;

  const fromDir = path.dirname(fromFile);
  const basePath = path.join(fromDir, importPath).replace(/\\/g, '/');

  // 1. Check exact file match
  const exactId = indexedFiles.get(basePath);
  if (exactId !== undefined) {
    return { resolvedPath: basePath, fileId: exactId };
  }

  // 2. Try adding extensions
  const extensions = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.java'];
  for (const ext of extensions) {
    const withExt = basePath + ext;
    const extId = indexedFiles.get(withExt);
    if (extId !== undefined) {
      return { resolvedPath: withExt, fileId: extId };
    }
  }

  // 3. Try directory index files
  const indexFiles = ['index.js', 'index.ts', 'index.jsx', 'index.tsx', 'index.mjs'];
  for (const idx of indexFiles) {
    const indexPath = basePath + '/' + idx;
    const idxId = indexedFiles.get(indexPath);
    if (idxId !== undefined) {
      return { resolvedPath: indexPath, fileId: idxId };
    }
  }

  return null;
}

/**
 * Used by indexer: extract dependencies during file indexing → save to DB
 */
export function indexFileDependencies(
  store: Store,
  fileId: number,
  content: string,
  language: string,
  relativePath: string,
): void {
  if (!getPatternsForLanguage(language)) return;

  store.clearDependencies(fileId);

  const deps = extractDependencies(content, language);
  if (deps.length === 0) return;

  // Build indexed file map (path → fileId)
  const allFiles = store.getAllFiles();
  const fileMap = new Map<string, number>();
  for (const f of allFiles) {
    fileMap.set(f.path, f.id);
  }

  // Resolve paths → save to DB
  const resolved: ResolvedDep[] = [];
  for (const dep of deps) {
    const result = resolveImport(relativePath, dep.importPath, fileMap);
    resolved.push({
      targetPath: dep.importPath,
      targetFileId: result ? result.fileId : null,
      depType: dep.depType,
    });
  }

  if (resolved.length > 0) {
    store.insertDependencies(fileId, resolved);
  }
}

// ── Utilities ──

function getPatternsForLanguage(language: string): RegExp[] | null {
  switch (language) {
    case 'js': case 'jsx': case 'mjs': case 'cjs':
    case 'ts': case 'tsx':
      return JS_PATTERNS;
    case 'py':
      return PY_PATTERNS;
    case 'rs':
      return RUST_PATTERNS;
    case 'go':
      return GO_PATTERNS;
    case 'java':
      return JAVA_PATTERNS;
    default:
      return null;
  }
}

function isRelativePath(importPath: string): boolean {
  return importPath.startsWith('./') || importPath.startsWith('../');
}

function classifyDepType(importPath: string, language: string): string {
  if (language === 'py') return 'import';
  if (language === 'rs') return importPath.startsWith('crate::') ? 'use' : 'mod';
  if (language === 'go') return 'import';
  if (language === 'java') return 'import';

  // JS/TS — external package vs relative path
  if (isRelativePath(importPath)) return 'import';
  return 'external';
}
