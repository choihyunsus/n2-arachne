// File exclusion rules (.gitignore + .contextignore)
import fs from 'fs';
import path from 'path';
import type { IgnoreConfig } from '../types';

export class IgnoreFilter {
  private readonly _patterns: string[] = [];
  private readonly _compiled: RegExp[];

  constructor(config: IgnoreConfig, projectDir: string) {

    // 1. Default patterns (from config.default.js)
    if (config.patterns && config.patterns.length > 0) {
      this._patterns.push(...config.patterns);
    }

    // 2. Load .gitignore
    if (config.useGitignore) {
      this._loadIgnoreFile(path.join(projectDir, '.gitignore'));
    }

    // 3. Load .contextignore (highest priority)
    if (config.useContextignore) {
      this._loadIgnoreFile(path.join(projectDir, '.contextignore'));
    }

    // Pre-compile patterns to regex
    this._compiled = this._patterns.map(p => this._globToRegex(p));
  }

  /**
   * Check if file path should be excluded
   */
  isIgnored(relativePath: string): boolean {
    // Normalize path (Windows backslash → slash)
    const normalized = relativePath.replace(/\\/g, '/');

    for (const regex of this._compiled) {
      if (regex.test(normalized)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Filter excluded paths from file list
   */
  filter(paths: string[]): string[] {
    return paths.filter(p => !this.isIgnored(p));
  }

  /** Number of loaded patterns */
  get patternCount(): number {
    return this._compiled.length;
  }

  /**
   * Load ignore file (.gitignore / .contextignore)
   */
  private _loadIgnoreFile(filePath: string): void {
    if (!fs.existsSync(filePath)) return;

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    for (const rawLine of lines) {
      const line = rawLine.trim();
      // Skip empty lines and comments
      if (!line || line.startsWith('#')) continue;
      // Negation patterns (!) — not yet supported, skip
      if (line.startsWith('!')) continue;
      this._patterns.push(line);
    }
  }

  /**
   * Convert glob pattern to regex
   * Supports: *, **, ?, path separators
   */
  private _globToRegex(pattern: string): RegExp {
    // Clean leading/trailing slashes
    let p = pattern.replace(/\\/g, '/').replace(/^\/+/, '');

    // Directory pattern (ends with /) — include all children
    if (p.endsWith('/')) {
      p += '**';
    }

    let regex = '';
    let i = 0;
    while (i < p.length) {
      const c = p[i];
      if (c === '*') {
        if (p[i + 1] === '*') {
          if (p[i + 2] === '/') {
            regex += '(?:.*\\/)?';
            i += 3;
          } else {
            regex += '.*';
            i += 2;
          }
        } else {
          regex += '[^/]*';
          i++;
        }
      } else if (c === '?') {
        regex += '[^/]';
        i++;
      } else if (c === '.') {
        regex += '\\.';
        i++;
      } else {
        regex += c;
        i++;
      }
    }

    // Extension patterns (*.js) should match anywhere in path
    if (pattern.startsWith('*.')) {
      return new RegExp(`(?:^|\\/)${regex}$`, 'i');
    }

    return new RegExp(`^${regex}$`, 'i');
  }
}
