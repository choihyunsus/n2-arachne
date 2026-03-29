// Language-aware code chunking in Rust
use napi_derive::napi;

/// A single code chunk extracted from source
#[napi(object)]
pub struct RustChunk {
    /// Chunk type (function, class, method, module, etc.)
    pub chunk_type: String,
    /// Name of the chunk (function/class name, or null)
    pub name: Option<String>,
    /// 1-indexed start line
    pub start_line: i64,
    /// 1-indexed end line
    pub end_line: i64,
    /// Chunk content
    pub content: String,
    /// Estimated token count
    pub token_count: i64,
}

/// Fast token estimation (~3.5 chars per token for English code)
#[napi]
pub fn estimate_tokens_rs(text: String, multiplier: f64) -> i64 {
    if text.is_empty() {
        return 0;
    }
    let m = if multiplier > 0.0 { multiplier } else { 3.5 };
    (text.len() as f64 / m).ceil() as i64
}

/// Find brace-matched block end starting from a given line index
#[napi]
pub fn find_block_end_rs(lines: Vec<String>, start_idx: i64) -> i64 {
    let start = start_idx as usize;
    let mut depth: i32 = 0;
    let mut found = false;

    for i in start..lines.len() {
        let line = &lines[i];
        for ch in line.chars() {
            if ch == '{' {
                depth += 1;
                found = true;
            }
            if ch == '}' {
                depth -= 1;
            }
        }
        if found && depth <= 0 {
            return i as i64;
        }
    }
    (lines.len() - 1) as i64
}

/// Find indentation-based block end (for Python)
#[napi]
pub fn find_indent_end_rs(lines: Vec<String>, start_idx: i64) -> i64 {
    let start = start_idx as usize;
    if start >= lines.len().saturating_sub(1) {
        return start as i64;
    }

    let base_indent = count_leading_spaces(&lines[start]);

    for i in (start + 1)..lines.len() {
        let line = &lines[i];
        if line.trim().is_empty() {
            continue;
        }
        let indent = count_leading_spaces(line);
        if indent <= base_indent {
            return (i - 1) as i64;
        }
    }
    (lines.len() - 1) as i64
}

/// Count leading whitespace characters
fn count_leading_spaces(s: &str) -> usize {
    s.chars().take_while(|c| c.is_whitespace()).count()
}
