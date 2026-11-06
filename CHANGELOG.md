# 5.0.0

- Share the distribution Soul schema with explicit project/agent ownership and additive module migrations.
- Import legacy context databases and session history with transactional receipts and source-root checks.
- Fix cross-instance native search caches, stale results after external writes, live restore and scope filtering.
- Add portable model-scoped vectors, checked Ollama responses, bounded requests and resumable batches.
- Bound source discovery, text windows, context assembly, snapshot copies and document subprocesses.
- Add PDF/DOCX/PPTX/XLSX extraction, stable document fingerprints, dependency resolution and graph health.
- Connect MCP before background work, report partial coverage, propagate indexing cancellation and stop on stdin EOF.
- Expose a side-effect-free library, preserve the CLI entry point and add executable regression coverage.
- Preserve the root license terms and include imported-code and binary dependency notices.

## 한국어

Soul 공통 DB와 소유자별 격리, 기존 데이터 이전, 검색·복원 오류 수정, 제한된 문서 파서와 문맥 조립, 의존성 통계, MCP 취소·재시작 처리 및 라이브러리 진입점을 제공합니다. 처리 범위와 이전 절차는 README.ko.md를 확인하세요.

## Historical entries

# Changelog

All notable changes to this project will be documented in this file.

## [4.0.0] — 2026-03-28

### 🚀 Titanium Edition — JS → TypeScript + Rust Hybrid

> **Why This Matters**: Arachne was rewritten from pure JS to TypeScript strict + Rust (napi-rs) for type safety, 10x+ performance on CPU-bound operations, and zero regression migration.

### Added
- **TypeScript strict mode** — 100% type coverage, `strict: true`, zero `as any`
- **Rust native acceleration** via napi-rs — SIMD-ready hot paths for:
  - `estimateTokens` — 214K ops/sec
  - `findBlockEnd` / `findIndentEnd` — Rust brace/indent matching
  - `scanFiles` — parallel file scanning via rayon (22 files in 3.2ms)
  - `bm25Search` — Rust BM25 scoring engine
  - `cosineSimilarity` — 1.06M ops/sec (768D vectors)
  - `batchCosineSimilarity` — 11.2K ops/sec (100 candidates)
- **KV-Cache integration** — Soul KV-Cache for incremental indexing, search history recall, hot file tracking
- **native-bridge.ts** — multi-path .node loader with null fallback strategy
- **Hybrid search** — BM25 + semantic vector search with weighted merge (alpha configurable)
- **Benchmark test suite** — `test/test-benchmark.js` with Rust vs TS performance comparison
- **123 tests** — up from 104, all PASS

### Changed
- Source structure: `lib/*.js` → `src/lib/*.ts` with `dist/` output
- `search.ts` — dual-path `_searchNative()` / `_searchTS()` routing
- `indexer.ts` — dual-path `_scanFilesNative()` / `_scanFilesTS()` routing
- `chunker.ts` — Rust fast-path for `estimateTokens`, `findBlockEnd`, `findIndentEnd`
- `vector-store.ts` — Rust cosine similarity utilities exported

### Architecture
- **Phase 1**: JS → TypeScript (13 files, strict mode, zero regression)
- **Phase 2**: KV-Cache integration (search history, hot files, delta re-indexing)
- **Phase 3**: Rust hot paths (napi-rs, rayon, SIMD-ready)
- **Phase 4**: Production release (this release)

### Fallback Guarantee
- All Rust functions gracefully fall back to TypeScript if native module unavailable
- Zero crashes on any platform — `getNative() ?? tsImplementation()`

---

## [3.2.1] — Previous Release

- Pure JavaScript implementation
- BM25 search + 4-layer context assembly
- 104 tests, all PASS
- Ollama semantic search (optional)
