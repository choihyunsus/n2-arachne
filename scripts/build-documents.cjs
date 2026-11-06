// Build and place the document parser for the current host platform.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const project = path.join(root, 'document-worker');
if (process.env.CARGO_BUILD_TARGET) {
  throw new Error(
    'Build cross-platform document assets directly with Cargo and name the target explicitly.',
  );
}
const result = spawnSync('cargo', ['build', '--release', '--locked', '-j', '2'], {
  cwd: project,
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const extension = process.platform === 'win32' ? '.exe' : '';
const destination = path.join(
  root,
  'bin',
  `n2-arachne-doc-${process.platform}-${process.arch}${extension}`,
);
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.copyFileSync(path.join(project, 'target', 'release', `n2-arachne-doc${extension}`), destination);
fs.chmodSync(destination, 0o755);
process.stdout.write(`Document parser built for ${process.platform}-${process.arch}\n`);
