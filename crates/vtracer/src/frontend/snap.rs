//! Palette-snap frontend: detect a small palette, upscale smoothly, snap every
//! pixel to the palette, then cluster the now-flat image.
//!
//! Small or noisy raster art (logos, icons, UI) defeats plain color
//! clustering in two ways: compression noise splits flat fills into many
//! near-identical patches, and at low resolution every outline is a pixel
//! staircase. This frontend fixes both before tracing:
//!
//! 1. **Palette detection.** Only *flat* pixels (barely different from all
//!    eight neighbours) vote. Anti-aliased edge pixels are blends of the two
//!    colors they separate; left in, they become a palette entry of their own
//!    and the trace grows a halo outline around every shape. Flat pixels are
//!    binned in OKLab and greedily merged, most common first, into clusters
//!    of perceptually indistinguishable color. Tiny clusters are dropped.
//! 2. **Smooth upscale.** The image is enlarged `scale`× with Catmull–Rom
//!    bicubic interpolation (premultiplied alpha, so transparent pixels do
//!    not darken edges). An anti-aliased edge pixel encodes *where* the edge
//!    crosses it; interpolation turns that into a ramp whose midpoint lands
//!    at the true sub-pixel edge position.
//! 3. **Snap.** Each upscaled pixel is explained as a mix of the two palette
//!    colors whose blend line passes closest to it, and takes whichever of
//!    the two it is nearer — the 50% coverage point, so each edge becomes a
//!    fine staircase at the right place. Plain nearest-color snapping is
//!    wrong here: the blend of two colors can sit closer to an unrelated
//!    third (navy + white makes a mid grey-blue that is "nearest" to orange),
//!    which paints a halo of that third color along every edge.
//! 4. **Cluster** the flat result with the classic color clusterer.
//!
//! The segmentation is at the upscaled size; [`Segmentation::scale`] records
//! the factor and the pipeline maps the fitted geometry back to source pixels.

use std::collections::HashMap;

use visioncortex::{Color, ColorImage};

use crate::colorfit::oklab::Oklab;
use crate::error::Error;
use crate::ir::{Paint, Segmentation};
use crate::progress::Ctx;

use super::{ColorClusterFrontend, Frontend};

/// A pixel is flat when its OKLab distance to every 8-neighbour is below this.
const FLAT_THRESHOLD: f64 = 0.05;
/// Clusters closer than this in OKLab are merged into one palette entry.
const MERGE_THRESHOLD: f64 = 0.10;
/// Flat pixels are pre-binned on an OKLab grid of this cell size.
const BIN_SIZE: f64 = 0.02;
/// A cluster needs at least this share of the flat pixels to become a color.
const MIN_CLUSTER_SHARE: f64 = 0.0005;
/// ...and at least this many pixels.
const MIN_CLUSTER_PIXELS: usize = 8;
/// Auto scale aims for a working image of about this many pixels.
const AUTO_TARGET_PIXELS: f64 = 4_000_000.0;
/// Largest auto scale factor.
const AUTO_MAX_SCALE: u32 = 8;
/// Alpha at or above this counts as opaque.
const OPAQUE: u8 = 128;

/// Palette-snap frontend. See the [module docs](self).
#[derive(Debug, Clone)]
pub struct SnapFrontend {
    /// Upscale factor; 0 picks one from the image size (up to 8×).
    pub scale: u32,
    /// Fixed palette to snap to. Empty = detect one from the image.
    pub palette: Vec<Color>,
    /// Cap on the detected palette size (most common colors win). 0 = no cap.
    pub max_colors: usize,
    /// Speckle area in *source* pixels; scaled with the image internally.
    pub min_area: usize,
}

impl Default for SnapFrontend {
    fn default() -> Self {
        Self {
            scale: 0,
            palette: Vec::new(),
            max_colors: 0,
            min_area: 16,
        }
    }
}

impl SnapFrontend {
    /// The upscale factor this frontend will use for an image of this size.
    pub fn scale_for(&self, width: usize, height: usize) -> u32 {
        if self.scale > 0 {
            return self.scale;
        }
        let pixels = (width * height).max(1) as f64;
        ((AUTO_TARGET_PIXELS / pixels).sqrt().floor() as u32).clamp(1, AUTO_MAX_SCALE)
    }

    /// Snap `img` to the palette at the working scale. Returns the snapped
    /// image and the scale used. Exposed for inspection and tests.
    pub fn snap(&self, img: &ColorImage) -> Result<(ColorImage, u32), Error> {
        self.snap_with_palette(img).map(|(out, scale, _)| (out, scale))
    }

    fn snap_with_palette(&self, img: &ColorImage) -> Result<(ColorImage, u32, Vec<Color>), Error> {
        if img.width == 0 || img.height == 0 {
            return Err(Error::EmptyImage);
        }
        let palette = if self.palette.is_empty() {
            detect_palette(img, self.max_colors)
        } else {
            self.palette.clone()
        };
        if palette.is_empty() {
            // Fully transparent image: nothing to snap to.
            return Err(Error::EmptyImage);
        }
        let scale = self.scale_for(img.width, img.height);
        Ok((upscale_snap(img, scale as usize, &palette), scale, palette))
    }

    /// Cluster a snapped image and pin every paint to its exact palette color
    /// (cluster means can drift by a unit in rounding).
    fn finish(&self, mut seg: Segmentation, scale: u32, palette: &[Color]) -> Segmentation {
        let rgb: Vec<[f32; 3]> = palette.iter().map(|c| [c.r as f32, c.g as f32, c.b as f32]).collect();
        for layer in &mut seg.layers {
            let c = layer.paint.color();
            let i = snap_mix([c.r as f32, c.g as f32, c.b as f32], &rgb);
            layer.paint = Paint::Solid(palette[i]);
        }
        seg.scale = scale;
        seg
    }

    fn inner(&self, scale: u32) -> ColorClusterFrontend {
        ColorClusterFrontend {
            // The snapped image holds only exact palette colors, so compare
            // at full precision and treat any difference as a new region.
            color_precision_loss: 0,
            layer_difference: 1,
            good_min_area: self.min_area * (scale * scale) as usize,
        }
    }
}

impl Frontend for SnapFrontend {
    fn segment(&self, img: &ColorImage) -> Result<Segmentation, Error> {
        let (snapped, scale, palette) = self.snap_with_palette(img)?;
        let seg = self.inner(scale).segment_keyed(&snapped, has_transparency(&snapped))?;
        Ok(self.finish(seg, scale, &palette))
    }

    fn segment_with(&self, img: &ColorImage, ctx: &mut Ctx) -> Result<Segmentation, Error> {
        let (snapped, scale, palette) = self.snap_with_palette(img)?;
        ctx.check()?;
        let seg = self
            .inner(scale)
            .segment_keyed_with(&snapped, has_transparency(&snapped), ctx)?;
        Ok(self.finish(seg, scale, &palette))
    }
}

fn has_transparency(img: &ColorImage) -> bool {
    img.pixels.chunks_exact(4).any(|p| p[3] == 0)
}

/// Detect the dominant flat colors of `img`, most common first. `max_colors`
/// caps the result (0 = no cap).
pub fn detect_palette(img: &ColorImage, max_colors: usize) -> Vec<Color> {
    let (w, h) = (img.width, img.height);
    let px = |x: usize, y: usize| img.get_pixel(x, y);
    let lab: Vec<Oklab> = (0..w * h).map(|i| Oklab::from_color(&px(i % w, i / w))).collect();

    // Bin flat, opaque pixels: (sum of RGB, count) per OKLab grid cell, plus
    // the cell's OKLab sum for the merge distance.
    let mut bins: HashMap<(i32, i32, i32), Bin> = HashMap::new();
    let mut flat_total = 0usize;
    let limit = FLAT_THRESHOLD * FLAT_THRESHOLD;
    for y in 0..h {
        for x in 0..w {
            let c = px(x, y);
            if c.a < OPAQUE {
                continue;
            }
            let here = &lab[y * w + x];
            let flat = neighbours(x, y, w, h).all(|(nx, ny)| {
                px(nx, ny).a < OPAQUE || here.distance_squared(&lab[ny * w + nx]) < limit
            });
            if !flat {
                continue;
            }
            flat_total += 1;
            let key = (
                (here.l / BIN_SIZE).round() as i32,
                (here.a / BIN_SIZE).round() as i32,
                (here.b / BIN_SIZE).round() as i32,
            );
            bins.entry(key).or_default().add(c, here);
        }
    }

    // Greedy agglomeration, most populated bin first: join the first cluster
    // within the merge distance, else start a new one.
    let mut order: Vec<Bin> = bins.into_values().collect();
    order.sort_by(|a, b| b.count.cmp(&a.count));
    let mut clusters: Vec<Bin> = Vec::new();
    let merge = MERGE_THRESHOLD * MERGE_THRESHOLD;
    for bin in order {
        let mean = bin.lab_mean();
        match clusters.iter_mut().find(|c| c.lab_mean().distance_squared(&mean) < merge) {
            Some(c) => c.absorb(&bin),
            None => clusters.push(bin),
        }
    }

    let min = MIN_CLUSTER_PIXELS.max((flat_total as f64 * MIN_CLUSTER_SHARE) as usize);
    clusters.retain(|c| c.count >= min);
    clusters.sort_by(|a, b| b.count.cmp(&a.count));
    if max_colors > 0 {
        clusters.truncate(max_colors);
    }
    clusters.iter().map(Bin::color).collect()
}

fn neighbours(x: usize, y: usize, w: usize, h: usize) -> impl Iterator<Item = (usize, usize)> {
    let (x, y) = (x as i64, y as i64);
    (-1..=1i64)
        .flat_map(move |dy| (-1..=1i64).map(move |dx| (x + dx, y + dy)))
        .filter(move |&(nx, ny)| {
            (nx, ny) != (x, y) && nx >= 0 && ny >= 0 && nx < w as i64 && ny < h as i64
        })
        .map(|(nx, ny)| (nx as usize, ny as usize))
}

/// Accumulated pixels of one OKLab bin or cluster.
#[derive(Debug, Clone, Default)]
struct Bin {
    rgb: [u64; 3],
    lab: [f64; 3],
    count: usize,
}

impl Bin {
    fn add(&mut self, c: Color, lab: &Oklab) {
        self.rgb[0] += c.r as u64;
        self.rgb[1] += c.g as u64;
        self.rgb[2] += c.b as u64;
        self.lab[0] += lab.l;
        self.lab[1] += lab.a;
        self.lab[2] += lab.b;
        self.count += 1;
    }

    fn absorb(&mut self, other: &Bin) {
        for i in 0..3 {
            self.rgb[i] += other.rgb[i];
            self.lab[i] += other.lab[i];
        }
        self.count += other.count;
    }

    fn lab_mean(&self) -> Oklab {
        let n = self.count.max(1) as f64;
        Oklab {
            l: self.lab[0] / n,
            a: self.lab[1] / n,
            b: self.lab[2] / n,
        }
    }

    fn color(&self) -> Color {
        let n = self.count.max(1) as u64;
        let ch = |i: usize| ((self.rgb[i] + n / 2) / n) as u8;
        Color::new(ch(0), ch(1), ch(2))
    }
}

/// Catmull–Rom weights for a sample at fractional offset `t` in [0, 1).
fn catmull_rom(t: f32) -> [f32; 4] {
    let t2 = t * t;
    let t3 = t2 * t;
    [
        0.5 * (-t3 + 2.0 * t2 - t),
        0.5 * (3.0 * t3 - 5.0 * t2 + 2.0),
        0.5 * (-3.0 * t3 + 4.0 * t2 + t),
        0.5 * (t3 - t2),
    ]
}

/// Source taps and weights for each output coordinate along one axis.
fn axis_taps(src_len: usize, scale: usize) -> Vec<([usize; 4], [f32; 4])> {
    let last = src_len as i64 - 1;
    (0..src_len * scale)
        .map(|o| {
            let s = (o as f32 + 0.5) / scale as f32 - 0.5;
            let base = s.floor();
            let weights = catmull_rom(s - base);
            let base = base as i64;
            let idx = [-1, 0, 1, 2].map(|d| (base + d).clamp(0, last) as usize);
            (idx, weights)
        })
        .collect()
}

/// Upscale `img` by `scale` with premultiplied Catmull–Rom, then snap every
/// pixel to its nearest palette color (or full transparency).
fn upscale_snap(img: &ColorImage, scale: usize, palette: &[Color]) -> ColorImage {
    let (w, h) = (img.width, img.height);
    let (ow, oh) = (w * scale, h * scale);

    // Premultiplied float source.
    let src: Vec<[f32; 4]> = img
        .pixels
        .chunks_exact(4)
        .map(|p| {
            let a = p[3] as f32 / 255.0;
            [p[0] as f32 * a, p[1] as f32 * a, p[2] as f32 * a, a]
        })
        .collect();

    // Horizontal pass: w*scale × h.
    let xt = axis_taps(w, scale);
    let mut mid = vec![[0f32; 4]; ow * h];
    for y in 0..h {
        let row = &src[y * w..(y + 1) * w];
        for (ox, (idx, wt)) in xt.iter().enumerate() {
            let mut acc = [0f32; 4];
            for k in 0..4 {
                let p = row[idx[k]];
                for c in 0..4 {
                    acc[c] += p[c] * wt[k];
                }
            }
            mid[y * ow + ox] = acc;
        }
    }

    let rgb_palette: Vec<[f32; 3]> = palette
        .iter()
        .map(|c| [c.r as f32, c.g as f32, c.b as f32])
        .collect();
    let mut cache: HashMap<[u8; 3], usize> = HashMap::new();
    let mut out = ColorImage::new_w_h(ow, oh);

    // Vertical pass, snapping as we go.
    let yt = axis_taps(h, scale);
    for (oy, (idx, wt)) in yt.iter().enumerate() {
        for ox in 0..ow {
            let mut acc = [0f32; 4];
            for k in 0..4 {
                let p = mid[idx[k] * ow + ox];
                for c in 0..4 {
                    acc[c] += p[c] * wt[k];
                }
            }
            let a = acc[3].clamp(0.0, 1.0);
            let o = (oy * ow + ox) * 4;
            if a * 255.0 < OPAQUE as f32 {
                out.pixels[o..o + 4].copy_from_slice(&[0, 0, 0, 0]);
                continue;
            }
            let rgb = [0, 1, 2].map(|c| (acc[c] / a).round().clamp(0.0, 255.0) as u8);
            let i = *cache
                .entry(rgb)
                .or_insert_with(|| snap_mix(rgb.map(|v| v as f32), &rgb_palette));
            let c = palette[i];
            out.pixels[o..o + 4].copy_from_slice(&[c.r, c.g, c.b, 255]);
        }
    }
    out
}

/// Snap `p` to a palette index by modelling it as a blend of two palette
/// colors. Finds the pair whose connecting segment (in sRGB, where image
/// resampling mixes) passes closest to `p`, then picks the end it is nearer.
fn snap_mix(p: [f32; 3], palette: &[[f32; 3]]) -> usize {
    let dist2 = |a: [f32; 3], b: [f32; 3]| (0..3).map(|c| (a[c] - b[c]).powi(2)).sum::<f32>();
    // Single colors first: a pixel on a palette color needs no pair.
    let mut best = 0;
    let mut best_d = f32::INFINITY;
    for (i, &c) in palette.iter().enumerate() {
        let d = dist2(p, c);
        if d < best_d {
            best_d = d;
            best = i;
        }
    }
    for i in 0..palette.len() {
        for j in i + 1..palette.len() {
            let (a, b) = (palette[i], palette[j]);
            let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
            if len2 == 0.0 {
                continue;
            }
            let t = (((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2])
                / len2)
                .clamp(0.0, 1.0);
            let on = [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]];
            let d = dist2(p, on);
            if d < best_d {
                best_d = d;
                best = if t < 0.5 { i } else { j };
            }
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `w`×`h` image: left half `a`, right half `b`, with one column of
    /// 50/50 blend between them (an anti-aliased edge).
    fn two_tone(w: usize, h: usize, a: Color, b: Color) -> ColorImage {
        let mut img = ColorImage::new_w_h(w, h);
        let mid = Color::new(
            ((a.r as u16 + b.r as u16) / 2) as u8,
            ((a.g as u16 + b.g as u16) / 2) as u8,
            ((a.b as u16 + b.b as u16) / 2) as u8,
        );
        for y in 0..h {
            for x in 0..w {
                let c = if x < w / 2 {
                    a
                } else if x == w / 2 {
                    mid
                } else {
                    b
                };
                img.set_pixel(x, y, &c);
            }
        }
        img
    }

    #[test]
    fn edge_blend_is_not_a_palette_color() {
        let navy = Color::new(25, 42, 111);
        let white = Color::new(248, 249, 251);
        let palette = detect_palette(&two_tone(40, 20, navy, white), 0);
        assert_eq!(palette.len(), 2, "got {palette:?}");
        assert!(palette.contains(&navy) && palette.contains(&white));
    }

    #[test]
    fn snapped_image_holds_only_palette_colors() {
        let navy = Color::new(25, 42, 111);
        let white = Color::new(248, 249, 251);
        let snap = SnapFrontend {
            scale: 4,
            ..SnapFrontend::default()
        };
        let (out, scale) = snap.snap(&two_tone(40, 20, navy, white)).unwrap();
        assert_eq!((scale, out.width, out.height), (4, 160, 80));
        for p in out.pixels.chunks_exact(4) {
            let c = Color::new(p[0], p[1], p[2]);
            assert!(c == navy || c == white, "stray color {c:?}");
        }
    }

    #[test]
    fn blend_snaps_to_its_own_pair_not_a_nearby_third_color() {
        let navy = [25.0, 42.0, 111.0];
        let white = [248.0, 249.0, 251.0];
        let orange = [249.0, 149.0, 31.0];
        let palette = [navy, white, orange];
        let mix = |t: f32| [0, 1, 2].map(|c| navy[c] + t * (white[c] - navy[c]));
        assert_eq!(snap_mix(mix(0.45), &palette), 0);
        assert_eq!(snap_mix(mix(0.55), &palette), 1);
        assert_eq!(snap_mix(orange, &palette), 2);
    }

    #[test]
    fn auto_scale_shrinks_for_large_images() {
        let snap = SnapFrontend::default();
        assert_eq!(snap.scale_for(238, 139), 8);
        assert_eq!(snap.scale_for(1000, 1000), 2);
        assert_eq!(snap.scale_for(4000, 3000), 1);
    }
}
