use image::{Rgba, RgbaImage};
use serde::Deserialize;

use crate::image_utils::{data_url_to_image, image_to_data_url};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    x: f32,
    y: f32,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Annotation {
    Rect {
        x: f32,
        y: f32,
        width: f32,
        height: f32,
        color: String,
        #[serde(default = "default_stroke_width", alias = "strokeWidth")]
        stroke_width: f32,
    },
    Arrow {
        start: Point,
        end: Point,
        color: String,
        #[serde(default = "default_stroke_width", alias = "strokeWidth")]
        stroke_width: f32,
    },
    Pen {
        points: Vec<Point>,
        color: String,
        #[serde(default = "default_stroke_width", alias = "strokeWidth")]
        stroke_width: f32,
    },
    Mosaic {
        x: f32,
        y: f32,
        width: f32,
        height: f32,
        #[serde(default = "default_mosaic_block_size", alias = "blockSize")]
        block_size: u32,
    },
}

fn default_mosaic_block_size() -> u32 {
    12
}

fn default_stroke_width() -> f32 {
    5.0
}

#[tauri::command]
pub fn render_annotations(
    source_data_url: String,
    annotations: Vec<Annotation>,
) -> Result<String, String> {
    let mut image = data_url_to_image(&source_data_url)?;
    for annotation in annotations {
        apply_annotation(&mut image, annotation);
    }
    image_to_data_url(&image)
}

fn apply_annotation(image: &mut RgbaImage, annotation: Annotation) {
    match annotation {
        Annotation::Rect {
            x,
            y,
            width,
            height,
            color,
            stroke_width,
        } => {
            let color = parse_color(&color);
            draw_thick_line(image, x, y, x + width, y, color, stroke_width);
            draw_thick_line(
                image,
                x + width,
                y,
                x + width,
                y + height,
                color,
                stroke_width,
            );
            draw_thick_line(
                image,
                x + width,
                y + height,
                x,
                y + height,
                color,
                stroke_width,
            );
            draw_thick_line(image, x, y + height, x, y, color, stroke_width);
        }
        Annotation::Arrow {
            start,
            end,
            color,
            stroke_width,
        } => {
            let color = parse_color(&color);
            draw_thick_line(image, start.x, start.y, end.x, end.y, color, stroke_width);
            let angle = (end.y - start.y).atan2(end.x - start.x);
            let head_length = (stroke_width * 4.5).max(14.0);
            for offset in [2.55_f32, -2.55_f32] {
                let head_x = end.x + head_length * (angle + offset).cos();
                let head_y = end.y + head_length * (angle + offset).sin();
                draw_thick_line(image, end.x, end.y, head_x, head_y, color, stroke_width);
            }
        }
        Annotation::Pen {
            points,
            color,
            stroke_width,
        } => {
            let color = parse_color(&color);
            for pair in points.windows(2) {
                draw_thick_line(
                    image,
                    pair[0].x,
                    pair[0].y,
                    pair[1].x,
                    pair[1].y,
                    color,
                    stroke_width,
                );
            }
        }
        Annotation::Mosaic {
            x,
            y,
            width,
            height,
            block_size,
        } => pixelate(image, x, y, width, height, block_size.max(4)),
    }
}

fn draw_thick_line(
    image: &mut RgbaImage,
    x1: f32,
    y1: f32,
    x2: f32,
    y2: f32,
    color: Rgba<u8>,
    stroke_width: f32,
) {
    let distance = (x2 - x1).abs().max((y2 - y1).abs()).ceil() as u32;
    let radius = (stroke_width.max(1.0) / 2.0).ceil() as i32;
    if distance == 0 {
        draw_filled_circle(image, x1.round() as i32, y1.round() as i32, radius, color);
        return;
    }
    for step in 0..=distance {
        let progress = step as f32 / distance as f32;
        let x = x1 + (x2 - x1) * progress;
        let y = y1 + (y2 - y1) * progress;
        draw_filled_circle(image, x.round() as i32, y.round() as i32, radius, color);
    }
}

fn draw_filled_circle(
    image: &mut RgbaImage,
    center_x: i32,
    center_y: i32,
    radius: i32,
    color: Rgba<u8>,
) {
    let radius_squared = radius * radius;
    for offset_y in -radius..=radius {
        for offset_x in -radius..=radius {
            if offset_x * offset_x + offset_y * offset_y > radius_squared {
                continue;
            }
            let x = center_x + offset_x;
            let y = center_y + offset_y;
            if x >= 0 && y >= 0 && x < image.width() as i32 && y < image.height() as i32 {
                image.put_pixel(x as u32, y as u32, color);
            }
        }
    }
}

fn pixelate(image: &mut RgbaImage, x: f32, y: f32, width: f32, height: f32, block_size: u32) {
    let left = x.min(x + width).max(0.0).floor() as u32;
    let top = y.min(y + height).max(0.0).floor() as u32;
    let right = x.max(x + width).min(image.width() as f32).ceil() as u32;
    let bottom = y.max(y + height).min(image.height() as f32).ceil() as u32;

    for block_y in (top..bottom).step_by(block_size as usize) {
        for block_x in (left..right).step_by(block_size as usize) {
            let block_right = (block_x + block_size).min(right);
            let block_bottom = (block_y + block_size).min(bottom);
            let mut sums = [0_u64; 4];
            let mut count = 0_u64;
            for sample_y in block_y..block_bottom {
                for sample_x in block_x..block_right {
                    let pixel = image.get_pixel(sample_x, sample_y).0;
                    for channel in 0..4 {
                        sums[channel] += u64::from(pixel[channel]);
                    }
                    count += 1;
                }
            }
            if count == 0 {
                continue;
            }
            let color = Rgba([
                (sums[0] / count) as u8,
                (sums[1] / count) as u8,
                (sums[2] / count) as u8,
                255,
            ]);
            for target_y in block_y..block_bottom {
                for target_x in block_x..block_right {
                    image.put_pixel(target_x, target_y, color);
                }
            }
        }
    }
}

fn parse_color(value: &str) -> Rgba<u8> {
    let hex = value.trim_start_matches('#');
    if hex.len() == 6 {
        if let Ok(rgb) = u32::from_str_radix(hex, 16) {
            return Rgba([
                ((rgb >> 16) & 0xff) as u8,
                ((rgb >> 8) & 0xff) as u8,
                (rgb & 0xff) as u8,
                255,
            ]);
        }
    }
    Rgba([239, 68, 68, 255])
}
