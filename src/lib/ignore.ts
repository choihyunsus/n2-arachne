// Root ignore files use Git-style patterns, including negation and escaped literals.
import fs from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';
import type { IgnoreConfig } from '../types';

export class IgnoreFilter {
  private readonly matcher = ignore({
    ignorecase: process.platform === 'win32',
  });
  private readonly patterns: string[] = [];

  constructor(config: IgnoreConfig, projectDir: string) {
    this.add(config.patterns ?? []);
    if (config.useGitignore) this.loadFile(path.join(projectDir, '.gitignore'));
    if (config.useContextignore) this.loadFile(path.join(projectDir, '.contextignore'));
  }

  isIgnored(relativePath: string): boolean {
    return this.matcher.ignores(relativePath.replace(/\\/g, '/'));
  }

  filter(paths: string[]): string[] {
    return paths.filter((filename) => !this.isIgnored(filename));
  }
  get patternCount(): number {
    return this.patterns.length;
  }

  private add(patterns: string[]): void {
    if (
      patterns.some((pattern) => typeof pattern !== 'string') ||
      patterns.length + this.patterns.length > 10000
    ) {
      throw new Error('Invalid or excessive ignore patterns');
    }
    this.patterns.push(...patterns);
    this.matcher.add(patterns);
  }

  private loadFile(filename: string): void {
    let metadata: fs.Stats;
    try {
      metadata = fs.lstatSync(filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error('Ignore configuration must be a regular file');
    const maximum = 1048576;
    const descriptor = fs.openSync(filename, 'r');
    try {
      const bytes = Buffer.alloc(Math.min(metadata.size + 1, maximum + 1));
      const read = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
      if (metadata.size > maximum || read > maximum || read > metadata.size)
        throw new Error('Ignore configuration exceeds 1 MiB');
      this.add(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, read)).split(/\r?\n/),
      );
    } finally {
      fs.closeSync(descriptor);
    }
  }
}
