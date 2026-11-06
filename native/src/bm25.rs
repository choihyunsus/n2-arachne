// Instance-owned BM25 caches with checked inputs and deterministic ranking.
use napi::{Error, Result};
use napi_derive::napi;
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

const MAX_CACHE_BYTES: usize = 64 * 1024 * 1024;
const MAX_RECORDS: usize = 1_000_000;

#[napi(object)]
pub struct Bm25Hit {
    pub chunk_id: i64,
    pub score: f64,
}

struct SearchData {
    ids: Vec<i64>,
    texts: Vec<String>,
    lengths: Vec<f64>,
    average_length: f64,
}

impl SearchData {
    fn new(ids: Vec<i64>, texts: Vec<String>) -> Result<Self> {
        if ids.len() != texts.len() || ids.len() > MAX_RECORDS {
            return Err(Error::from_reason("Invalid search cache record count"));
        }
        if ids.iter().any(|id| *id < 0 || *id > 9_007_199_254_740_991)
            || ids.iter().collect::<HashSet<_>>().len() != ids.len()
        {
            return Err(Error::from_reason(
                "Search IDs must be unique nonnegative safe integers",
            ));
        }
        if texts.iter().map(String::len).sum::<usize>() > MAX_CACHE_BYTES {
            return Err(Error::from_reason("Search cache exceeds 64 MiB"));
        }
        let texts: Vec<String> = texts.into_iter().map(|text| text.to_lowercase()).collect();
        let lengths: Vec<f64> = texts
            .iter()
            .map(|text| text.encode_utf16().count() as f64)
            .collect();
        let average_length = lengths.iter().sum::<f64>() / lengths.len().max(1) as f64;
        Ok(Self {
            ids,
            texts,
            lengths,
            average_length,
        })
    }

    fn search(&self, query: &str, top_k: i64, k1: f64, b: f64) -> Result<Vec<Bm25Hit>> {
        if !(0..=10000).contains(&top_k)
            || !k1.is_finite()
            || k1 <= 0.0
            || k1 > 10.0
            || !b.is_finite()
            || !(0.0..=1.0).contains(&b)
            || query.encode_utf16().count() > 4096
        {
            return Err(Error::from_reason(
                "Invalid BM25 query, limit or score parameters",
            ));
        }
        let lower = query.to_lowercase();
        let terms: Vec<&str> = lower
            .split(|character: char| !character.is_alphanumeric() && character != '_')
            .filter(|term| term.encode_utf16().count() >= 2)
            .collect();
        if terms.is_empty() || top_k == 0 || self.average_length == 0.0 {
            return Ok(Vec::new());
        }
        let documents = self.ids.len() as f64;
        let idf: Vec<f64> = terms
            .iter()
            .map(|term| {
                let matching = self.texts.iter().filter(|text| text.contains(term)).count() as f64;
                ((documents - matching + 0.5) / (matching + 0.5) + 1.0).ln()
            })
            .collect();
        let mut results = Vec::new();
        for (index, text) in self.texts.iter().enumerate() {
            let mut score = 0.0;
            for (term, idf) in terms.iter().zip(&idf) {
                let frequency = text.matches(term).count() as f64;
                if frequency > 0.0 {
                    score += idf * frequency * (k1 + 1.0)
                        / (frequency
                            + k1 * (1.0 - b + b * self.lengths[index] / self.average_length));
                }
            }
            if score > 0.0 {
                results.push(Bm25Hit {
                    chunk_id: self.ids[index],
                    score,
                });
            }
        }
        results.sort_by(|left, right| {
            right
                .score
                .total_cmp(&left.score)
                .then(left.chunk_id.cmp(&right.chunk_id))
        });
        results.truncate(top_k as usize);
        Ok(results)
    }
}

#[napi]
pub struct Bm25Index {
    data: SearchData,
}

#[napi]
impl Bm25Index {
    #[napi(constructor)]
    pub fn new(chunk_ids: Vec<i64>, search_texts: Vec<String>) -> Result<Self> {
        Ok(Self {
            data: SearchData::new(chunk_ids, search_texts)?,
        })
    }

    #[napi]
    pub fn search(&self, query: String, top_k: i64, k1: f64, b: f64) -> Result<Vec<Bm25Hit>> {
        self.data.search(&query, top_k, k1, b)
    }
}

#[napi]
pub fn bm25_search(
    query: String,
    chunk_ids: Vec<i64>,
    search_texts: Vec<String>,
    top_k: i64,
    k1: f64,
    b: f64,
) -> Result<Vec<Bm25Hit>> {
    SearchData::new(chunk_ids, search_texts)?.search(&query, top_k, k1, b)
}

// Retained low-level compatibility exports. The MCP/library search uses Bm25Index instances.
static LEGACY_CACHE: OnceLock<Mutex<Option<SearchData>>> = OnceLock::new();

#[napi]
pub fn bm25_init_store(chunk_ids: Vec<i64>, search_texts: Vec<String>) -> Result<()> {
    let data = SearchData::new(chunk_ids, search_texts)?;
    let mut cache = LEGACY_CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| Error::from_reason("Legacy cache lock is poisoned"))?;
    *cache = Some(data);
    Ok(())
}

#[napi]
pub fn bm25_search_cached(query: String, top_k: i64, k1: f64, b: f64) -> Result<Vec<Bm25Hit>> {
    let cache = LEGACY_CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| Error::from_reason("Legacy cache lock is poisoned"))?;
    match &*cache {
        Some(data) => data.search(&query, top_k, k1, b),
        None => Ok(Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn indices_are_independent_and_rank_ties_by_id() {
        let alpha = SearchData::new(vec![2, 1], vec!["alpha".into(), "alpha".into()]).unwrap();
        let beta = SearchData::new(vec![3], vec!["beta".into()]).unwrap();
        assert_eq!(alpha.search("alpha", 10, 1.2, 0.75).unwrap()[0].chunk_id, 1);
        assert_eq!(beta.search("beta", 10, 1.2, 0.75).unwrap()[0].chunk_id, 3);
        assert_eq!(alpha.search("alpha", 10, 1.2, 0.75).unwrap().len(), 2);
    }
    #[test]
    fn rejects_invalid_inputs_and_clears_empty_cache() {
        assert!(SearchData::new(vec![1], vec![]).is_err());
        assert!(SearchData::new(vec![1, 1], vec!["a".into(), "b".into()]).is_err());
        let index = SearchData::new(vec![], vec![]).unwrap();
        assert!(index.search("query", -1, 1.2, 0.75).is_err());
        assert!(index.search("query", 1, f64::NAN, 0.75).is_err());
        assert!(index.search("query", 1, 1.2, 0.75).unwrap().is_empty());
    }
}
