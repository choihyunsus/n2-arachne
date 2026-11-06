// Import extraction and file resolution are deterministic and stay inside the indexed scope.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  extractDependencies,
  resolveImport,
  indexFileDependencies,
} = require('../dist/lib/dependency');
const { Store } = require('../dist/lib/store');
const files = (names) => new Map(names.map((name, index) => [name, index + 1]));

test('JavaScript imports, re-exports and dynamic literals ignore comments and quoted examples', () => {
  const source = [
    '// import fake from "./comment";',
    'const sample = "require(\'./string\')";',
    '/* export { fake } from "./block"; */',
    'import /* comment */ { x, y as z } from "./module.js";',
    'export { x } from "./export";',
    'import "./side-effect";',
    'const loaded = require.resolve("../require");',
    'const later = import("./dynamic");',
    'obj.require("./method");',
    'import type { T } from "package-name";',
  ].join('\n');
  const imports = extractDependencies(source, 'tsx');
  assert.deepEqual(
    new Set(imports.map((dep) => dep.importPath)),
    new Set([
      './module.js',
      './export',
      './side-effect',
      '../require',
      './dynamic',
      'package-name',
    ]),
  );
  assert.equal(imports.find((dep) => dep.importPath === 'package-name').depType, 'external');
  const indexed = files(['src/module.ts', 'src/lib/index.mts']);
  assert.equal(resolveImport('src/main.ts', './module.js', indexed).resolvedPath, 'src/module.ts');
  assert.equal(resolveImport('src/main.ts', './lib', indexed).resolvedPath, 'src/lib/index.mts');
  assert.equal(resolveImport('src/main.ts', '../../outside', indexed), null);
  assert.equal(resolveImport('src/main.ts', 'package-name', indexed), null);
});

test('Rust grouped use paths, crate boundaries, nested modules and parent modules resolve locally', () => {
  const imports = extractDependencies(
    'use crate::{utils::{helper as renamed, Thing}, other};\nuse super::peer;\nmod child;\n// mod fake;',
    'rust',
  );
  assert.deepEqual(
    new Set(imports.map((dep) => dep.importPath)),
    new Set([
      'crate::utils::helper',
      'crate::utils::Thing',
      'crate::other',
      'super::peer',
      'child',
    ]),
  );
  const indexed = files([
    'crates/a/src/lib.rs',
    'crates/a/src/utils.rs',
    'crates/a/src/feature/child.rs',
    'crates/a/src/peer.rs',
    'crates/b/src/utils.rs',
  ]);
  assert.equal(
    resolveImport('crates/a/src/feature.rs', 'crate::utils::Thing', indexed, 'use').resolvedPath,
    'crates/a/src/utils.rs',
  );
  assert.equal(
    resolveImport('crates/a/src/feature.rs', 'child', indexed, 'mod').resolvedPath,
    'crates/a/src/feature/child.rs',
  );
  assert.equal(
    resolveImport('crates/a/src/feature.rs', 'super::peer', indexed, 'use').resolvedPath,
    'crates/a/src/peer.rs',
  );
  assert.equal(resolveImport('crates/a/src/lib.rs', 'super::peer', indexed, 'use'), null);
  assert.equal(resolveImport('crates/a/src/lib.rs', 'std::path::Path', indexed, 'use'), null);
});

test('Python relative imports, Go import groups, Java classes and quoted C includes retain their contracts', () => {
  const python = extractDependencies(
    'import pkg.one, pkg.two as alias\nfrom . import helper\nfrom ..shared import Thing\n"""\nimport fake\n"""',
    'py',
  );
  assert.ok(python.some((dep) => dep.importPath === '.helper'));
  assert.ok(python.some((dep) => dep.importPath === 'pkg.two'));
  assert.ok(!python.some((dep) => dep.importPath === 'fake'));
  const indexed = files([
    'pkg/helper.py',
    'pkg/shared.py',
    'pkg/shared/__init__.py',
    'shared.py',
    'src/main/java/com/example/Thing.java',
    'src/header.h',
  ]);
  assert.equal(resolveImport('pkg/main.py', '.helper', indexed).resolvedPath, 'pkg/helper.py');
  assert.equal(resolveImport('pkg/sub/main.py', '..shared', indexed).resolvedPath, 'pkg/shared.py');
  assert.deepEqual(
    extractDependencies(
      'import (\n "fmt"\n alias "example.org/library"\n)\n// import "fake"',
      'go',
    ).map((dep) => dep.importPath),
    ['fmt', 'example.org/library'],
  );
  assert.equal(resolveImport('main.go', './local', files(['local.js'])), null);
  assert.equal(
    resolveImport('src/main/java/Main.java', 'com.example.Thing.run', indexed).resolvedPath,
    'src/main/java/com/example/Thing.java',
  );
  const includes = extractDependencies(
    '#include "header.h"\n#include <vector>\n// #include "fake.h"',
    'cpp',
  );
  assert.equal(includes.length, 2);
  assert.equal(
    resolveImport('src/main.cpp', includes[0].importPath, indexed, includes[0].depType)
      .resolvedPath,
    'src/header.h',
  );
  assert.equal(resolveImport('src/main.cpp', 'vector', indexed, 'external'), null);
});

test('standalone dependency replacement rolls back failures and verifies its source ownership', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arachne-dependencies-'));
  const store = new Store(root, {
    projectRoot: root,
    project: 'fixture',
    agent: 'worker',
  });
  try {
    await store.init();
    const source = store.upsertFile('main.ts', 'hash', 'ts', 1, '2026-01-01').fileId;
    const target = store.upsertFile('target.ts', 'hash', 'ts', 1, '2026-01-01').fileId;
    indexFileDependencies(store, source, 'import "./target";', 'ts', 'main.ts');
    assert.equal(store.getDirectDependencies(source)[0].target_file_id, target);
    store.db.exec(
      "CREATE TRIGGER injected BEFORE INSERT ON arachne_dependencies BEGIN SELECT RAISE(ABORT,'injected'); END",
    );
    assert.throws(
      () => indexFileDependencies(store, source, 'import "./missing";', 'ts', 'main.ts'),
      /injected/,
    );
    assert.equal(store.getDirectDependencies(source)[0].target_file_id, target);
    assert.throws(() => indexFileDependencies(store, source, '', 'ts', 'other.ts'), /differs/);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
