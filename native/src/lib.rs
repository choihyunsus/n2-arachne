// napi-rs entry point — exports all Rust hot path functions to Node.js
mod indexer;
mod bm25;
mod chunker;
mod vector;

pub use indexer::*;
pub use bm25::*;
pub use chunker::*;
pub use vector::*;
