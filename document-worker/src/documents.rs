// N2-Daebung: Arachne -- Document text extraction.
//
// Converts binary office/doc formats into plain text so the existing
// indexer pipeline can chunk + embed them. Supported formats:
//   PDF   via lopdf (pure Rust; supplied MIT notice)
//   DOCX  via zip + quick-xml (walks word/document.xml)
//   XLSX  via zip + quick-xml (sharedStrings + all worksheets)
//   PPTX  via zip + quick-xml (all ppt/slides/slide*.xml files)

use std::io::Read;
use std::path::Path;

use quick_xml::events::Event;

use crate::DynResult;

#[cfg(test)]
#[path = "document_tests.rs"]
mod tests;

const MAX_DOCUMENT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_XML_BYTES: u64 = 8 * 1024 * 1024;
const MAX_EXPANDED_BYTES: usize = 32 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
const MAX_ZIP_ENTRIES: usize = 4096;
pub(super) const MAX_XML_DEPTH: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocKind {
    Pdf,
    Docx,
    Xlsx,
    Pptx,
}

impl DocKind {
    pub fn from_path(path: &Path) -> Option<Self> {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())?;
        match ext.as_str() {
            "pdf" => Some(Self::Pdf),
            "docx" => Some(Self::Docx),
            "xlsx" => Some(Self::Xlsx),
            "pptx" => Some(Self::Pptx),
            _ => None,
        }
    }
}

/// Extract plain text from a supported document.
pub fn extract_text(path: &Path) -> DynResult<String> {
    if path.metadata()?.len() > MAX_DOCUMENT_BYTES {
        return Err("Document exceeds the 32 MiB input limit".into());
    }
    let Some(kind) = DocKind::from_path(path) else {
        return Err(format!("doc_extract: unknown extension for {}", path.display()).into());
    };
    match kind {
        DocKind::Pdf => extract_pdf_content(path),
        DocKind::Docx => extract_docx(path),
        DocKind::Xlsx => extract_xlsx(path),
        DocKind::Pptx => extract_pptx(path),
    }
}

// -- PDF --

pub(super) fn extract_pdf_content(path: &Path) -> DynResult<String> {
    let document = lopdf::Document::load_with_options(
        path,
        lopdf::LoadOptions::with_max_decompressed_size(MAX_EXPANDED_BYTES),
    )
    .map_err(|e| format!("PDF could not be opened ({}): {e}", path.display()))?;
    if document.is_encrypted() {
        return Err("Password-protected PDF: unlock the document before importing".into());
    }
    let pages = document.get_pages();
    if pages.is_empty() || pages.len() > 2000 {
        return Err("PDF must contain between 1 and 2000 pages".into());
    }
    let mut text = String::new();
    for page in pages.keys() {
        let content = document
            .extract_text_with_limit(&[*page], MAX_EXPANDED_BYTES)
            .map_err(|e| format!("PDF page {page} could not be read: {e}"))?;
        if content.len() > MAX_TEXT_BYTES.saturating_sub(text.len()) {
            return Err("PDF exceeds the 8 MiB extracted text limit".into());
        }
        text.push_str(&content);
        text.push('\n');
    }
    if text.trim().is_empty() {
        return Err(
            "PDF has no extractable text; scanned pages require OCR before importing".into(),
        );
    }
    Ok(text.replace("\r\n", "\n"))
}

// -- OOXML shared plumbing --

fn open_zip(path: &Path) -> DynResult<zip::ZipArchive<std::fs::File>> {
    let file = std::fs::File::open(path)
        .map_err(|e| format!("doc_extract: open {} failed: {}", path.display(), e))?;
    let zip = zip::ZipArchive::new(file)
        .map_err(|e| format!("doc_extract: not a valid zip ({}): {}", path.display(), e))?;
    if zip.len() > MAX_ZIP_ENTRIES {
        return Err("Office document has too many archive entries".into());
    }
    Ok(zip)
}

fn read_zip_entry(
    zip: &mut zip::ZipArchive<std::fs::File>,
    name: &str,
    expanded: &mut usize,
) -> DynResult<Vec<u8>> {
    let entry = zip
        .by_name(name)
        .map_err(|e| format!("doc_extract: entry '{}' missing: {}", name, e))?;
    if entry.size() > MAX_XML_BYTES {
        return Err(format!("Office XML entry '{name}' exceeds the 8 MiB limit").into());
    }
    let mut buf = Vec::new();
    entry
        .take(MAX_XML_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("doc_extract: read entry '{}' failed: {}", name, e))?;
    if buf.len() as u64 > MAX_XML_BYTES || buf.len() > MAX_EXPANDED_BYTES.saturating_sub(*expanded)
    {
        return Err("Office document exceeds the expanded content limit".into());
    }
    *expanded += buf.len();
    Ok(buf)
}

/// Walk an OOXML XML blob and collect text content from `<*:t>` and
/// `<*:v>` elements regardless of namespace. Good enough for docx, xlsx
/// shared strings, xlsx sheets, and pptx slides.
fn extract_text_from_xml(xml: &[u8]) -> DynResult<String> {
    let mut output = String::new();
    let mut capture = 0_usize;
    crate::office_xml::walk(xml, |event| {
        match &event {
            Event::Start(start) if is_text_element(start.local_name().as_ref()) => capture += 1,
            Event::End(end) if is_text_element(end.local_name().as_ref()) => {
                capture = capture.saturating_sub(1)
            }
            Event::End(end) if matches!(end.local_name().as_ref(), b"p" | b"tr") => {
                crate::office_xml::append(&mut output, "\n")?
            }
            Event::Empty(start) if matches!(start.local_name().as_ref(), b"br" | b"cr") => {
                crate::office_xml::append(&mut output, "\n")?
            }
            Event::Empty(start) if start.local_name().as_ref() == b"tab" => {
                crate::office_xml::append(&mut output, "\t")?
            }
            _ if capture > 0 => {
                if let Some(text) = crate::office_xml::text(&event)? {
                    crate::office_xml::append(&mut output, &text)?;
                }
            }
            _ => {}
        }
        Ok(())
    })?;
    Ok(output)
}

fn is_text_element(local: &[u8]) -> bool {
    matches!(local, b"t" | b"v")
}

// -- DOCX --

fn extract_docx(path: &Path) -> DynResult<String> {
    let mut zip = open_zip(path)?;
    let xml = read_zip_entry(&mut zip, "word/document.xml", &mut 0)?;
    extract_text_from_xml(&xml)
}

// -- XLSX --

fn extract_xlsx(path: &Path) -> DynResult<String> {
    let mut zip = open_zip(path)?;
    let mut expanded = 0;
    let shared = if zip.by_name("xl/sharedStrings.xml").is_ok() {
        let xml = read_zip_entry(&mut zip, "xl/sharedStrings.xml", &mut expanded)?;
        crate::spreadsheet::shared_strings(&xml)?
    } else {
        Vec::new()
    };
    let mut sheets: Vec<String> = zip
        .file_names()
        .map(|name| name.map(|name| name.into_owned()))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|name| name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml"))
        .collect();
    sheets.sort_by_key(|name| {
        name.trim_start_matches("xl/worksheets/sheet")
            .trim_end_matches(".xml")
            .parse::<u32>()
            .unwrap_or(u32::MAX)
    });
    if sheets.is_empty() {
        return Err("Workbook contains no worksheet parts".into());
    }
    let mut output = String::new();
    for name in sheets {
        let xml = read_zip_entry(&mut zip, &name, &mut expanded)?;
        crate::office_xml::append(&mut output, &format!("## {name}\n"))?;
        crate::office_xml::append(&mut output, &crate::spreadsheet::worksheet(&xml, &shared)?)?;
        crate::office_xml::append(&mut output, "\n")?;
    }
    Ok(output)
}

// -- PPTX --

fn extract_pptx(path: &Path) -> DynResult<String> {
    let mut zip = open_zip(path)?;
    let mut slide_names: Vec<String> = zip
        .file_names()
        .map(|name| name.map(|name| name.into_owned()))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml"))
        .collect();
    slide_names.sort_by_key(|name| {
        name.trim_start_matches("ppt/slides/slide")
            .trim_end_matches(".xml")
            .parse::<u32>()
            .unwrap_or(u32::MAX)
    });

    let mut out = String::new();
    let mut expanded = 0;
    for (i, name) in slide_names.iter().enumerate() {
        let xml = read_zip_entry(&mut zip, name, &mut expanded)?;
        out.push_str(&format!("## Slide {}\n", i + 1));
        out.push_str(&extract_text_from_xml(&xml)?);
        out.push_str("\n\n");
    }
    Ok(out)
}
