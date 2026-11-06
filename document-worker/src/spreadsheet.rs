// Decode worksheet cell values with shared strings, inline strings and cached formulas.
use crate::{office_xml, DynResult};
use quick_xml::events::Event;

pub fn shared_strings(xml: &[u8]) -> DynResult<Vec<String>> {
    let mut values = Vec::new();
    let mut current: Option<String> = None;
    let mut capture = false;
    office_xml::walk(xml, |event| {
        match &event {
            Event::Start(start) => match start.local_name().as_ref() {
                b"si" => {
                    if current.is_some() {
                        return Err("Nested shared string records".into());
                    }
                    current = Some(String::new());
                }
                b"t" => capture = current.is_some(),
                _ => {}
            },
            Event::End(end) => match end.local_name().as_ref() {
                b"si" => {
                    values.push(current.take().ok_or("Missing shared string record")?);
                }
                b"t" => capture = false,
                _ => {}
            },
            Event::Empty(start) if start.local_name().as_ref() == b"si" => {
                values.push(String::new())
            }
            _ if capture => {
                if let Some(text) = office_xml::text(&event)? {
                    office_xml::append(current.as_mut().ok_or("Missing shared string")?, &text)?;
                }
            }
            _ => {}
        }
        if values.len() > 100_000 {
            return Err("Workbook shared string limit exceeded".into());
        }
        Ok(())
    })?;
    Ok(values)
}

#[derive(Default)]
struct Cell {
    address: String,
    kind: String,
    value: String,
    formula: String,
    inline: String,
}

impl Cell {
    fn append(&mut self, field: char, text: &str) -> DynResult<()> {
        let destination = match field {
            'v' => &mut self.value,
            'f' => &mut self.formula,
            _ => &mut self.inline,
        };
        office_xml::append(destination, text)
    }

    fn render(&self, shared: &[String]) -> DynResult<String> {
        if self.kind == "inlineStr" {
            return Ok(self.inline.clone());
        }
        if self.value.is_empty() {
            return Ok(if self.formula.is_empty() {
                String::new()
            } else {
                format!("={}", self.formula)
            });
        }
        match self.kind.as_str() {
            "s" => {
                let index = self
                    .value
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| "Invalid shared string index")?;
                Ok(shared
                    .get(index)
                    .ok_or("Shared string index is out of range")?
                    .clone())
            }
            "b" => match self.value.trim() {
                "0" => Ok("false".into()),
                "1" => Ok("true".into()),
                _ => Err("Invalid boolean cell value".into()),
            },
            "" | "n" | "str" | "e" | "d" => Ok(self.value.clone()),
            _ => Err("Unsupported worksheet cell type".into()),
        }
    }
}

pub fn worksheet(xml: &[u8], shared: &[String]) -> DynResult<String> {
    let mut output = String::new();
    let mut cell: Option<Cell> = None;
    let mut capture = None;
    office_xml::walk(xml, |event| {
        match &event {
            Event::Start(start) => match start.local_name().as_ref() {
                b"c" => {
                    if cell.is_some() {
                        return Err("Nested worksheet cells".into());
                    }
                    cell = Some(Cell {
                        address: office_xml::attribute(start, b"r")?,
                        kind: office_xml::attribute(start, b"t")?,
                        ..Cell::default()
                    });
                }
                b"v" if cell.is_some() => capture = Some('v'),
                b"f" if cell.is_some() => capture = Some('f'),
                b"t" if cell.is_some() => capture = Some('t'),
                _ => {}
            },
            Event::End(end) => match end.local_name().as_ref() {
                b"c" => {
                    append_cell(
                        &mut output,
                        cell.take().ok_or("Missing worksheet cell")?,
                        shared,
                    )?;
                    capture = None;
                }
                b"v" | b"f" | b"t" => capture = None,
                _ => {}
            },
            _ => {
                if let (Some(field), Some(current), Some(text)) =
                    (capture, &mut cell, office_xml::text(&event)?)
                {
                    current.append(field, &text)?;
                }
            }
        }
        Ok(())
    })?;
    Ok(output)
}

fn append_cell(output: &mut String, cell: Cell, shared: &[String]) -> DynResult<()> {
    let value = cell.render(shared)?;
    if value.is_empty() {
        return Ok(());
    }
    if !cell.address.is_empty() {
        office_xml::append(output, &cell.address)?;
        office_xml::append(output, "\t")?;
    }
    office_xml::append(output, &value)?;
    office_xml::append(output, "\n")
}
