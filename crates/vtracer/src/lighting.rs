//! Even out the lighting of a photo before tracing, so shadows and uneven
//! light don't become shapes of their own.
//!
//! The light falling on the scene changes slowly across the picture, while
//! the things in it (windows, letters, edges) change quickly. So the light is
//! estimated as a very blurred map of brightness, after a small max filter so
//! dark details (a window, a door) don't count as shade. Each pixel is then
//! brightened by how much darker its light is than the well-lit parts of the
//! picture. It only ever brightens: lit areas stay as they are, shadows are
//! lifted towards them.

use visioncortex::ColorImage;

/// The light map is worked out on a copy about this many pixels on its
/// shorter side (it's smooth, so detail would only cost time).
const GRID_SHORT: usize = 96;
/// Blur radius of the light map, as a share of the shorter side.
const LIGHT_RADIUS: f64 = 0.12;
/// Max-filter radius, as a share of the shorter side: dark details smaller
/// than about this aren't mistaken for shade.
const DETAIL_RADIUS: f64 = 0.03;
/// Brightest gain applied (deep shadow is lifted at most this much).
const MAX_GAIN: f32 = 3.0;
/// The "well-lit" level: this quantile of the light map.
const LIT_QUANTILE: f64 = 0.9;

/// `img` with its lighting evened out (see the module docs). Transparent
/// pixels are left alone and don't count towards the light.
pub fn even_out(img: &ColorImage) -> ColorImage {
    let (w, h) = (img.width, img.height);
    if w == 0 || h == 0 {
        return img.clone();
    }
    let px = &img.pixels;
    let luma = |i: usize| 0.299 * px[i * 4] as f32 + 0.587 * px[i * 4 + 1] as f32 + 0.114 * px[i * 4 + 2] as f32;

    // Brightness on a small grid (mean of each cell's opaque pixels).
    let step = (w.min(h) / GRID_SHORT).max(1);
    let (gw, gh) = (w.div_ceil(step), h.div_ceil(step));
    let mut grid = vec![0f32; gw * gh];
    let mut seen = vec![false; gw * gh];
    for gy in 0..gh {
        for gx in 0..gw {
            let (mut sum, mut n) = (0f32, 0u32);
            for y in gy * step..((gy + 1) * step).min(h) {
                for x in gx * step..((gx + 1) * step).min(w) {
                    let i = y * w + x;
                    if px[i * 4 + 3] >= 128 {
                        sum += luma(i);
                        n += 1;
                    }
                }
            }
            if n > 0 {
                grid[gy * gw + gx] = sum / n as f32;
                seen[gy * gw + gx] = true;
            }
        }
    }
    let mean = {
        let lit: Vec<f32> = grid.iter().zip(&seen).filter(|(_, s)| **s).map(|(v, _)| *v).collect();
        if lit.is_empty() {
            return img.clone();
        }
        lit.iter().sum::<f32>() / lit.len() as f32
    };
    for (v, s) in grid.iter_mut().zip(&seen) {
        if !s {
            *v = mean; // transparent cells: neutral
        }
    }

    let short = gw.min(gh) as f64;
    let detail = ((DETAIL_RADIUS * short).round() as usize).max(1);
    let radius = ((LIGHT_RADIUS * short).round() as usize).max(1);
    let mut light = max_filter(&grid, gw, gh, detail);
    for _ in 0..3 {
        light = box_blur(&light, gw, gh, radius);
    }

    let mut sorted = light.clone();
    sorted.sort_by(f32::total_cmp);
    let lit = sorted[((sorted.len() - 1) as f64 * LIT_QUANTILE) as usize].max(1.0);

    // Apply, sampling the light map bilinearly at each pixel's centre.
    let mut out = img.clone();
    for y in 0..h {
        let fy = ((y as f32 + 0.5) / step as f32 - 0.5).clamp(0.0, (gh - 1) as f32);
        let (y0, ty) = (fy.floor() as usize, fy.fract());
        let y1 = (y0 + 1).min(gh - 1);
        for x in 0..w {
            let i = y * w + x;
            if px[i * 4 + 3] == 0 {
                continue;
            }
            let fx = ((x as f32 + 0.5) / step as f32 - 0.5).clamp(0.0, (gw - 1) as f32);
            let (x0, tx) = (fx.floor() as usize, fx.fract());
            let x1 = (x0 + 1).min(gw - 1);
            let top = light[y0 * gw + x0] * (1.0 - tx) + light[y0 * gw + x1] * tx;
            let bottom = light[y1 * gw + x0] * (1.0 - tx) + light[y1 * gw + x1] * tx;
            let here = (top * (1.0 - ty) + bottom * ty).max(1.0);
            let gain = (lit / here).clamp(1.0, MAX_GAIN);
            for c in 0..3 {
                out.pixels[i * 4 + c] = (px[i * 4 + c] as f32 * gain).round().min(255.0) as u8;
            }
        }
    }
    out
}

/// Running max over a (2r+1)² window, edges clamped.
fn max_filter(v: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let mut tmp = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let (a, b) = (x.saturating_sub(r), (x + r).min(w - 1));
            tmp[y * w + x] = (a..=b).map(|i| v[y * w + i]).fold(f32::MIN, f32::max);
        }
    }
    let mut out = vec![0f32; w * h];
    for y in 0..h {
        let (a, b) = (y.saturating_sub(r), (y + r).min(h - 1));
        for x in 0..w {
            out[y * w + x] = (a..=b).map(|j| tmp[j * w + x]).fold(f32::MIN, f32::max);
        }
    }
    out
}

/// Mean over a (2r+1)² window, edges clamped (three passes ≈ a Gaussian).
fn box_blur(v: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let mut tmp = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let (a, b) = (x.saturating_sub(r), (x + r).min(w - 1));
            tmp[y * w + x] = (a..=b).map(|i| v[y * w + i]).sum::<f32>() / (b - a + 1) as f32;
        }
    }
    let mut out = vec![0f32; w * h];
    for y in 0..h {
        let (a, b) = (y.saturating_sub(r), (y + r).min(h - 1));
        for x in 0..w {
            out[y * w + x] = (a..=b).map(|j| tmp[j * w + x]).sum::<f32>() / (b - a + 1) as f32;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(w: usize, h: usize, f: impl Fn(usize, usize) -> [u8; 4]) -> ColorImage {
        let mut pixels = Vec::with_capacity(w * h * 4);
        for y in 0..h {
            for x in 0..w {
                pixels.extend_from_slice(&f(x, y));
            }
        }
        ColorImage { pixels, width: w, height: h }
    }

    #[test]
    fn a_shadow_is_lifted_towards_the_lit_side() {
        // A cream wall, its left third in shadow (half as bright).
        let img = image(300, 200, |x, _| if x < 100 { [100, 95, 85, 255] } else { [200, 190, 170, 255] });
        let out = even_out(&img);
        let at = |x: usize, y: usize| out.pixels[(y * 300 + x) * 4] as i32;
        // Deep in the shadow it's now close to the lit wall; the lit side is unchanged.
        assert!((at(20, 100) - 200).abs() <= 25, "shadow became {}", at(20, 100));
        assert_eq!(at(280, 100), 200);
    }

    #[test]
    fn small_dark_details_stay_dark() {
        // White page with small black marks: not shade, so not lifted.
        let img = image(200, 200, |x, y| if x % 40 < 3 && y % 40 < 3 { [0, 0, 0, 255] } else { [240, 240, 240, 255] });
        let out = even_out(&img);
        assert_eq!(out.pixels[0], 0);
        assert_eq!(out.pixels[(100 * 200 + 101) * 4], 240);
    }
}
