const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('library imports without opening storage and CLI information works before configuration', () => {
  const env = {
    ...process.env,
    N2_CONTEXT_PROJECT_DIR: path.join(root, 'missing-fixture-root'),
  };
  const imported = spawnSync(
    process.execPath,
    [
      '-e',
      'const api=require(process.argv[1]); console.log(typeof api.Store, typeof api.Indexer, typeof api.BM25Search);',
      root,
    ],
    { env, encoding: 'utf8', timeout: 3000 },
  );
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout.trim(), 'function function function');
  for (const entry of [root, path.join(root, 'dist/index.js')]) {
    const help = spawnSync(process.execPath, [entry, '--help'], {
      env,
      encoding: 'utf8',
      timeout: 3000,
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /N2_CONTEXT_DB_PATH/);
    const version = spawnSync(process.execPath, [entry, '--version'], {
      env,
      encoding: 'utf8',
      timeout: 3000,
    });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), require('../package.json').version);
  }
  const invalid = spawnSync(process.execPath, [root, '--invalid-fixture'], {
    env,
    encoding: 'utf8',
    timeout: 3000,
  });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Unknown argument/);
});
