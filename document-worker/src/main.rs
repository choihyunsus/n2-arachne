// Standalone document parser with OS memory and wall-clock limits.
// Extraction and memory-limit code are adapted from N2-Daebung under the included MIT license.
use std::io::Write;
use std::path::PathBuf;
mod documents;
mod limits;
mod office_xml;
mod spreadsheet;
type DynResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;
const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;

fn run() -> DynResult<String> {
    let mut args = std::env::args_os().skip(1);
    let root =
        PathBuf::from(args.next().ok_or("Usage: n2-arachne-doc ROOT FILE")?).canonicalize()?;
    let filename = PathBuf::from(args.next().ok_or("Document path is required")?).canonicalize()?;
    if args.next().is_some() {
        return Err("Expected one root and one document path".into());
    }
    if !root.is_dir() || !filename.starts_with(&root) || !filename.is_file() {
        return Err("Document must be a regular file inside its source root".into());
    }
    let text = documents::extract_text(&filename)?;
    if text.len() > MAX_TEXT_BYTES {
        return Err("Extracted text exceeds 8 MiB".into());
    }
    Ok(text)
}

fn main() {
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(20));
        std::process::exit(124);
    });
    let guard = limits::memory_guard();
    let result = match &guard {
        Ok(_) => run(),
        Err(error) => Err(error.to_string().into()),
    };
    let (status, payload) = match result {
        Ok(text) => (0, serde_json::to_vec(&text)),
        Err(error) => (
            1,
            serde_json::to_vec(&serde_json::json!({ "error": error.to_string() })),
        ),
    };
    match payload {
        Ok(bytes) => {
            if std::io::stdout().write_all(&bytes).is_err() || std::io::stdout().flush().is_err() {
                std::process::exit(1);
            }
            std::process::exit(status);
        }
        Err(_) => std::process::exit(1),
    }
}
