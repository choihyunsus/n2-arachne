// Heuristic import extraction keeps literal paths and rejects matches inside comments or strings.
import type { ExtractedDep } from '../types';
import { maskSource } from './source-mask';

const ALIASES: Record<string, string> = {
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  javascript: 'js',
  tsx: 'ts',
  mts: 'ts',
  cts: 'ts',
  typescript: 'ts',
  python: 'py',
  rust: 'rs',
  golang: 'go',
  h: 'c',
  hpp: 'c',
  cpp: 'c',
};
const JS_PATTERNS = [
  /\b(?:import|export)\s{1,4096}[\w$\s{},*]{1,4096}?\bfrom\s{0,4096}['"]([^'"\r\n]{1,4096})['"]/g,
  /\bimport\s{1,4096}['"]([^'"\r\n]{1,4096})['"]/g,
  /\b(?:require(?:\.resolve)?|import)\s{0,4096}\(\s{0,4096}['"]([^'"\r\n]{1,4096})['"]\s{0,4096}\)/g,
];

export function dependencyLanguage(language: string): string {
  const lower = language.toLowerCase();
  return Object.hasOwn(ALIASES, lower) ? ALIASES[lower]! : lower;
}

export function extractDependencies(content: string, language: string): ExtractedDep[] {
  if (typeof content !== 'string' || content.length > 10485760)
    throw new Error('Dependency source exceeds its input limit');
  const lang = dependencyLanguage(language);
  const code = maskSource(content, lang);
  const commentsRemoved = maskSource(content, lang, true);
  const found = new Map<string, ExtractedDep>();
  const add = (importPath: string, depType: string) => {
    if (importPath.length > 4096 || found.size >= 10000)
      throw new Error('Dependency collection limit reached');
    if (importPath) found.set(importPath, { importPath, depType });
  };
  switch (lang) {
    case 'js':
    case 'ts':
      for (const pattern of JS_PATTERNS) {
        for (const match of commentsRemoved.matchAll(pattern)) {
          if (!visibleMatch(code, match.index)) continue;
          add(match[1]!, match[1]!.startsWith('.') ? 'import' : 'external');
        }
      }
      break;
    case 'py':
      pythonImports(code, add);
      break;
    case 'rs':
      rustImports(code, add);
      break;
    case 'go':
      goImports(commentsRemoved, code, add);
      break;
    case 'java':
      for (const match of code.matchAll(/\bimport\s+(?:static\s+)?([\w.]+(?:\*)?)\s*;/g))
        add(match[1]!, 'import');
      break;
    case 'c':
      for (const match of commentsRemoved.matchAll(/#[ \t]*include[ \t]*(["<])([^">\r\n]+)[">]/g)) {
        if (visibleMatch(code, match.index))
          add(match[2]!, match[1] === '"' ? 'include' : 'external');
      }
      break;
  }
  return [...found.values()];
}

function visibleMatch(code: string, index: number): boolean {
  return Boolean(code[index]?.trim()) && code[index - 1] !== '.';
}

type AddDependency = (importPath: string, depType: string) => void;

function pythonImports(code: string, add: AddDependency): void {
  for (const match of code.matchAll(
    /\bfrom\s+([\w.]+)\s+import\s+(\([^)]{0,16384}\)|[^\r\n;]{1,16384})/g,
  )) {
    const base = match[1]!;
    if (!/^\.+$/.test(base)) add(base, 'import');
    for (const item of match[2]!.replace(/[()]/g, '').split(',')) {
      const name = item.trim().split(/\s+/)[0];
      if (name && /^\w+$/.test(name)) add(base + (base.endsWith('.') ? '' : '.') + name, 'from');
    }
  }
  for (const match of code.matchAll(/^[ \t]*import[ \t]+([^\r\n;]{1,16384})/gm)) {
    for (const item of match[1]!.split(',')) {
      const name = item.trim().split(/\s+/)[0];
      if (name && /^[\w.]+$/.test(name)) add(name, 'import');
    }
  }
}

function rustImports(code: string, add: AddDependency): void {
  for (const match of code.matchAll(/\buse\s+([^;]{1,16384});/g)) {
    for (const item of expandRustUse(match[1]!)) add(item, 'use');
  }
  for (const match of code.matchAll(/\bmod\s+(\w+)\s*;/g)) add(match[1]!, 'mod');
}

function expandRustUse(value: string, prefix = '', depth = 0): string[] {
  if (depth > 16) throw new Error('Rust use nesting limit reached');
  const parts: string[] = [];
  let start = 0,
    nesting = 0;
  for (let index = 0; index <= value.length; index++) {
    if (value[index] === '{') nesting++;
    if (value[index] === '}') nesting--;
    if ((value[index] === ',' && nesting === 0) || index === value.length) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  return parts.flatMap((part) => {
    const open = part.indexOf('{');
    if (open >= 0 && part.endsWith('}'))
      return expandRustUse(
        part.slice(open + 1, -1),
        prefix + part.slice(0, open).replace(/\s/g, ''),
        depth + 1,
      );
    const leaf = part.replace(/\s+as\s+\w+$/, '').replace(/\s/g, '');
    return [prefix + (leaf === 'self' ? '' : leaf)]
      .map((name) => name.replace(/::$/, ''))
      .filter(Boolean);
  });
}

function goImports(source: string, code: string, add: AddDependency): void {
  for (const match of source.matchAll(
    /\bimport\s+(\([^)]{0,16384}\)|(?:\w+\s+|\.\s+)?["`][^"`\r\n]+["`])/g,
  )) {
    if (!visibleMatch(code, match.index)) continue;
    for (const name of match[1]!.matchAll(/["`]([^"`\r\n]+)["`]/g)) add(name[1]!, 'package');
  }
}
