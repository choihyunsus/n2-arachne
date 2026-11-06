// Public dependency helpers preserve the standalone API and replace one file's edges atomically.
import type { Store } from './store';
import { extractDependencies } from './dependency-extract';
import { resolveImport } from './dependency-resolve';
export { extractDependencies } from './dependency-extract';
export { resolveImport } from './dependency-resolve';

export function indexFileDependencies(
  store: Store,
  fileId: number,
  content: string,
  language: string,
  relativePath: string,
): void {
  const dependencies = extractDependencies(content, language);
  store.db
    .transaction(() => {
      const file = store.requireFile(fileId);
      if (file.path !== relativePath)
        throw new Error('Dependency source path differs from its indexed file');
      const files = new Map(store.getAllFiles().map((file) => [file.path, file.id]));
      const resolved = dependencies.map((dependency) => ({
        targetPath: dependency.importPath,
        depType: dependency.depType,
        targetFileId:
          resolveImport(relativePath, dependency.importPath, files, dependency.depType)?.fileId ??
          null,
      }));
      store.clearDependencies(fileId);
      store.insertDependencies(fileId, resolved);
    })
    .immediate();
}
