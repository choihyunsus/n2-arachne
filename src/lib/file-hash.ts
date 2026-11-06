// Stream stable file fingerprints within explicit byte and time limits.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { integer } from './store-values';

export const MAX_SNAPSHOT_BYTES = 2 * 1024 ** 3;

export function hashFile(
  filename: string,
  maximum = MAX_SNAPSHOT_BYTES,
): { sha256: string; size: number } {
  integer(maximum, 'fingerprint byte limit', MAX_SNAPSHOT_BYTES);
  const fd = fs.openSync(filename, 'r');
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > maximum)
      throw new Error('File exceeds the fingerprint byte limit or is not a regular file');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1048576);
    const deadline = Date.now() + 120000;
    let bytes: number,
      size = 0;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      size += bytes;
      if (size > maximum || Date.now() > deadline)
        throw new Error('File fingerprint resource limit reached');
      hash.update(buffer.subarray(0, bytes));
    }
    const after = fs.fstatSync(fd),
      named = fs.statSync(filename);
    if (
      size !== before.size ||
      size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      named.dev !== before.dev ||
      named.ino !== before.ino
    )
      throw new Error('File changed while fingerprinting');
    return { sha256: hash.digest('hex'), size };
  } finally {
    fs.closeSync(fd);
  }
}
