// Generated documents verify extraction fidelity, malformed input and resource boundaries.
use super::*;
use std::io::Write;

struct Document(std::path::PathBuf);
impl Document {
    fn new(extension: &str) -> Self {
        Self(std::env::temp_dir().join(format!("n2-doc-{}.{}", uuid::Uuid::new_v4(), extension)))
    }
    fn zip(extension: &str, entries: &[(&str, &[u8])]) -> Self {
        let document = Self::new(extension);
        let mut writer = zip::ZipWriter::new(std::fs::File::create(&document.0).unwrap());
        for (name, bytes) in entries {
            writer
                .start_file(
                    *name,
                    zip::write::SimpleFileOptions::default()
                        .compression_method(zip::CompressionMethod::Deflated),
                )
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
        document
    }
}
impl Drop for Document {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[test]
fn docx_preserves_unicode_entities_and_cdata() {
    let xml =
        "<w:document xmlns:w='w'><w:t>한글 &amp; &#x1F600; <![CDATA[<문서>]]></w:t></w:document>";
    let document = Document::zip("docx", &[("word/document.xml", xml.as_bytes())]);
    assert_eq!(extract_text(&document.0).unwrap(), "한글 & 😀 <문서>");
}

#[test]
fn malformed_or_deep_xml_is_an_error_not_partial_success() {
    for xml in [
        "<doc><t>partial",
        "<doc><t>x</doc>",
        "<!DOCTYPE doc><doc><t>x</t></doc>",
        "<t>&unknown;</t>",
    ] {
        assert!(
            extract_text_from_xml(xml.as_bytes()).is_err(),
            "Accepted {xml}"
        );
    }
    let deep = format!(
        "{}<t>deep</t>{}",
        "<a>".repeat(MAX_XML_DEPTH),
        "</a>".repeat(MAX_XML_DEPTH)
    );
    assert!(extract_text_from_xml(deep.as_bytes()).is_err());
}

#[test]
fn compressed_oversized_office_entry_is_rejected_before_allocation() {
    let bytes = vec![b' '; MAX_XML_BYTES as usize + 1];
    let document = Document::zip("docx", &[("word/document.xml", &bytes)]);
    assert!(document.0.metadata().unwrap().len() < 100_000);
    assert!(extract_text(&document.0)
        .unwrap_err()
        .to_string()
        .contains("8 MiB"));
}

#[test]
fn cumulative_expansion_and_missing_entries_are_errors() {
    let document = Document::zip("docx", &[("word/document.xml", b"<t>test</t>")]);
    let mut archive = open_zip(&document.0).unwrap();
    let mut consumed = MAX_EXPANDED_BYTES;
    assert!(read_zip_entry(&mut archive, "word/document.xml", &mut consumed).is_err());
    assert!(read_zip_entry(&mut archive, "absent.xml", &mut 0).is_err());
}

#[test]
fn pptx_slides_are_read_in_numeric_order() {
    let document = Document::zip(
        "pptx",
        &[
            ("ppt/slides/slide10.xml", b"<s><t>ten</t></s>"),
            ("ppt/slides/slide2.xml", b"<s><t>two</t></s>"),
        ],
    );
    let text = extract_text(&document.0).unwrap();
    assert!(text.find("two").unwrap() < text.find("ten").unwrap());
}

#[test]
fn xlsx_includes_unicode_shared_strings_and_numeric_values() {
    let document = Document::zip(
        "xlsx",
        &[
            (
                "xl/sharedStrings.xml",
                "<sst><si><t>한글 셀</t></si></sst>".as_bytes(),
            ),
            (
                "xl/worksheets/sheet1.xml",
                b"<worksheet><row><c t='s' r='A1'><v>0</v></c><c r='B1'><v>12.5</v></c></row></worksheet>",
            ),
        ],
    );
    let text = extract_text(&document.0).unwrap();
    assert!(text.contains("한글 셀") && text.contains("12.5"));
}

#[test]
fn pdf_text_extraction_works_with_upgraded_parser() {
    let document = Document::new("pdf");
    let stream = "BT /F1 12 Tf 72 720 Td (N2 PDF fixture) Tj ET";
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".to_string(),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
    ];
    let mut pdf = String::from("%PDF-1.4\n");
    let mut offsets = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.push_str(&format!("{} 0 obj\n{object}\nendobj\n", index + 1));
    }
    let startxref = pdf.len();
    pdf.push_str("xref\n0 6\n0000000000 65535 f \n");
    for offset in offsets {
        pdf.push_str(&format!("{offset:010} 00000 n \n"));
    }
    pdf.push_str(&format!(
        "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{startxref}\n%%EOF\n"
    ));
    std::fs::write(&document.0, pdf).unwrap();
    assert!(extract_text(&document.0)
        .unwrap()
        .contains("N2 PDF fixture"));
}

fn pdf_fixture(objects: &[String]) -> Document {
    let document = Document::new("pdf");
    let mut pdf = String::from("%PDF-1.4\n");
    let mut offsets = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.push_str(&format!("{} 0 obj\n{object}\nendobj\n", index + 1));
    }
    let start = pdf.len();
    pdf.push_str(&format!(
        "xref\n0 {}\n0000000000 65535 f \n",
        objects.len() + 1
    ));
    for offset in offsets {
        pdf.push_str(&format!("{offset:010} 00000 n \n"));
    }
    pdf.push_str(&format!(
        "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n",
        objects.len() + 1
    ));
    std::fs::write(&document.0, pdf).unwrap();
    document
}

fn pdf_stream(content: &str) -> String {
    format!(
        "<< /Length {} >>\nstream\n{content}\nendstream",
        content.len()
    )
}

#[test]
fn pdf_unicode_cmap_and_multiple_pages_preserve_text_order() {
    let cmap = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Fixture def /CMapType 2 def
1 begincodespacerange <0000> <FFFF> endcodespacerange
3 beginbfchar <0001> <D55C> <0002> <AE00> <0003> <D83DDE00> endbfchar
endcmap CMapName currentdict /CMap defineresource pop end end";
    let document = pdf_fixture(&[
        "<< /Type /Catalog /Pages 2 0 R >>".into(),
        "<< /Type /Pages /Kids [3 0 R 8 0 R] /Count 2 >>".into(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".into(),
        "<< /Type /Font /Subtype /Type0 /BaseFont /Fixture /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 6 0 R >>".into(),
        pdf_stream("BT /F1 12 Tf 72 720 Td <00010002> Tj ET"),
        pdf_stream(cmap),
        "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Fixture /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>".into(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 9 0 R >>".into(),
        pdf_stream("BT /F1 12 Tf 72 720 Td <0003> Tj ET"),
    ]);
    let text = extract_text(&document.0).unwrap();
    assert!(text.contains("한글") && text.contains('😀'), "{text}");
    assert!(text.find("한글").unwrap() < text.find('😀').unwrap());
}

#[test]
fn empty_and_malformed_pdfs_are_explicit_errors() {
    let document = pdf_fixture(&[
        "<< /Type /Catalog /Pages 2 0 R >>".into(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>"
            .into(),
        pdf_stream("q Q"),
    ]);
    assert!(extract_text(&document.0)
        .unwrap_err()
        .to_string()
        .contains("OCR"));
    std::fs::write(&document.0, b"%PDF-1.4 truncated data").unwrap();
    assert!(extract_text(&document.0).is_err());
}

#[test]
fn xlsx_resolves_cells_without_including_unused_shared_strings() {
    let document = Document::zip("xlsx", &[
        ("xl/sharedStrings.xml", b"<sst><si><t>used</t></si><si><t>unused-secret</t></si><si><r><t>rich</t></r><r><t>text</t></r></si></sst>"),
        ("xl/worksheets/sheet2.xml", b"<worksheet><c r='A2' t='inlineStr'><is><t>inline</t></is></c></worksheet>"),
        ("xl/worksheets/sheet1.xml", b"<worksheet><c r='A1' t='s'><v>0</v></c><c r='B1' t='s'><v>2</v></c><c r='C1' t='b'><v>1</v></c><c r='D1'><f>1+1</f><v>2</v></c><c r='E1'><f>SUM(A1:A2)</f></c></worksheet>"),
    ]);
    let text = extract_text(&document.0).unwrap();
    assert!(text.contains("A1\tused\n") && text.contains("B1\trichtext\n"));
    assert!(
        text.contains("C1\ttrue\n")
            && text.contains("D1\t2\n")
            && text.contains("E1\t=SUM(A1:A2)\n")
    );
    assert!(text.contains("A2\tinline\n") && !text.contains("unused-secret"));
    assert!(text.find("sheet1").unwrap() < text.find("sheet2").unwrap());
}

#[test]
fn xlsx_bad_shared_indices_and_output_expansion_are_errors() {
    assert!(crate::spreadsheet::worksheet(b"<s><c t='s'><v>-1</v></c></s>", &[]).is_err());
    assert!(
        crate::spreadsheet::worksheet(b"<s><c t='s'><v>1</v></c></s>", &["only".into()]).is_err()
    );
    assert!(crate::spreadsheet::worksheet(b"<s><c t='b'><v>2</v></c></s>", &[]).is_err());
    let shared = vec!["large".repeat(crate::MAX_TEXT_BYTES / 5)];
    assert!(crate::spreadsheet::worksheet(
        b"<s><c t='s'><v>0</v></c><c t='s'><v>0</v></c></s>",
        &shared
    )
    .is_err());
}

#[test]
fn office_paragraphs_runs_entities_and_utf16_are_preserved() {
    let xml = "<?xml version='1.0' encoding='UTF-16'?><w:document xmlns:w='w'><w:p><w:r><w:t>한글</w:t></w:r><w:r><w:t>문서</w:t><w:tab/><w:t>값 &amp; 😀</w:t><w:br/><w:t>다음줄</w:t></w:r></w:p></w:document>";
    let mut bytes = vec![0xff, 0xfe];
    for value in xml.encode_utf16() {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    let document = Document::zip("docx", &[("word/document.xml", &bytes)]);
    assert_eq!(
        extract_text(&document.0).unwrap(),
        "한글문서\t값 & 😀\n다음줄\n"
    );
    for bad in [
        "<t>x</t><t>y</t>",
        "<t>x</t>tail",
        "<t a='&unknown;'>x</t>",
        "<t a='x' a='y'>x</t>",
        "<?xml version='9.0'?><t>x</t>",
    ] {
        assert!(
            extract_text_from_xml(bad.as_bytes()).is_err(),
            "Accepted {bad}"
        );
    }
}
