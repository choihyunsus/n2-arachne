// Bounded HTTP reads keep response bodies inside the caller's resource budget.
export async function readResponseText(
  response: Response,
  maxBytes = 2 * 1024 * 1024,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const reader = response.body?.getReader();
  if (!reader) return '';
  let onAbort: (() => void) | undefined;
  try {
    const stopped =
      signal &&
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason ?? new Error('HTTP response aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    const reading = readBoundedBody(reader, maxBytes);
    return await (stopped ? Promise.race([reading, stopped]) : reading);
  } finally {
    if (onAbort) signal!.removeEventListener('abort', onAbort);
    // Cancellation is best effort. A stalled transport must not delay the caller's deadline.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function readBoundedBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) throw new Error('HTTP response exceeds byte limit');
    chunks.push(value);
  }
  return Buffer.concat(chunks, length).toString('utf8');
}

export function httpUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Expected an HTTP(S) URL without embedded credentials');
  }
  return url;
}
