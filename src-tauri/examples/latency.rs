//! Reproducible image-pipeline benchmark using synthetic pixels (no screen or clipboard access).
use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use std::{hint::black_box, io::Cursor, time::Instant};

#[path = "../src/annotate.rs"]
#[allow(dead_code)]
mod annotate;
#[path = "../src/image_utils.rs"]
mod image_utils;

fn legacy_data_url(image: &RgbaImage) -> String {
    let mut cursor = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image.clone())
        .write_to(&mut cursor, ImageFormat::Png)
        .unwrap();
    format!(
        "data:image/png;base64,{}",
        STANDARD.encode(cursor.into_inner())
    )
}

fn measure(label: &str, mut operation: impl FnMut()) {
    let start = Instant::now();
    operation();
    println!("{label}: {:.1} ms", start.elapsed().as_secs_f64() * 1000.0);
}

fn main() {
    let image = RgbaImage::from_fn(2560, 1440, |x, y| {
        let shade = ((x / 16 + y / 16) % 2 * 30) as u8;
        Rgba([
            220 - shade,
            ((x * 7 + y * 3) % 256) as u8,
            ((x / 8 + y / 4) % 256) as u8,
            255,
        ])
    });
    println!(
        "2560x1440 synthetic image; optimized={}",
        !cfg!(debug_assertions)
    );
    measure("overlay preview", || {
        black_box(image_utils::image_to_preview_data_url(&image, 2.0).unwrap());
    });
    measure("legacy selection PNG", || {
        black_box(legacy_data_url(&image));
    });
    measure("new selection PNG", || {
        black_box(image_utils::image_to_data_url(&image).unwrap());
    });
    let source = legacy_data_url(&image);
    measure("legacy copy image round trip", || {
        let rendered = image_utils::data_url_to_image(&source).unwrap();
        let encoded = legacy_data_url(&rendered);
        black_box(image_utils::data_url_to_image(&encoded).unwrap());
    });
    measure("new unannotated copy preparation", || {
        black_box(annotate::render_image(&image, vec![]).unwrap());
    });
    measure("new annotated copy preparation", || {
        black_box(
            annotate::render_image(
                &image,
                vec![annotate::Annotation::Rect {
                    x: 100.0,
                    y: 100.0,
                    width: 300.0,
                    height: 100.0,
                    color: "#ff4d5e".into(),
                    stroke_width: 5.0,
                }],
            )
            .unwrap(),
        );
    });
}
