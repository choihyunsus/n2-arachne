// Bounded native file metadata scanner. The main indexer applies Git-style ignore rules in TypeScript.
use napi::{Error, Result};
use napi_derive::napi;
use std::collections::{hash_map::DefaultHasher, HashSet};
use std::hash::Hasher;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Instant;

const MAX_ENTRIES: usize = 100_000;
const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;

#[napi(object)]
pub struct ScannedFile {
    pub path: String,
    pub hash: String,
    pub extension: String,
    pub size: i64,
    pub modified_at: String,
}

#[napi(object)]
pub struct ScanResult {
    pub files: Vec<ScannedFile>,
    pub elapsed_ms: f64,
}

/// Literal ignore substrings retain the native helper's original filtering contract.
/// Files are hashed serially with a 64 KiB read buffer and explicit failure reporting.
#[napi]
pub fn scan_files(
    project_dir: String,
    extensions: Vec<String>,
    ignore_patterns: Vec<String>,
    max_file_size: i64,
) -> Result<ScanResult> {
    if !(0..=MAX_FILE_BYTES as i64).contains(&max_file_size)
        || extensions.len() > 512
        || ignore_patterns.len() > 10_000
    {
        return Err(Error::from_reason("Invalid scanner limits"));
    }
    if extensions
        .iter()
        .chain(ignore_patterns.iter())
        .any(|value| value.len() > 4096)
    {
        return Err(Error::from_reason("Scanner filter is too long"));
    }
    let start = Instant::now();
    let root = std::fs::canonicalize(project_dir)?;
    if !root.is_dir() {
        return Err(Error::from_reason("Scan root must be a directory"));
    }
    let extensions = extensions
        .into_iter()
        .map(|value| value.to_lowercase())
        .collect();
    let mut scanner = Scanner {
        root,
        extensions,
        ignored: ignore_patterns,
        maximum: max_file_size as u64,
        start,
        visited: 0,
        files: Vec::new(),
    };
    scanner.walk()?;
    scanner
        .files
        .sort_by(|left, right| left.path.cmp(&right.path));
    Ok(ScanResult {
        files: scanner.files,
        elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
    })
}

struct Scanner {
    root: PathBuf,
    extensions: HashSet<String>,
    ignored: Vec<String>,
    maximum: u64,
    start: Instant,
    visited: usize,
    files: Vec<ScannedFile>,
}

impl Scanner {
    fn walk(&mut self) -> Result<()> {
        let mut pending = vec![(self.root.clone(), 0)];
        while let Some((directory, depth)) = pending.pop() {
            for entry in std::fs::read_dir(directory)? {
                self.visited += 1;
                if self.visited > MAX_ENTRIES || self.start.elapsed().as_secs() >= 30 {
                    return Err(Error::from_reason("Native scan resource limit reached"));
                }
                let entry = entry?;
                let kind = entry.file_type()?;
                if kind.is_symlink() {
                    continue;
                }
                let filename = entry.path();
                let relative = relative_name(&self.root, &filename)?;
                if self
                    .ignored
                    .iter()
                    .any(|pattern| relative.contains(pattern))
                {
                    continue;
                }
                if kind.is_dir() {
                    if is_skippable_dir(entry.file_name().to_str().unwrap_or("")) {
                        continue;
                    }
                    if depth >= 63 {
                        return Err(Error::from_reason(
                            "Native scan directory depth limit reached",
                        ));
                    }
                    pending.push((filename, depth + 1));
                } else if kind.is_file() && self.extensions.contains(&extension(&filename)) {
                    self.files
                        .push(hash_file(&self.root, &filename, self.maximum)?);
                }
            }
        }
        Ok(())
    }
}

fn relative_name(root: &Path, filename: &Path) -> Result<String> {
    let relative = filename
        .strip_prefix(root)
        .map_err(|_| Error::from_reason("Source escaped scan root"))?;
    let value = relative
        .to_str()
        .ok_or_else(|| Error::from_reason("Source path is not valid Unicode"))?;
    Ok(value.replace('\\', "/"))
}

fn extension(filename: &Path) -> String {
    filename
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase()
}

fn hash_file(root: &Path, filename: &Path, maximum: u64) -> Result<ScannedFile> {
    let resolved = std::fs::canonicalize(filename)?;
    relative_name(root, &resolved)?;
    let mut file = std::fs::File::open(&resolved)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > maximum {
        return Err(Error::from_reason("Source exceeds native scan file limit"));
    }
    let mut hash = DefaultHasher::new();
    let mut buffer = [0_u8; 65536];
    let mut size = 0_u64;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        size += count as u64;
        if size > maximum {
            return Err(Error::from_reason(
                "Source grew beyond native scan file limit",
            ));
        }
        hash.write(&buffer[..count]);
    }
    let first = hash.finish();
    hash.write_u64(size);
    let fingerprint = format!("{:08x}{:08x}", first as u32, hash.finish() as u32);
    let modified = metadata
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| Error::from_reason("File timestamp precedes Unix epoch"))?;
    Ok(ScannedFile {
        path: relative_name(root, filename)?,
        hash: fingerprint,
        extension: extension(filename),
        size: size as i64,
        modified_at: chrono_lite_iso(modified.as_secs()),
    })
}

fn chrono_lite_iso(unix_secs: u64) -> String {
    let (year, month, day) = days_to_ymd(unix_secs / 86400);
    let remaining = unix_secs % 86400;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year,
        month,
        day,
        remaining / 3600,
        remaining % 3600 / 60,
        remaining % 60
    )
}

fn days_to_ymd(days: u64) -> (u64, u64, u64) {
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn is_skippable_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules"
            | ".git"
            | ".hg"
            | ".svn"
            | "dist"
            | "build"
            | "target"
            | ".next"
            | "__pycache__"
            | ".venv"
            | "venv"
            | ".idea"
            | ".vscode"
            | "coverage"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checks_limits_and_dates() {
        assert!(scan_files(".".into(), vec![], vec![], -1).is_err());
        assert_eq!(chrono_lite_iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(chrono_lite_iso(1709164800), "2024-02-29T00:00:00Z");
    }
    #[test]
    fn includes_empty_files_and_reports_oversized_files() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "arachne-native-test-{}-{suffix}",
            std::process::id()
        ));
        std::fs::create_dir(&root).unwrap();
        {
            std::fs::write(root.join("empty.TS"), "").unwrap();
            let scan =
                scan_files(root.to_string_lossy().into(), vec!["ts".into()], vec![], 0).unwrap();
            assert_eq!(scan.files.len(), 1);
            assert_eq!(scan.files[0].size, 0);
            std::fs::write(root.join("large.ts"), "too large").unwrap();
            assert!(
                scan_files(root.to_string_lossy().into(), vec!["ts".into()], vec![], 1).is_err()
            );
        }
        std::fs::remove_dir_all(&root).unwrap();
    }
}
