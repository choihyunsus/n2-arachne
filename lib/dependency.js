// dependency.js — 의존성 그래프 추출/해석 모듈
// import/require 정규식 파싱 → 경로 해석 → DB 저장
const path = require('path');
const fs = require('fs');

// ── 언어별 의존성 패턴 ──

const JS_PATTERNS = [
    // ES6: import X from './path'  |  import { X } from './path'
    /import\s+(?:[\w{}\s,*]+\s+from\s+)?['"]([^'"]+)['"]/g,
    // CommonJS: require('./path')
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // Dynamic: import('./path')
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const PY_PATTERNS = [
    // from X.Y import Z
    /from\s+([\w.]+)\s+import/g,
    // import X.Y
    /^import\s+([\w.]+)/gm,
];

const RUST_PATTERNS = [
    // use crate::module
    /use\s+(crate::[\w:]+)/g,
    // mod module_name
    /mod\s+(\w+)\s*;/g,
];

const GO_PATTERNS = [
    // import "path"  |  import ( "path" )
    /import\s+(?:\(\s*)?["']([^"']+)["']/g,
];

/**
 * 파일 내용에서 의존성 추출
 * @param {string} content - 파일 내용
 * @param {string} language - 파일 언어 (js, ts, py, rs, go)
 * @returns {Array<{importPath: string, depType: string}>}
 */
function extractDependencies(content, language) {
    const patterns = _getPatternsForLanguage(language);
    if (!patterns) return [];

    const deps = [];
    const seen = new Set();

    for (const pattern of patterns) {
        // RegExp는 stateful이므로 lastIndex 리셋
        const regex = new RegExp(pattern.source, pattern.flags);
        let match;
        while ((match = regex.exec(content)) !== null) {
            const importPath = match[1];
            if (!importPath || seen.has(importPath)) continue;
            seen.add(importPath);

            const depType = _classifyDepType(importPath, language);
            deps.push({ importPath, depType });
        }
    }

    return deps;
}

/**
 * import 경로를 실제 파일 경로로 해석
 * @param {string} fromFile - import를 하는 파일의 상대 경로
 * @param {string} importPath - import 경로 (예: './executor')
 * @param {Map<string, number>} indexedFiles - 인덱싱된 파일 맵 (relativePath → fileId)
 * @returns {{resolvedPath: string, fileId: number}|null}
 */
function resolveImport(fromFile, importPath, indexedFiles) {
    // 외부 패키지 (상대경로가 아닌 것) → 무시
    if (!_isRelativePath(importPath)) return null;

    const fromDir = path.dirname(fromFile);
    const basePath = path.join(fromDir, importPath).replace(/\\/g, '/');

    // 1. 정확한 파일 존재 여부
    if (indexedFiles.has(basePath)) {
        return { resolvedPath: basePath, fileId: indexedFiles.get(basePath) };
    }

    // 2. 확장자 추가 시도
    const extensions = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'];
    for (const ext of extensions) {
        const withExt = basePath + ext;
        if (indexedFiles.has(withExt)) {
            return { resolvedPath: withExt, fileId: indexedFiles.get(withExt) };
        }
    }

    // 3. 디렉토리 인덱스 파일 시도
    const indexFiles = ['index.js', 'index.ts', 'index.jsx', 'index.tsx', 'index.mjs'];
    for (const idx of indexFiles) {
        const indexPath = basePath + '/' + idx;
        if (indexedFiles.has(indexPath)) {
            return { resolvedPath: indexPath, fileId: indexedFiles.get(indexPath) };
        }
    }

    // 4. 해석 실패
    return null;
}

/**
 * 인덱서에서 사용: 파일 인덱싱 시 의존성 추출 → DB 저장
 * @param {import('./store').Store} store
 * @param {number} fileId
 * @param {string} content - 파일 내용
 * @param {string} language
 * @param {string} relativePath - 파일 상대 경로
 */
function indexFileDependencies(store, fileId, content, language, relativePath) {
    // 의존성 지원 언어만 처리
    if (!_getPatternsForLanguage(language)) return;

    // 기존 의존성 클리어
    store.clearDependencies(fileId);

    // 의존성 추출
    const deps = extractDependencies(content, language);
    if (deps.length === 0) return;

    // 인덱싱된 파일 맵 구축 (경로 → fileId)
    const allFiles = store.getAllFiles();
    const fileMap = new Map();
    for (const f of allFiles) {
        fileMap.set(f.path, f.id);
    }

    // 경로 해석 → DB 저장
    const resolved = [];
    for (const dep of deps) {
        const result = resolveImport(relativePath, dep.importPath, fileMap);
        resolved.push({
            targetPath: dep.importPath,
            targetFileId: result ? result.fileId : null,
            depType: dep.depType,
        });
    }

    if (resolved.length > 0) {
        store.insertDependencies(fileId, resolved);
    }
}

// ── 유틸리티 ──

function _getPatternsForLanguage(language) {
    switch (language) {
        case 'js': case 'jsx': case 'mjs': case 'cjs':
        case 'ts': case 'tsx':
            return JS_PATTERNS;
        case 'py':
            return PY_PATTERNS;
        case 'rs':
            return RUST_PATTERNS;
        case 'go':
            return GO_PATTERNS;
        default:
            return null;
    }
}

function _isRelativePath(importPath) {
    return importPath.startsWith('./') || importPath.startsWith('../');
}

function _classifyDepType(importPath, language) {
    if (language === 'py') return 'import';
    if (language === 'rs') return importPath.startsWith('crate::') ? 'use' : 'mod';
    if (language === 'go') return 'import';

    // JS/TS — 외부 패키지 vs 상대 경로
    if (_isRelativePath(importPath)) return 'import';
    return 'external'; // node_modules
}

module.exports = {
    extractDependencies,
    resolveImport,
    indexFileDependencies,
};
