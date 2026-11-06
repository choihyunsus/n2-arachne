// Portable finite Float32 vectors share one validation and binary representation.
export function vectorValues(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 8192 ||
    value.some(
      (item) =>
        typeof item !== 'number' || !Number.isFinite(item) || !Number.isFinite(Math.fround(item)),
    )
  ) {
    throw new Error('Embedding vectors require 1-8192 finite Float32 values');
  }
  const values = value.map(Math.fround);
  if (!values.some((item) => item !== 0)) throw new Error('Embedding vector has zero norm');
  return values;
}

export function encodeVector(values: number[]): Buffer {
  const vector = vectorValues(values);
  const bytes = Buffer.alloc(vector.length * 4);
  vector.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes;
}

export function decodeVector(value: unknown, dimensions: number): number[] {
  if (
    !Number.isSafeInteger(dimensions) ||
    dimensions < 1 ||
    dimensions > 8192 ||
    !Buffer.isBuffer(value) ||
    value.length !== dimensions * 4
  ) {
    throw new Error('Stored embedding has an invalid binary representation');
  }
  return vectorValues(
    Array.from({ length: dimensions }, (_, index) => value.readFloatLE(index * 4)),
  );
}

export function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || !left.length) return 0;
  let dot = 0,
    leftNorm = 0,
    rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! * left[index]!;
    rightNorm += right[index]! * right[index]!;
  }
  if (!leftNorm || !rightNorm) return 0;
  return Math.max(-1, Math.min(1, dot / Math.sqrt(leftNorm) / Math.sqrt(rightNorm)));
}
