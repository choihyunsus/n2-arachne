// SIMD-ready cosine similarity for vector search
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Compute cosine similarity between two float vectors.
/// Returns value in [-1, 1] range. Returns 0 for empty/zero vectors.
#[napi]
pub fn cosine_similarity(a: Float64Array, b: Float64Array) -> f64 {
    let a_slice: &[f64] = &a;
    let b_slice: &[f64] = &b;

    if a_slice.len() != b_slice.len() || a_slice.is_empty() {
        return 0.0;
    }

    let (dot, norm_a, norm_b) = dot_and_norms(a_slice, b_slice);

    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }

    dot / (norm_a.sqrt() * norm_b.sqrt())
}

/// Batch cosine similarity: compare one query vector against many candidates.
/// Returns array of (index, similarity) sorted by similarity descending.
#[napi(object)]
pub struct VectorHit {
    /// Index in the candidates array
    pub index: i64,
    /// Cosine similarity score
    pub similarity: f64,
}

#[napi]
pub fn batch_cosine_similarity(
    query: Float64Array,
    candidates: Vec<Float64Array>,
    top_k: i64,
) -> Vec<VectorHit> {
    let q: &[f64] = &query;
    if q.is_empty() {
        return vec![];
    }

    let top_k = top_k as usize;

    // Pre-compute query norm
    let q_norm_sq: f64 = q.iter().map(|x| x * x).sum();
    if q_norm_sq == 0.0 {
        return vec![];
    }
    let q_norm = q_norm_sq.sqrt();

    let mut hits: Vec<VectorHit> = candidates
        .iter()
        .enumerate()
        .filter_map(|(i, c)| {
            let c_slice: &[f64] = c;
            if c_slice.len() != q.len() {
                return None;
            }

            let (dot, _, c_norm_sq) = dot_and_norms(q, c_slice);
            if c_norm_sq == 0.0 {
                return None;
            }

            let similarity = dot / (q_norm * c_norm_sq.sqrt());
            Some(VectorHit {
                index: i as i64,
                similarity,
            })
        })
        .collect();

    hits.sort_by(|a, b| {
        b.similarity
            .partial_cmp(&a.similarity)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    hits.truncate(top_k);
    hits
}

/// Compute dot product and squared norms in a single pass
#[inline]
fn dot_and_norms(a: &[f64], b: &[f64]) -> (f64, f64, f64) {
    let mut dot = 0.0f64;
    let mut norm_a = 0.0f64;
    let mut norm_b = 0.0f64;

    for i in 0..a.len() {
        let ai = a[i];
        let bi = b[i];
        dot += ai * bi;
        norm_a += ai * ai;
        norm_b += bi * bi;
    }

    (dot, norm_a, norm_b)
}
