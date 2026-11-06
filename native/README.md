# Arachne Native — Rust Hot Paths

Optional Rust napi-rs addon. Active search uses independent BM25 instances and a checked API version. Source discovery, chunking and scoped vectors use TypeScript.

Build with `cargo +1.98.0 build --release --locked --manifest-path native/Cargo.toml --jobs 2`. Copy the resulting shared library to `native/arachne-native.node`. Windows produces `native/target/release/arachne_native.dll`, Linux produces `libarachne_native.so`, and macOS produces `libarachne_native.dylib` in that release directory.

Generated binaries are excluded from source control. The release package uses TypeScript search. A manually installed addon must match the source/API and target architecture.
