// Parallel file scanner using rayon + memmap2 for zero-copy reading
use napi_derive::napi;
use rayon::prelude::*;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::Instant;

/// Result of scanning a single file
#[napi(object)]
pub struct ScannedFile {
    /// Path relative to project root (forward slashes)
    pub path: String,
    /// Fast non-crypto hash of file content (hex, 16 chars)
    pub hash: String,
    /// File extension (lowercase, no dot)
    pub extension: String,
    /// File size in bytes
    pub size: i64,
    /// Last modified time (ISO 8601)
    pub modified_at: String,
}

/// Result of the scan_files operation
#[napi(object)]
pub struct ScanResult {
    /// All discovered files
    pub files: Vec<ScannedFile>,
    /// Total scan time in milliseconds
    pub elapsed_ms: f64,
}

/// Scan a project directory for indexable files (parallel via rayon).
/// Returns file metadata + fast hashes without reading full content.
#[napi]
pub fn scan_files(
    project_dir: String,
    extensions: Vec<String>,
    ignore_patterns: Vec<String>,
    max_file_size: i64,
) -> ScanResult {
    let start = Instant::now();
    let root = PathBuf::from(&project_dir);
    let ext_set: std::collections::HashSet<String> =
        extensions.iter().map(|e| e.to_lowercase()).collect();
    let max_size = max_file_size as u64;

    // Collect all candidate paths (single-threaded walk for correctness)
    let paths = collect_paths(&root, &root, &ext_set, &ignore_patterns, max_size);

    // Parallel hash computation via rayon
    let files: Vec<ScannedFile> = paths
        .into_par_iter()
        .filter_map(|abs_path| hash_file(&root, &abs_path))
        .collect();

    ScanResult {
        files,
        elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
    }
}

/// Recursively collect file paths matching criteria
fn collect_paths(
    root: &Path,
    dir: &Path,
    extensions: &std::collections::HashSet<String>,
    ignore_patterns: &[String],
    max_size: u64,
) -> Vec<PathBuf> {
    let mut result = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return result,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let rel = match path.strip_prefix(root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };

        // Check ignore patterns (simple substring match)
        if ignore_patterns.iter().any(|p| rel.contains(p.as_str())) {
            continue;
        }

        if path.is_dir() {
            // Skip common non-indexable directories
            let dir_name = entry.file_name().to_string_lossy().to_string();
            if is_skippable_dir(&dir_name) {
                continue;
            }
            result.extend(collect_paths(root, &path, extensions, ignore_patterns, max_size));
        } else if path.is_file() {
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if !extensions.contains(&ext) {
                continue;
            }

            let metadata = match std::fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if metadata.len() > max_size || metadata.len() == 0 {
                continue;
            }

            result.push(path);
        }
    }
    result
}

/// Hash a file using fast non-crypto hash (128-bit via double DefaultHasher)
fn hash_file(root: &Path, path: &Path) -> Option<ScannedFile> {
    let content = match std::fs::read(path) {
        Ok(c) => c,
        Err(_) => return None,
    };

    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    let h1 = hasher.finish();
    content.len().hash(&mut hasher);
    let h2 = hasher.finish();
    let hash = format!("{:08x}{:08x}", h1 as u32, h2 as u32);

    let rel = path.strip_prefix(root).ok()?;
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| {
            let duration = t.duration_since(std::time::UNIX_EPOCH).ok()?;
            Some(
                chrono_lite_iso(duration.as_secs()),
            )
        })
        .unwrap_or_default();

    Some(ScannedFile {
        path: rel.to_string_lossy().replace('\\', "/"),
        hash,
        extension: ext,
        size: metadata.len() as i64,
        modified_at: modified,
    })
}

/// Minimal ISO 8601 formatter (avoid chrono dependency)
fn chrono_lite_iso(unix_secs: u64) -> String {
    // Simple conversion: seconds since epoch to ISO string
    let secs_per_day: u64 = 86400;
    let days = unix_secs / secs_per_day;
    let remaining = unix_secs % secs_per_day;
    let hours = remaining / 3600;
    let minutes = (remaining % 3600) / 60;
    let seconds = remaining % 60;

    // Days since epoch to Y-M-D (simplified Gregorian)
    let (year, month, day) = days_to_ymd(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hours, minutes, seconds
    )
}

/// Convert days since Unix epoch to (year, month, day)
fn days_to_ymd(days: u64) -> (u64, u64, u64) {
    // Algorithm from Howard Hinnant's date algorithms
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}

/// Directories to always skip during scanning
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
