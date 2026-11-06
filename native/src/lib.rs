// napi-rs entry point — exports all Rust hot path functions to Node.js
mod bm25;
mod chunker;
mod indexer;
mod vector;

pub use bm25::*;
pub use chunker::*;
pub use indexer::*;
pub use vector::*;

#[napi_derive::napi]
pub fn api_version() -> u32 {
    1
}
