// Shared bounded XML validation for Office text and worksheet decoding.
use crate::DynResult;
use quick_xml::events::{BytesDecl, BytesStart, Event};
use quick_xml::reader::Reader;
use quick_xml::XmlVersion;

pub fn walk(xml: &[u8], mut visit: impl FnMut(Event<'_>) -> DynResult<()>) -> DynResult<()> {
    if xml.len() > 8 * 1024 * 1024 {
        return Err("Office XML entry exceeds 8 MiB".into());
    }
    let (decoded, encoding) = decode_xml(xml)?;
    let mut reader = Reader::from_str(&decoded);
    let (mut depth, mut roots) = (0_usize, 0_usize);
    loop {
        let event = reader.read_event()?;
        validate_text_position(&event, depth)?;
        match &event {
            Event::Start(start) => {
                if depth == 0 {
                    roots += 1;
                }
                depth += 1;
                validate_start(start, depth)?;
            }
            Event::Empty(start) => {
                if depth == 0 {
                    roots += 1;
                }
                validate_start(start, depth + 1)?;
            }
            Event::End(_) => {
                depth = depth
                    .checked_sub(1)
                    .ok_or("Unmatched XML closing element")?;
            }
            Event::DocType(_) => return Err("Office XML document types are unsupported".into()),
            Event::Decl(declaration) => validate_declaration(declaration, encoding)?,
            Event::Eof => {
                if depth != 0 || roots != 1 {
                    return Err("Office XML must contain one closed root".into());
                }
                return Ok(());
            }
            _ => {}
        }
        if roots > 1 {
            return Err("Office XML has multiple roots".into());
        }
        visit(event)?;
    }
}

fn validate_start(start: &BytesStart<'_>, depth: usize) -> DynResult<()> {
    if depth > crate::documents::MAX_XML_DEPTH {
        return Err("Office XML nesting limit exceeded".into());
    }
    for attribute in start.attributes() {
        attribute?.normalized_value(XmlVersion::Implicit1_0)?;
    }
    Ok(())
}

pub fn attribute(start: &BytesStart<'_>, name: &[u8]) -> DynResult<String> {
    for attribute in start.attributes() {
        let attribute = attribute?;
        if attribute.key.local_name().as_ref() == name {
            return Ok(attribute
                .normalized_value(XmlVersion::Implicit1_0)?
                .into_owned());
        }
    }
    Ok(String::new())
}

fn decode_xml(xml: &[u8]) -> DynResult<(String, &'static encoding_rs::Encoding)> {
    let (encoding, offset) = encoding_rs::Encoding::for_bom(xml).unwrap_or_else(|| {
        if xml.starts_with(&[b'<', 0]) {
            (encoding_rs::UTF_16LE, 0)
        } else if xml.starts_with(&[0, b'<']) {
            (encoding_rs::UTF_16BE, 0)
        } else {
            (encoding_rs::UTF_8, 0)
        }
    });
    let value = encoding
        .decode_without_bom_handling_and_without_replacement(&xml[offset..])
        .ok_or("Invalid UTF-8 or UTF-16 Office XML")?;
    Ok((value.replace("\r\n", "\n").replace('\r', "\n"), encoding))
}

fn validate_declaration(
    declaration: &BytesDecl<'_>,
    encoding: &encoding_rs::Encoding,
) -> DynResult<()> {
    if declaration.xml_version()? != XmlVersion::Explicit1_0 {
        return Err("Office XML version must be 1.0".into());
    }
    if let Some(name) = declaration.encoding() {
        let name = name?;
        let name = std::str::from_utf8(&name)?.to_ascii_uppercase();
        let matches = match name.as_str() {
            "UTF-8" | "UTF8" => encoding == encoding_rs::UTF_8,
            "UTF-16" | "UTF16" => {
                encoding == encoding_rs::UTF_16LE || encoding == encoding_rs::UTF_16BE
            }
            "UTF-16LE" => encoding == encoding_rs::UTF_16LE,
            "UTF-16BE" => encoding == encoding_rs::UTF_16BE,
            _ => false,
        };
        if !matches {
            return Err("Office XML encoding must match its UTF-8 or UTF-16 bytes".into());
        }
    }
    Ok(())
}

pub fn text(event: &Event<'_>) -> DynResult<Option<String>> {
    match event {
        Event::Text(value) => Ok(Some(value.decode()?.into_owned())),
        Event::CData(value) => Ok(Some(value.decode()?.into_owned())),
        Event::GeneralRef(value) => {
            if let Some(character) = value.resolve_char_ref()? {
                return Ok(Some(character.to_string()));
            }
            let name = value.decode()?;
            let decoded = quick_xml::escape::resolve_predefined_entity(&name)
                .ok_or_else(|| format!("Unsupported XML entity '&{name};'"))?;
            Ok(Some(decoded.to_string()))
        }
        _ => Ok(None),
    }
}

pub fn append(output: &mut String, text: &str) -> DynResult<()> {
    if text.len() > crate::MAX_TEXT_BYTES.saturating_sub(output.len()) {
        return Err("Extracted text exceeds 8 MiB".into());
    }
    output.push_str(text);
    Ok(())
}

fn validate_text_position(event: &Event<'_>, depth: usize) -> DynResult<()> {
    match event {
        Event::GeneralRef(_) => {
            if depth == 0 {
                return Err("Text outside the XML root".into());
            }
            text(event)?;
        }
        Event::Text(value) if depth == 0 && !value.decode()?.trim().is_empty() => {
            return Err("Text outside the XML root".into())
        }
        Event::CData(_) if depth == 0 => return Err("CDATA outside the XML root".into()),
        _ => {}
    }
    Ok(())
}
