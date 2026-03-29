// BM25 search engine — optimized Rust implementation
// Optimizations: pre-lowercase, single-pass DF, rayon parallel scoring, memchr SIMD
// Cached mode: init once, search with zero FFI marshaling
use napi_derive::napi;
use rayon::prelude::*;
use std::sync::{Mutex, OnceLock};

/// A single search result with score
#[napi(object)]
pub struct Bm25Hit {
    /// Chunk ID from the database
    pub chunk_id: i64,
    /// BM25 relevance score
    pub score: f64,
}

// ── Cached search data (stored in Rust heap, zero JS→Rust copy per search) ─────
struct CachedSearchData {
    ids: Vec<i64>,
    lowered_bytes: Vec<Vec<u8>>,   // Pre-lowercased, as bytes for memchr
    avg_dl: f64,
}

static SEARCH_CACHE: OnceLock<Mutex<CachedSearchData>> = OnceLock::new();

/// Initialize the Rust-side search cache.
/// Call once after loading chunks from DB. Pre-lowercases all text.
/// Subsequent bm25_search_cached() calls use this data with ZERO marshaling.
#[napi]
pub fn bm25_init_store(chunk_ids: Vec<i64>, search_texts: Vec<String>) {
    let n = chunk_ids.len();
    if n == 0 { return; }

    // Pre-lowercase all texts (rayon parallel) and convert to bytes
    let lowered_bytes: Vec<Vec<u8>> = search_texts
        .par_iter()
        .map(|t| t.to_lowercase().into_bytes())
        .collect();

    let avg_dl = lowered_bytes.iter().map(|b| b.len() as f64).sum::<f64>() / n as f64;

    let data = CachedSearchData { ids: chunk_ids, lowered_bytes, avg_dl };

    // Replace or init
    match SEARCH_CACHE.get() {
        Some(mutex) => { *mutex.lock().unwrap() = data; },
        None => { let _ = SEARCH_CACHE.set(Mutex::new(data)); },
    }
}

/// BM25 search using cached data — ZERO JS→Rust string marshaling per call.
/// Only the query string crosses FFI boundary.
#[napi]
pub fn bm25_search_cached(query: String, top_k: i64, k1: f64, b: f64) -> Vec<Bm25Hit> {
    let terms = tokenize(&query);
    if terms.is_empty() { return vec![]; }

    let cache = match SEARCH_CACHE.get() {
        Some(mutex) => mutex.lock().unwrap(),
        None => return vec![],
    };

    let n = cache.ids.len();
    if n == 0 { return vec![]; }
    let top_k = top_k as usize;
    let term_bytes: Vec<&[u8]> = terms.iter().map(|s| s.as_bytes()).collect();

    // Single-pass DF (all terms at once)
    let mut df: Vec<usize> = vec![0; terms.len()];
    for doc_bytes in &cache.lowered_bytes {
        for (ti, tb) in term_bytes.iter().enumerate() {
            if memchr_contains(doc_bytes, tb) {
                df[ti] += 1;
            }
        }
    }

    // Pre-compute IDF
    let idf: Vec<f64> = df
        .iter()
        .map(|&d| ((n as f64 - d as f64 + 0.5) / (d as f64 + 0.5) + 1.0).ln())
        .collect();

    // Parallel scoring via rayon
    let mut scored: Vec<Bm25Hit> = cache.ids
        .par_iter()
        .zip(cache.lowered_bytes.par_iter())
        .filter_map(|(&id, doc_bytes)| {
            let dl = doc_bytes.len() as f64;
            let mut score = 0.0f64;

            for (ti, tb) in term_bytes.iter().enumerate() {
                let tf = memchr_count(doc_bytes, tb) as f64;
                if tf == 0.0 { continue; }
                let numerator = tf * (k1 + 1.0);
                let denominator = tf + k1 * (1.0 - b + b * (dl / cache.avg_dl));
                score += idf[ti] * (numerator / denominator);
            }

            if score > 0.0 { Some(Bm25Hit { chunk_id: id, score }) } else { None }
        })
        .collect();

    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(top_k);
    scored
}

/// BM25 search — original version (receives data per call, for fallback/benchmark)
#[napi]
pub fn bm25_search(
    query: String,
    chunk_ids: Vec<i64>,
    search_texts: Vec<String>,
    top_k: i64,
    k1: f64,
    b: f64,
) -> Vec<Bm25Hit> {
    let terms = tokenize(&query);
    if terms.is_empty() || chunk_ids.is_empty() {
        return vec![];
    }

    let n = chunk_ids.len();
    let top_k = top_k as usize;

    // Pre-lowercase all texts ONCE (rayon parallel)
    let lowered: Vec<String> = search_texts
        .par_iter()
        .map(|t| t.to_lowercase())
        .collect();

    let lowered_bytes: Vec<&[u8]> = lowered.iter().map(|s| s.as_bytes()).collect();
    let term_bytes: Vec<&[u8]> = terms.iter().map(|s| s.as_bytes()).collect();

    // Single-pass DF
    let mut df: Vec<usize> = vec![0; terms.len()];
    for doc_bytes in &lowered_bytes {
        for (ti, tb) in term_bytes.iter().enumerate() {
            if memchr_contains(doc_bytes, tb) {
                df[ti] += 1;
            }
        }
    }

    let idf: Vec<f64> = df
        .iter()
        .map(|&d| ((n as f64 - d as f64 + 0.5) / (d as f64 + 0.5) + 1.0).ln())
        .collect();

    let avg_dl: f64 = lowered.iter().map(|t| t.len() as f64).sum::<f64>() / n as f64;

    let mut scored: Vec<Bm25Hit> = chunk_ids
        .par_iter()
        .zip(lowered_bytes.par_iter())
        .filter_map(|(&id, doc_bytes)| {
            let dl = doc_bytes.len() as f64;
            let mut score = 0.0f64;

            for (ti, tb) in term_bytes.iter().enumerate() {
                let tf = memchr_count(doc_bytes, tb) as f64;
                if tf == 0.0 { continue; }
                let numerator = tf * (k1 + 1.0);
                let denominator = tf + k1 * (1.0 - b + b * (dl / avg_dl));
                score += idf[ti] * (numerator / denominator);
            }

            if score > 0.0 { Some(Bm25Hit { chunk_id: id, score }) } else { None }
        })
        .collect();

    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(top_k);
    scored
}

/// Tokenize query text
fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|t| t.len() >= 2)
        .map(|t| t.to_string())
        .collect()
}

/// SIMD-accelerated substring search using memchr
#[inline]
fn memchr_contains(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || needle.len() > haystack.len() {
        return needle.is_empty();
    }
    let first = needle[0];
    let mut start = 0;
    while let Some(pos) = memchr::memchr(first, &haystack[start..]) {
        let abs_pos = start + pos;
        if abs_pos + needle.len() > haystack.len() { return false; }
        if &haystack[abs_pos..abs_pos + needle.len()] == needle { return true; }
        start = abs_pos + 1;
    }
    false
}

/// SIMD-accelerated non-overlapping occurrence count
#[inline]
fn memchr_count(haystack: &[u8], needle: &[u8]) -> usize {
    if needle.is_empty() || needle.len() > haystack.len() { return 0; }
    let first = needle[0];
    let mut count = 0;
    let mut start = 0;
    while let Some(pos) = memchr::memchr(first, &haystack[start..]) {
        let abs_pos = start + pos;
        if abs_pos + needle.len() > haystack.len() { break; }
        if &haystack[abs_pos..abs_pos + needle.len()] == needle {
            count += 1;
            start = abs_pos + needle.len();
        } else {
            start = abs_pos + 1;
        }
    }
    count
}
