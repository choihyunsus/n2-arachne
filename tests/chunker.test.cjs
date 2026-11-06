// Regressions for source coverage, literal/comment braces and bounded Unicode windows.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chunkCode, setTokenMultiplier, estimateTokens } = require('../dist/lib/chunker');
const { MAX_CHUNK_CHARS } = require('../dist/lib/chunk-windows');
const { maskSource } = require('../dist/lib/source-mask');

test('comments, strings, regex literals and template literals do not end a function early', () => {
  const code = [
    '/* function fake() { } */',
    'export function real() {',
    '  const quoted = "}";',
    '  const expression = /}/;',
    '  const template = `} ${ignored}`;',
    '  // } comment',
    '  return "needle";',
    '}',
    'function second() { return 2; }',
  ].join('\n');
  const chunks = chunkCode(code, 'ts');
  const real = chunks.find((chunk) => chunk.name === 'real');
  assert.equal(real.startLine, 2);
  assert.equal(real.endLine, 8);
  assert.match(real.content, /needle/);
  assert.ok(chunks.some((chunk) => chunk.name === 'second'));
  assert.ok(!chunks.some((chunk) => chunk.name === 'fake'));
  for (const chunk of chunks)
    assert.equal(
      chunk.content,
      code
        .split('\n')
        .slice(chunk.startLine - 1, chunk.endLine)
        .join('\n'),
    );
  const masked = maskSource(code, 'ts');
  assert.equal(masked.length, code.length);
  assert.equal(masked.split('\n').length, code.split('\n').length);
});

test('large containers retain contiguous remainders, whitespace and all source lines', () => {
  const code = [
    'export class Fixture {',
    '  field = 1;',
    '  first() {',
    '    // ' + 'long '.repeat(400),
    '    return "one";',
    '  }',
    '  between = 2;',
    '  second() {',
    '    return "two";',
    '  }',
    '  last = 3;',
    '}',
  ].join('\n');
  const chunks = chunkCode(code, 'ts');
  const covered = new Set();
  for (const chunk of chunks) {
    assert.equal(
      chunk.content,
      code
        .split('\n')
        .slice(chunk.startLine - 1, chunk.endLine)
        .join('\n'),
    );
    for (let line = chunk.startLine; line <= chunk.endLine; line++) covered.add(line);
  }
  assert.equal(covered.size, code.split('\n').length);
  assert.ok(chunks.some((chunk) => chunk.name === 'first'));
  assert.ok(chunks.some((chunk) => chunk.name === 'second'));
});

test('text and very long source lines use bounded overlapping windows with valid line ranges', () => {
  const text = Array.from(
    { length: 1500 },
    (_, index) => `${index} 가나다 😀 ${'word '.repeat(6)}`,
  ).join('\n');
  for (const language of ['md', '__proto__', 'constructor']) {
    const chunks = chunkCode(text, language, 1.5);
    assert.ok(chunks.length > 2);
    assert.ok(chunks.every((chunk) => chunk.content.length <= MAX_CHUNK_CHARS));
    assert.ok(chunks.some((chunk) => chunk.searchText.includes('1499 가나다')));
    for (const chunk of chunks) {
      const offset = text.indexOf(chunk.content);
      assert.ok(offset >= 0);
      assert.equal(chunk.startLine, text.slice(0, offset).split('\n').length);
      assert.equal(chunk.endLine, chunk.startLine + chunk.content.split('\n').length - 1);
      assert.doesNotMatch(chunk.content, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk.content));
    }
  }
  const oneLine = chunkCode('😀'.repeat(10000), 'txt');
  assert.ok(oneLine.length > 1);
  assert.ok(oneLine.every((chunk) => chunk.startLine === 1 && chunk.endLine === 1));
});

test('Python docstrings cannot create fake functions and multiplier validation is explicit', () => {
  const code = [
    '"""',
    'def fake():',
    '    pass',
    '"""',
    'def real():',
    '    """documentation',
    'dedented literal',
    '    """',
    '    return 1',
    'after = 2',
  ].join('\n');
  const chunks = chunkCode(code, 'py');
  assert.ok(!chunks.some((chunk) => chunk.name === 'fake'));
  const real = chunks.find((chunk) => chunk.name === 'real');
  assert.equal(real.startLine, 5);
  assert.equal(real.endLine, 9);
  assert.throws(() => setTokenMultiplier(Infinity), /multiplier/);
  assert.throws(() => chunkCode('x', 'ts', 0), /multiplier/);
  assert.equal(estimateTokens('😀', undefined, 1), 2);
});
