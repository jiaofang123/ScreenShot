use std::io::Cursor;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{DynamicImage, ImageFormat, RgbaImage};

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
