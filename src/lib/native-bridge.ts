// Native Rust bridge — loads .node binary with TS fallback
// If the Rust binary is unavailable, all functions silently fall back to JS implementations
import * as path from 'path';

/** Shape of the native Rust module (mirrors napi-rs exports) */
interface NativeModule {
  scanFiles(projectDir: string, extensions: string[], ignorePatterns: string[], maxFileSize: number): {
    files: Array<{ path: string; hash: string; extension: string; size: number; modifiedAt: string }>;
    elapsedMs: number;
  };
  bm25Search(query: string, chunkIds: number[], searchTexts: string[], topK: number, k1: number, b: number): Array<{
    chunkId: number;
    score: number;
  }>;
  /** Cache chunk data in Rust heap (call once). Zero marshaling on subsequent searches. */
  bm25InitStore(chunkIds: number[], searchTexts: string[]): void;
  /** Search using cached data. Only query crosses FFI boundary. */
  bm25SearchCached(query: string, topK: number, k1: number, b: number): Array<{
    chunkId: number;
    score: number;
  }>;
  cosineSimilarity(a: Float64Array, b: Float64Array): number;

  estimateTokensRs(text: string, multiplier: number): number;
  findBlockEndRs(lines: string[], startIdx: number): number;
  findIndentEndRs(lines: string[], startIdx: number): number;
}

/** Whether the native module loaded successfully */
let _native: NativeModule | null = null;
let _loadAttempted = false;

/**
 * Try to load the native Rust module.
 * Returns null if unavailable (compile not done, wrong platform, etc.)
 */
function tryLoadNative(): NativeModule | null {
  if (_loadAttempted) return _native;
  _loadAttempted = true;

  const candidates = [
    // napi-rs default output location
    path.resolve(__dirname, '../../native/arachne-native.node'),
    // Windows release build output
    path.resolve(__dirname, '../../native/target/release/arachne_native.dll'),
    // Platform-specific napi output
    path.resolve(__dirname, '../../arachne-native.win32-x64-msvc.node'),
  ];

  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(candidate) as NativeModule;
      if (typeof mod.bm25Search === 'function') {
        _native = mod;
        console.error(`[n2-arachne] 🦀 Native Rust module loaded: ${candidate}`);
        return _native;
      }
    } catch {
      // Not available at this path, try next
    }
  }

  console.error('[n2-arachne] 📦 Native module unavailable — using TypeScript fallback');
  return null;
}

/**
 * Check if the native Rust module is available
 */
export function isNativeAvailable(): boolean {
  return tryLoadNative() !== null;
}

/**
 * Get the native module (null if unavailable)
 */
export function getNative(): NativeModule | null {
  return tryLoadNative();
}

export type { NativeModule };
