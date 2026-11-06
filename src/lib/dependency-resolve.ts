// Resolve file candidates inside the indexed project, retaining unresolved package imports.
import path from 'node:path';
import type { ResolvedImport } from '../types';
import { integer, relativePath, text } from './store-values';
import { dependencyLanguage } from './dependency-extract';

const JS_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.mts', '.cts'];

export function resolveImport(
  fromFile: string,
  importPath: string,
  indexed: Map<string, number>,
  depType?: string,
): ResolvedImport | null {
  relativePath(fromFile);
  text(importPath, 'dependency import');
  if (importPath.length > 4096 || importPath.includes('\0'))
    throw new Error('Invalid dependency import');
  if (path.posix.isAbsolute(importPath) || path.win32.isAbsolute(importPath)) return null;
  const language = dependencyLanguage(path.posix.extname(fromFile).slice(1));
  let candidates: string[] = [];
  if (language === 'rs') candidates = rustCandidates(fromFile, importPath, depType);
  else if (language === 'py') candidates = pythonCandidates(fromFile, importPath);
  else if (language === 'java') candidates = javaCandidates(importPath);
  else if (language === 'c' && depType !== 'external')
    candidates = [path.posix.join(path.posix.dirname(fromFile), importPath), importPath];
  else if (language !== 'go' && (importPath.startsWith('./') || importPath.startsWith('../')))
    candidates = jsCandidates(fromFile, importPath);
  for (const candidate of candidates) {
    const normalized = path.posix.normalize(candidate);
    if (
      normalized === '..' ||
      normalized.startsWith('../') ||
      path.posix.isAbsolute(normalized) ||
      /^[A-Za-z]:/.test(normalized)
    )
      continue;
    const id = indexed.get(normalized);
    if (id !== undefined)
      return {
        resolvedPath: normalized,
        fileId: integer(id, 'resolved file ID'),
      };
  }
  return null;
}

function jsCandidates(fromFile: string, name: string): string[] {
  const base = path.posix.join(path.posix.dirname(fromFile), name);
  const candidates = [base];
  const substitutions: Record<string, string[]> = {
    '.js': ['.ts', '.tsx'],
    '.jsx': ['.tsx'],
    '.mjs': ['.mts'],
    '.cjs': ['.cts'],
  };
  const extension = path.posix.extname(base);
  for (const replacement of substitutions[extension] ?? [])
    candidates.push(base.slice(0, -extension.length) + replacement);
  candidates.push(...JS_EXTENSIONS.map((extension) => base + extension));
  candidates.push(...JS_EXTENSIONS.map((extension) => path.posix.join(base, 'index' + extension)));
  return candidates;
}

function pythonCandidates(fromFile: string, name: string): string[] {
  const match = /^(\.*)([\w.]*)$/.exec(name);
  if (!match) return [];
  const dots = match[1]!.length;
  const modulePath = match[2]!.replaceAll('.', '/');
  const bases: string[] = [];
  if (dots > 0) {
    let directory = path.posix.dirname(fromFile);
    for (let level = 1; level < dots; level++) directory = path.posix.join(directory, '..');
    bases.push(path.posix.join(directory, modulePath));
  } else bases.push(modulePath, path.posix.join('src', modulePath));
  return bases.flatMap((base) => [base + '.py', path.posix.join(base, '__init__.py')]);
}

function rustCandidates(fromFile: string, name: string, kind?: string): string[] {
  const directory = path.posix.dirname(fromFile);
  const stem = path.posix.basename(fromFile, '.rs');
  const moduleBase = ['lib', 'main', 'mod'].includes(stem)
    ? directory
    : path.posix.join(directory, stem);
  if (kind === 'mod' || (!name.includes('::') && kind !== 'use'))
    return rustFiles(path.posix.join(moduleBase, name));
  let base: string;
  const segments = name.split('::');
  const root = rustSourceRoot(fromFile);
  if (segments[0] === 'crate') {
    base = root;
    segments.shift();
  } else if (segments[0] === 'self') {
    base = moduleBase;
    segments.shift();
  } else if (segments[0] === 'super') {
    base = moduleBase;
    while (segments[0] === 'super') {
      if (base === root || base === '.') return [];
      base = path.posix.dirname(base);
      segments.shift();
    }
  } else return [];
  const candidates: string[] = [];
  while (segments.length) {
    if (segments.at(-1) !== '*') candidates.push(...rustFiles(path.posix.join(base, ...segments)));
    segments.pop();
  }
  candidates.push(...rustFiles(base));
  if (base === root)
    candidates.push(path.posix.join(root, 'lib.rs'), path.posix.join(root, 'main.rs'));
  return candidates;
}

function rustFiles(base: string): string[] {
  return [base + '.rs', path.posix.join(base, 'mod.rs')];
}

function rustSourceRoot(filename: string): string {
  if (filename.startsWith('src/')) return 'src';
  const index = filename.lastIndexOf('/src/');
  return index < 0 ? '.' : filename.slice(0, index + 4);
}

function javaCandidates(name: string): string[] {
  if (name.endsWith('.*')) return [];
  const segments = name.split('.');
  const candidates: string[] = [];
  while (segments.length) {
    const filename = segments.join('/') + '.java';
    candidates.push(
      filename,
      path.posix.join('src', filename),
      path.posix.join('src/main/java', filename),
      path.posix.join('src/test/java', filename),
    );
    segments.pop();
  }
  return candidates;
}
