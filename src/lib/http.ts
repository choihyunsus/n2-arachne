// Bounded HTTP reads keep response bodies inside the caller's resource budget.
export async function readResponseText(
  response: Response,
  maxBytes = 2 * 1024 * 1024,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error('HTTP response exceeds byte limit');
      chunks.push(value);
    }
    return Buffer.concat(chunks, length).toString('utf8');
  } finally {
    // Cancellation is best effort. A stalled transport must not delay the caller's deadline.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function httpUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Expected an HTTP(S) URL without embedded credentials');
  }
  return url;
}
