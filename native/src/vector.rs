// Finite, scale-normalized cosine similarity avoids overflow and underflow.
use napi::bindgen_prelude::*;
use napi_derive::napi;

fn validate(values: &[f64]) -> Result<()> {
    if values.len() > 8192 || values.iter().any(|value| !value.is_finite()) {
        return Err(Error::from_reason(
            "Vectors require at most 8192 finite values",
        ));
    }
    Ok(())
}

fn similarity(left: &[f64], right: &[f64]) -> Result<f64> {
    validate(left)?;
    validate(right)?;
    if left.len() != right.len() || left.is_empty() {
        return Ok(0.0);
    }
    let left_scale = left
        .iter()
        .fold(0.0_f64, |scale, value| scale.max(value.abs()));
    let right_scale = right
        .iter()
        .fold(0.0_f64, |scale, value| scale.max(value.abs()));
    if left_scale == 0.0 || right_scale == 0.0 {
        return Ok(0.0);
    }
    let (mut dot, mut left_norm, mut right_norm) = (0.0, 0.0, 0.0);
    for (left, right) in left.iter().zip(right) {
        let a = left / left_scale;
        let b = right / right_scale;
        dot += a * b;
        left_norm += a * a;
        right_norm += b * b;
    }
    Ok((dot / (left_norm.sqrt() * right_norm.sqrt())).clamp(-1.0, 1.0))
}

#[napi]
pub fn cosine_similarity(a: Float64Array, b: Float64Array) -> Result<f64> {
    similarity(&a, &b)
}

#[napi(object)]
pub struct VectorHit {
    pub index: i64,
    pub similarity: f64,
}

#[napi]
pub fn batch_cosine_similarity(
    query: Float64Array,
    candidates: Vec<Float64Array>,
    top_k: i64,
) -> Result<Vec<VectorHit>> {
    if !(0..=10_000).contains(&top_k) || candidates.len() > 100_000 {
        return Err(Error::from_reason("Invalid vector batch limits"));
    }
    validate(&query)?;
    if top_k == 0 || query.is_empty() || query.iter().all(|value| *value == 0.0) {
        return Ok(vec![]);
    }
    let values: usize = candidates.iter().map(|candidate| candidate.len()).sum();
    if values > 8 * 1024 * 1024 {
        return Err(Error::from_reason("Vector batch exceeds 64 MiB"));
    }
    let mut hits = Vec::new();
    for (index, candidate) in candidates.iter().enumerate() {
        validate(candidate)?;
        if candidate.len() != query.len() || candidate.iter().all(|value| *value == 0.0) {
            continue;
        }
        hits.push(VectorHit {
            index: index as i64,
            similarity: similarity(&query, candidate)?,
        });
    }
    hits.sort_by(|left, right| {
        right
            .similarity
            .total_cmp(&left.similarity)
            .then(left.index.cmp(&right.index))
    });
    hits.truncate(top_k as usize);
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cosine_is_finite_across_extreme_magnitudes() {
        assert!((similarity(&[1e308, 1e308], &[1e308, 1e308]).unwrap() - 1.0).abs() < 1e-12);
        assert!((similarity(&[1e-320, 1e-320], &[1e-320, 1e-320]).unwrap() - 1.0).abs() < 1e-12);
        assert_eq!(similarity(&[1.0], &[-1.0]).unwrap(), -1.0);
        assert_eq!(similarity(&[], &[]).unwrap(), 0.0);
        assert_eq!(similarity(&[0.0], &[1.0]).unwrap(), 0.0);
        assert!(similarity(&[f64::NAN], &[1.0]).is_err());
        assert!(similarity(&[f64::INFINITY], &[1.0]).is_err());
    }
}
