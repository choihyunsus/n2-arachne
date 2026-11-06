// Bounded structural helpers for source chunking. The TypeScript chunker owns language patterns.
use napi::{Error, Result};
use napi_derive::napi;

const MAX_SOURCE_BYTES: usize = 10 * 1024 * 1024;

#[napi]
pub fn estimate_tokens_rs(text: String, multiplier: f64) -> Result<i64> {
    if !multiplier.is_finite()
        || !(0.25..=16.0).contains(&multiplier)
        || text.len() > MAX_SOURCE_BYTES
    {
        return Err(Error::from_reason(
            "Invalid token multiplier or oversized source",
        ));
    }
    Ok((text.encode_utf16().count() as f64 / multiplier).ceil() as i64)
}

fn validate_lines(lines: &[String]) -> Result<()> {
    if lines.len() > 1_000_000 || lines.iter().map(String::len).sum::<usize>() > MAX_SOURCE_BYTES {
        return Err(Error::from_reason(
            "Source line collection exceeds scanner limits",
        ));
    }
    Ok(())
}

#[derive(Default)]
struct BraceState {
    depth: i32,
    found: bool,
    quote: Option<char>,
    comment: bool,
}

impl BraceState {
    fn consume(&mut self, line: &str) -> bool {
        let mut chars = line.chars().peekable();
        while let Some(ch) = chars.next() {
            if self.comment {
                if ch == '*' && chars.peek() == Some(&'/') {
                    chars.next();
                    self.comment = false;
                }
            } else if let Some(quote) = self.quote {
                if ch == '\\' {
                    chars.next();
                } else if ch == quote {
                    self.quote = None;
                }
            } else if ch == '/' && chars.peek() == Some(&'/') {
                break;
            } else if ch == '/' && chars.peek() == Some(&'*') {
                chars.next();
                self.comment = true;
            } else if ['"', '\'', '`'].contains(&ch) {
                self.quote = Some(ch);
            } else if ch == '{' {
                self.depth += 1;
                self.found = true;
            } else if ch == '}' {
                self.depth -= 1;
            } else if ch == ';' && !self.found {
                return true;
            }
        }
        self.found && self.depth <= 0
    }
}

#[napi]
pub fn find_block_end_rs(lines: Vec<String>, start_idx: i64) -> Result<i64> {
    validate_lines(&lines)?;
    if start_idx < 0 || start_idx as usize >= lines.len() {
        return Ok(-1);
    }
    let mut state = BraceState::default();
    for (index, line) in lines.iter().enumerate().skip(start_idx as usize) {
        if state.consume(line) {
            return Ok(index as i64);
        }
    }
    Ok((lines.len() - 1) as i64)
}

#[napi]
pub fn find_indent_end_rs(lines: Vec<String>, start_idx: i64) -> Result<i64> {
    validate_lines(&lines)?;
    if start_idx < 0 || start_idx as usize >= lines.len() {
        return Ok(-1);
    }
    let start = start_idx as usize;
    let base_indent = indentation(&lines[start]);
    for (index, line) in lines.iter().enumerate().skip(start + 1) {
        if line.trim().is_empty() {
            continue;
        }
        if indentation(line) <= base_indent {
            return Ok((index - 1) as i64);
        }
    }
    Ok((lines.len() - 1) as i64)
}

fn indentation(line: &str) -> usize {
    line.chars()
        .take_while(|character| character.is_whitespace())
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checks_empty_input_unicode_and_multiplier() {
        assert_eq!(find_block_end_rs(vec![], 0).unwrap(), -1);
        assert_eq!(find_indent_end_rs(vec!["x".into()], -1).unwrap(), -1);
        assert_eq!(estimate_tokens_rs("😀".into(), 1.0).unwrap(), 2);
        assert!(estimate_tokens_rs("text".into(), f64::INFINITY).is_err());
    }
    #[test]
    fn quoted_and_commented_braces_do_not_end_blocks() {
        let lines = [
            "function example() {",
            "const quoted = \"}\";",
            "/* } */",
            "return `}`;",
            "}",
        ];
        assert_eq!(
            find_block_end_rs(lines.map(str::to_string).to_vec(), 0).unwrap(),
            4
        );
    }
}
