// Account for every rendered character, including labels, fences and truncation markers.
import type { LayerItem, LayerResult } from '../types';

export function estimateTokens(value: string, multiplier = 3.5): number {
  if (!Number.isFinite(multiplier) || multiplier < 0.25 || multiplier > 16)
    throw new Error('Token multiplier must be between 0.25 and 16');
  return Math.ceil(value.length / multiplier);
}

function sliceText(value: string, length: number): string {
  let result = value.slice(0, Math.max(0, length));
  if (/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
  return result;
}

export class LayerWriter {
  private body = '';
  private readonly heading: string;
  private readonly maximum: number;
  private readonly items: LayerItem[] = [];

  constructor(
    title: string,
    budget: number,
    private readonly multiplier: number,
  ) {
    this.heading = `# ${title}\n`;
    this.maximum = Math.floor(budget * multiplier);
  }

  get remaining(): number {
    return Math.max(0, this.maximum - this.heading.length - this.body.length - 2);
  }

  addText(value: string): boolean {
    const marker = '\n[truncated]\n';
    const content =
      value.length <= this.remaining
        ? value
        : sliceText(value, this.remaining - marker.length) + marker;
    if (!content || content.length > this.remaining) return false;
    this.body += content;
    return true;
  }

  addSnippet(
    label: string,
    language: string | null | undefined,
    content: string,
    item: LayerItem,
  ): boolean {
    const runs = content.matchAll(/`+/g);
    let fenceSize = 3;
    for (const run of runs) fenceSize = Math.max(fenceSize, run[0].length + 1);
    const fence = '`'.repeat(fenceSize);
    const safeLanguage = /^[A-Za-z0-9_+\-]{0,32}$/.test(language ?? '') ? (language ?? '') : '';
    const prefix = `\n## ${label.replace(/[\r\n]/g, ' ')}\n${fence}${safeLanguage}\n`;
    const suffix = `\n${fence}\n`;
    const marker = '\n[truncated]';
    const available = this.remaining - prefix.length - suffix.length;
    if (available <= marker.length) return false;
    const shown =
      content.length <= available
        ? content
        : sliceText(content, available - marker.length) + marker;
    const snippet = prefix + shown + suffix;
    this.body += snippet;
    this.items.push({
      ...item,
      tokens: estimateTokens(snippet, this.multiplier),
    });
    return true;
  }

  result(): LayerResult {
    const text = this.body ? this.heading + this.body + '\n\n' : '';
    return {
      text,
      tokens: estimateTokens(text, this.multiplier),
      items: this.items.map((item) => ({ ...item })),
    };
  }
}
