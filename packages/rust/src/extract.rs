use pdfium_render::prelude::*;
use serde::Serialize;

// If gap is < fontSize * CHAR_X_GAP_THRESHOLD, consider it part of the same word
const CHAR_X_GAP_THRESHOLD: f32 = 0.3; 

// If gap is < fontSize * NEGATIVE_X_GAP_THRESHOLD, consider it a negative gap (e.g. kerning) and start a new word
const NEGATIVE_X_GAP_THRESHOLD: f32 = -0.2;

// If gap is > fontSize * CHAR_Y_GAP_THRESHOLD, consider it a new item
const CHAR_Y_GAP_THRESHOLD: f32 = 0.25; 

#[derive(Debug, Serialize)]
struct TextItem {
    text: String,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    font_name: Option<String>,
    font_size: Option<f32>,
}

#[derive(Debug, Serialize)]
struct Page {
    page_number: usize,
    page_width: f32,
    page_height: f32,
    text_items: Vec<TextItem>,
}

pub fn extract(pdf_path: &str, page_num: Option<u32>) -> Result<(), Box<dyn std::error::Error>> {
    // Initialize PDFium
    let pdfium = Pdfium::new(
        Pdfium::bind_to_statically_linked_library().unwrap()
    );

    // Load the PDF document
    let document = pdfium.load_pdf_from_file(pdf_path, None)?;

    // iterate over pages to extract text
    for (page_index, page) in document.pages().iter().enumerate() {
        if let Some(target_page) = page_num {
            if page_index as u32 + 1 != target_page {
                continue;
            }
        }

        let mut text_items = Vec::new();
        let mut cur_item: Option<TextItem> = None;

        for object in page.objects().iter() {
            if let Some(object) = object.as_text_object() {
                let obj_x = object.bounds().unwrap().x1.value;
                let obj_y = object.bounds().unwrap().y1.value;
                let obj_w = object.width().unwrap().value;
                // Use font size as a consistent height (pdfium heigh is very glyph-dependent)
                let obj_h = object.scaled_font_size().value;
                let obj_font_size = object.scaled_font_size().value;

                if let Some(ref mut item) = cur_item {
                    let cur_font_size = item.font_size.unwrap_or(obj_font_size);
                    let x_gap = obj_x - (item.x + item.width);
                    let y_gap = (item.y - obj_y).abs();
                    
                    if x_gap < cur_font_size * NEGATIVE_X_GAP_THRESHOLD {
                        // Negative gap (e.g. kerning) — start new item
                        text_items.push(cur_item.take().unwrap());
                        cur_item = Some(TextItem {
                            text: object.text().to_string(),
                            x: obj_x,
                            y: obj_y,
                            width: obj_w,
                            height: obj_h,
                            font_name: Some(object.font().family().to_string()),
                            font_size: Some(obj_font_size),
                        });
                    } else if x_gap < cur_font_size * CHAR_X_GAP_THRESHOLD && y_gap < cur_font_size * CHAR_Y_GAP_THRESHOLD {
                        // Same word — merge directly
                        item.text.push_str(object.text().trim_start());
                        item.width = (obj_x + obj_w) - item.x;
                        item.height = f32::max(item.height, obj_h);
                    } else {
                        // Large gap — flush current item and start new one
                        text_items.push(cur_item.take().unwrap());
                        cur_item = Some(TextItem {
                            text: object.text().to_string(),
                            x: obj_x,
                            y: obj_y,
                            width: obj_w,
                            height: obj_h,
                            font_name: Some(object.font().family().to_string()),
                            font_size: Some(obj_font_size),
                        });
                    }
                } else {
                    // First text object on this page
                    cur_item = Some(TextItem {
                        text: object.text().to_string(),
                        x: obj_x,
                        y: obj_y,
                        width: obj_w,
                        height: obj_h,
                        font_name: Some(object.font().family().to_string()),
                        font_size: Some(obj_font_size),
                    });
                }
            }
        }
    
        // Push the last item if it has text
        if let Some(item) = cur_item.take() {
            if !item.text.is_empty() {
                text_items.push(item);
            }
        }

        let page_data = Page {
            page_number: page_index + 1,
            page_width: page.width().value,
            page_height: page.height().value,
            text_items,
        };

        // Print the page data as a JSON-line object
        println!("{}", serde_json::to_string(&page_data)?);
    }

    Ok(())
}
