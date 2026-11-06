const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, deepMerge } = require('../dist/lib/config');
const { validateConfig, booleanEnvironment } = require('../dist/lib/config-validation');
const defaults = () => structuredClone(require('../config.default.js'));

test('configuration rejects invalid flags, resource values, unsupported modes and prototype keys', () => {
  for (const change of [
    (config) => {
      config.indexing.maxFiles = -1;
    },
    (config) => {
      config.indexing.chunkStrategy = 'ast';
    },
    (config) => {
      config.indexing.tokenMultiplier = Infinity;
    },
    (config) => {
      config.indexing.supportedLanguages = ['../ts'];
    },
    (config) => {
      config.backup.maxBackups = 0;
    },
    (config) => {
      config.search.bm25.k1 = 0;
    },
    (config) => {
      config.kvCache.enabled = 'false';
    },
    (config) => {
      config.assembly.layers.fixed = 2;
    },
  ]) {
    const config = defaults();
    change(config);
    assert.throws(() => validateConfig(config));
  }
  assert.throws(
    () => deepMerge(defaults(), JSON.parse('{"indexing":{"__proto__":{"polluted":true}}}')),
    /property/,
  );
  assert.equal({}.polluted, undefined);
  assert.equal(booleanEnvironment('true'), true);
  assert.equal(booleanEnvironment('false'), false);
  assert.throws(() => booleanEnvironment('yes'), /true or false/);
  const zero = defaults();
  zero.assembly.defaultBudget = 0;
  validateConfig(zero);
});

test('environment overrides keep source defaults immutable and resolve shared storage explicitly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-config-'));
  const original = { ...process.env };
  try {
    fs.copyFileSync(
      path.resolve(__dirname, '../config.default.js'),
      path.join(root, 'config.default.js'),
    );
    fs.writeFileSync(
      path.join(root, 'config.local.js'),
      'module.exports = { indexing: { maxFiles: 25 } };',
    );
    for (const name of Object.keys(process.env))
      if (name.startsWith('N2_')) delete process.env[name];
    process.env.N2_CONTEXT_PROJECT_DIR = root;
    process.env.N2_DATA_DIR = path.join(root, 'shared');
    process.env.N2_PROJECT = 'chosen-project';
    process.env.N2_AGENT_NAME = 'chosen-agent';
    process.env.N2_CONTEXT_BUDGET = '0';
    process.env.N2_CONTEXT_AUTO_INDEX = 'false';
    const first = loadConfig(root);
    assert.equal(first.dataDir, path.join(root, 'shared'));
    assert.equal(first.backup.dir, '');
    assert.equal(first.indexing.maxFiles, 25);
    assert.equal(first.indexing.autoIndex, false);
    assert.equal(first.project, 'chosen-project');
    assert.equal(first.assembly.defaultBudget, 0);
    first.indexing.supportedLanguages.push('invented');
    delete process.env.N2_CONTEXT_BUDGET;
    const second = loadConfig(root);
    assert.equal(second.assembly.defaultBudget, 40000);
    assert.ok(!second.indexing.supportedLanguages.includes('invented'));
  } finally {
    for (const name of Object.keys(process.env))
      if (name.startsWith('N2_')) delete process.env[name];
    for (const [name, value] of Object.entries(original))
      if (name.startsWith('N2_')) process.env[name] = value;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
