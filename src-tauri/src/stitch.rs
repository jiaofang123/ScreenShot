use image::{imageops, RgbaImage};

const MAX_OUTPUT_HEIGHT: u32 = 40_000;
const MAX_OUTPUT_PIXELS: u64 = 80_000_000;
const SEAM_OVERLAP_ROWS: u32 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StitchOutcome {
    Added(u32),
    Unchanged,
    NoReliableMatch,
    LimitReached,
}

pub struct ScrollStitcher {
    width: u32,
    viewport_height: u32,
    total_height: u32,
    last_frame: RgbaImage,
    segments: Vec<StitchSegment>,
}

struct StitchSegment {
    image: RgbaImage,
    overlap: u32,
}

impl ScrollStitcher {
    pub fn new(first_frame: RgbaImage) -> Self {
        let width = first_frame.width();
        let viewport_height = first_frame.height();
        Self {
            width,
            viewport_height,
            total_height: viewport_height,
            last_frame: first_frame.clone(),
            segments: vec![StitchSegment {
                image: first_frame,
                overlap: 0,
            }],
        }
    }

    pub fn try_push(&mut self, frame: RgbaImage) -> StitchOutcome {
        if frame.dimensions() != self.last_frame.dimensions() {
            return StitchOutcome::NoReliableMatch;
        }

        if mean_sample_difference(&self.last_frame, &frame) < 1.2 {
            return StitchOutcome::Unchanged;
        }

        let Some(shift) = find_vertical_shift(&self.last_frame, &frame) else {
            return StitchOutcome::NoReliableMatch;
        };

        let remaining_by_height = MAX_OUTPUT_HEIGHT.saturating_sub(self.total_height);
        let remaining_by_pixels = if self.width == 0 {
            0
        } else {
            (MAX_OUTPUT_PIXELS / u64::from(self.width)).saturating_sub(u64::from(self.total_height))
                as u32
        };
        let allowed = shift.min(remaining_by_height).min(remaining_by_pixels);
        if allowed == 0 {
            return StitchOutcome::LimitReached;
        }

        let start_y = self.viewport_height - allowed;
        let overlap = start_y.min(SEAM_OVERLAP_ROWS).min(self.total_height);
        let crop_y = start_y - overlap;
        let tail = imageops::crop_imm(&frame, 0, crop_y, self.width, allowed + overlap).to_image();
        self.segments.push(StitchSegment {
            image: tail,
            overlap,
        });
        self.total_height += allowed;
        self.last_frame = frame;

        if allowed < shift {
            StitchOutcome::LimitReached
        } else {
            StitchOutcome::Added(shift)
        }
    }

    pub fn total_height(&self) -> u32 {
        self.total_height
    }

    pub fn finish(self) -> RgbaImage {
        let mut output = RgbaImage::new(self.width, self.total_height);
        let mut y = 0_i64;
        for segment in self.segments {
            let overlap = segment
                .overlap
                .min(segment.image.height())
                .min(y.max(0) as u32);
            if overlap > 0 {
                blend_overlap(&mut output, &segment.image, (y as u32) - overlap, overlap);
            }

            let body_height = segment.image.height().saturating_sub(overlap);
            if body_height > 0 {
                let body = imageops::crop_imm(&segment.image, 0, overlap, self.width, body_height)
                    .to_image();
                imageops::replace(&mut output, &body, 0, y);
                y += i64::from(body_height);
            }
        }
        output
    }
}

fn blend_overlap(output: &mut RgbaImage, segment: &RgbaImage, target_y: u32, overlap: u32) {
    if overlap == 0 {
        return;
    }

    for y in 0..overlap {
        let alpha = (y + 1) as f32 / (overlap + 1) as f32;
        for x in 0..segment.width() {
            let base = output.get_pixel_mut(x, target_y + y);
            let top = segment.get_pixel(x, y).0;
            for channel in 0..3 {
                base.0[channel] = (f32::from(base.0[channel]) * (1.0 - alpha)
                    + f32::from(top[channel]) * alpha)
                    .round() as u8;
            }
            base.0[3] = 255;
        }
    }
}

fn find_vertical_shift(previous: &RgbaImage, current: &RgbaImage) -> Option<u32> {
    let (width, height) = previous.dimensions();
    if width < 32 || height < 120 {
        return None;
    }

    let minimum_overlap = (height / 4).max(96).min(height.saturating_sub(8));
    let maximum_shift = height.saturating_sub(minimum_overlap);
    if maximum_shift < 6 {
        return None;
    }

    let previous_rows = row_features(previous);
    let current_rows = row_features(current);
    let mut candidates: Vec<(f32, u32)> = Vec::new();

    for shift in (6..=maximum_shift).step_by(2) {
        candidates.push((row_match_cost(&previous_rows, &current_rows, shift), shift));
    }
    candidates.sort_by(|a, b| a.0.total_cmp(&b.0));
    candidates.first()?;

    let mut best: Option<(f32, f32, f32, u32)> = None;
    for (_, coarse_shift) in candidates.iter().take(12) {
        let refine_start = coarse_shift.saturating_sub(4).max(6);
        let refine_end = (coarse_shift + 4).min(maximum_shift);
        for shift in refine_start..=refine_end {
            let row_cost = row_match_cost(&previous_rows, &current_rows, shift);
            let pixel_cost =
                pixel_match_cost(previous, current, shift, &previous_rows, &current_rows);
            let combined = row_cost * 0.65 + pixel_cost * 0.9;
            if best
                .map(|(best_combined, _, _, _)| combined < best_combined)
                .unwrap_or(true)
            {
                best = Some((combined, row_cost, pixel_cost, shift));
            }
        }
    }

    let (_, row_cost, pixel_cost, shift) = best?;
    if row_cost <= 22.0 && pixel_cost <= 28.0 {
        Some(shift)
    } else {
        None
    }
}

fn row_features(image: &RgbaImage) -> Vec<(f32, f32)> {
    let (width, height) = image.dimensions();
    let left = width / 12;
    let right = width.saturating_sub(left).max(left + 1);
    let mut output = Vec::with_capacity(height as usize);

    for y in 0..height {
        let mut luminance_sum = 0.0_f32;
        let mut edge_sum = 0.0_f32;
        let mut samples = 0_u32;
        let mut previous_luminance: Option<f32> = None;
        for x in (left..right).step_by(4) {
            let pixel = image.get_pixel(x, y).0;
            let luminance = 0.299 * f32::from(pixel[0])
                + 0.587 * f32::from(pixel[1])
                + 0.114 * f32::from(pixel[2]);
            luminance_sum += luminance;
            if let Some(previous) = previous_luminance {
                edge_sum += (luminance - previous).abs();
            }
            previous_luminance = Some(luminance);
            samples += 1;
        }
        let divisor = samples.max(1) as f32;
        output.push((luminance_sum / divisor, edge_sum / divisor));
    }
    output
}

fn row_match_cost(previous: &[(f32, f32)], current: &[(f32, f32)], shift: u32) -> f32 {
    let overlap = previous.len().saturating_sub(shift as usize);
    if overlap < 8 {
        return f32::MAX;
    }

    // Skip the first part of the overlap. Fixed headers often occupy this area.
    let start = overlap / 7;
    let end = overlap.saturating_sub(overlap / 20).max(start + 1);
    let mut cost = 0.0_f32;
    let mut weight_total = 0.0_f32;
    for current_y in (start..end).step_by(2) {
        let previous_y = current_y + shift as usize;
        let (previous_luma, previous_edge) = previous[previous_y];
        let (current_luma, current_edge) = current[current_y];
        let detail = previous_edge.max(current_edge);
        let weight = 1.0 + detail.min(12.0) * 0.45;
        cost += ((previous_luma - current_luma).abs()
            + 0.65 * (previous_edge - current_edge).abs())
            * weight;
        weight_total += weight;
    }
    cost / weight_total.max(1.0)
}

fn pixel_match_cost(
    previous: &RgbaImage,
    current: &RgbaImage,
    shift: u32,
    previous_rows: &[(f32, f32)],
    current_rows: &[(f32, f32)],
) -> f32 {
    let (width, height) = previous.dimensions();
    let overlap = height.saturating_sub(shift);
    let start_y = overlap / 7;
    let end_y = overlap.saturating_sub(overlap / 20).max(start_y + 1);
    let left = width / 10;
    let right = width.saturating_sub(left).max(left + 1);
    let mut total = 0.0_f32;
    let mut weight_total = 0.0_f32;

    for y in (start_y..end_y).step_by(8) {
        let previous_row = (y + shift) as usize;
        let current_row = y as usize;
        let detail = previous_rows
            .get(previous_row)
            .map(|(_, edge)| *edge)
            .unwrap_or_default()
            .max(
                current_rows
                    .get(current_row)
                    .map(|(_, edge)| *edge)
                    .unwrap_or_default(),
            );
        let weight = 1.0 + detail.min(12.0) * 0.35;
        for x in (left..right).step_by(8) {
            let a = previous.get_pixel(x, y + shift).0;
            let b = current.get_pixel(x, y).0;
            let diff = u32::from(a[0].abs_diff(b[0]))
                + u32::from(a[1].abs_diff(b[1]))
                + u32::from(a[2].abs_diff(b[2]));
            total += (diff as f32 / 3.0) * weight;
            weight_total += weight;
        }
    }

    total / weight_total.max(1.0)
}

fn mean_sample_difference(a: &RgbaImage, b: &RgbaImage) -> f32 {
    if a.dimensions() != b.dimensions() {
        return f32::MAX;
    }
    let (width, height) = a.dimensions();
    let mut total = 0_u64;
    let mut count = 0_u64;
    for y in (0..height).step_by(12) {
        for x in (0..width).step_by(12) {
            let left = a.get_pixel(x, y).0;
            let right = b.get_pixel(x, y).0;
            total += u64::from(left[0].abs_diff(right[0]));
            total += u64::from(left[1].abs_diff(right[1]));
            total += u64::from(left[2].abs_diff(right[2]));
            count += 3;
        }
    }
    total as f32 / count.max(1) as f32
}

#[cfg(test)]
mod tests {
    use image::{imageops, Rgba};

    use super::*;

    fn patterned_page(width: u32, height: u32) -> RgbaImage {
        RgbaImage::from_fn(width, height, |x, y| {
            let band = ((y / 23) % 9) as u8;
            Rgba([
                band.wrapping_mul(27).wrapping_add((x % 17) as u8),
                (y % 251) as u8,
                ((x * 3 + y * 5) % 255) as u8,
                255,
            ])
        })
    }

    #[test]
    fn stitches_scrolled_views() {
        let page = patterned_page(320, 1_600);
        let first = imageops::crop_imm(&page, 0, 0, 320, 500).to_image();
        let second = imageops::crop_imm(&page, 0, 280, 320, 500).to_image();
        let third = imageops::crop_imm(&page, 0, 550, 320, 500).to_image();
        let mut stitcher = ScrollStitcher::new(first);
        assert_eq!(stitcher.try_push(second), StitchOutcome::Added(280));
        assert_eq!(stitcher.try_push(third), StitchOutcome::Added(270));
        assert_eq!(stitcher.finish().height(), 1_050);
    }
}
