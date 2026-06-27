use std::io::Cursor;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{
    codecs::jpeg::JpegEncoder, imageops::FilterType, ColorType, DynamicImage, ImageFormat,
    RgbaImage,
};

const PREVIEW_MAX_EDGE: u32 = 2_560;

pub fn image_to_data_url(image: &RgbaImage) -> Result<String, String> {
    let mut cursor = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image.clone())
        .write_to(&mut cursor, ImageFormat::Png)
        .map_err(|error| format!("PNG 编码失败：{error}"))?;
    Ok(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(cursor.into_inner())
    ))
}

pub fn image_to_preview_data_url(image: &RgbaImage, scale_factor: f32) -> Result<String, String> {
    let preview = preview_image(image, scale_factor);
    let rgb = DynamicImage::ImageRgba8(preview).to_rgb8();
    let mut bytes = Vec::with_capacity((rgb.width() * rgb.height() * 3) as usize);
    JpegEncoder::new_with_quality(&mut bytes, 82)
        .encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            ColorType::Rgb8.into(),
        )
        .map_err(|error| format!("预览图编码失败：{error}"))?;
    Ok(format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes)))
}

fn preview_image(image: &RgbaImage, scale_factor: f32) -> RgbaImage {
    let scale = scale_factor.max(1.0);
    let max_dimension = image.width().max(image.height()) as f32;
    let edge_scale = if max_dimension > PREVIEW_MAX_EDGE as f32 {
        max_dimension / PREVIEW_MAX_EDGE as f32
    } else {
        1.0
    };
    let divisor = scale.max(edge_scale);
    if divisor <= 1.05 {
        return image.clone();
    }

    let width = ((image.width() as f32 / divisor).round() as u32).max(1);
    let height = ((image.height() as f32 / divisor).round() as u32).max(1);
    image::imageops::resize(image, width, height, FilterType::Triangle)
}

pub fn data_url_to_image(data_url: &str) -> Result<RgbaImage, String> {
    let encoded = data_url
        .split_once(',')
        .map(|(_, value)| value)
        .ok_or_else(|| "无效的图片数据".to_string())?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|error| format!("Base64 解码失败：{error}"))?;
    image::load_from_memory(&bytes)
        .map(|image| image.to_rgba8())
        .map_err(|error| format!("图片解码失败：{error}"))
}
