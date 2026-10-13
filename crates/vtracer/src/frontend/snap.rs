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
//!    binned in OKLab (with toe-corrected lightness, so near-blacks are not
//!    split apart) and greedily merged, most common first, into clusters
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
//!
//! With [`glow`](SnapFrontend::glow), a region whose visible edge is mostly
//! soft (measured by the same edge-width test that drives smoothing) is
//! painted with a matching Gaussian blur, so a glow traces as a glow rather
//! than a hard disc.

use std::collections::HashMap;

use visioncortex::{BinaryImage, Color, ColorImage, PointI32};

use crate::colorfit::oklab::Oklab;
use crate::error::Error;
use crate::ir::{Paint, RegionMask, Segmentation};

use crate::progress::Ctx;

use super::{ColorClusterFrontend, Frontend};

/// A pixel is flat when its OKLab distance to every 8-neighbour is below this.
const FLAT_THRESHOLD: f64 = 0.05;
/// Clusters closer than this in OKLab (toe-corrected lightness) are merged
/// into one palette entry. Mastercard's red and its red-orange overlap are
/// ~0.10 apart, so the limit sits well below that.
const MERGE_THRESHOLD: f64 = 0.06;
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
    /// Smoothing (Gaussian sigma, source pixels) applied to *soft* edges only
    /// before snapping. A soft, grainy ramp such as a glow otherwise snaps to
    /// a ragged edge that follows the grain. Crisp edges are detected by
    /// their width and left alone, so sharp corners keep their points.
    /// 0 = off.
    pub smooth: f64,
    /// Give regions whose visible edge is mostly soft a matching blur
    /// ([`Paint::Blurred`]), so glows stay glows. Needs stacked compositing:
    /// a blurred edge must fade over the layer beneath it, which cutout
    /// mosaics punch out.
    pub glow: bool,
}

impl Default for SnapFrontend {
    fn default() -> Self {
        Self {
            scale: 0,
            palette: Vec::new(),
            max_colors: 0,
            min_area: 16,
            smooth: 1.2,
            glow: false,
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
        self.snap_full(img).map(|(out, scale, palette, _)| (out, scale, palette))
    }

    /// Snap, also returning the source edge map (used for glow detection).
    fn snap_full(
        &self,
        img: &ColorImage,
    ) -> Result<(ColorImage, u32, Vec<Color>, Option<EdgeMap>), Error> {
        if img.width == 0 || img.height == 0 {
            return Err(Error::EmptyImage);
        }
        let (w, h) = (img.width, img.height);
        let mut src = premultiplied(img);
        let edges = edge_map(&src, w, h);
        let palette = if self.palette.is_empty() {
            detect_palette_where(img, self.max_colors, Some(&edges.soft))
        } else {
            self.palette.clone()
        };
        if palette.is_empty() {
            // Fully transparent image: nothing to snap to.
            return Err(Error::EmptyImage);
        }
        let scale = self.scale_for(w, h);
        smooth_soft_edges(&mut src, w, h, self.smooth, &edges.soft);
        let out = upscale_snap(&src, w, h, scale as usize, &palette);
        Ok((out, scale, palette, Some(edges)))
    }

    /// Cluster a snapped image and pin every paint to its exact palette color
    /// (cluster means can drift by a unit in rounding).
    fn finish(
        &self,
        mut seg: Segmentation,
        scale: u32,
        palette: &[Color],
        edges: Option<&EdgeMap>,
        source: (usize, usize),
    ) -> Segmentation {
        let rgb: Vec<[f32; 3]> = palette.iter().map(|c| [c.r as f32, c.g as f32, c.b as f32]).collect();
        for layer in &mut seg.layers {
            let c = layer.paint.color();
            let i = snap_mix([c.r as f32, c.g as f32, c.b as f32], &rgb);
            layer.paint = Paint::Solid(palette[i]);
        }
        seg.scale = scale;
        if let (true, Some(edges)) = (self.glow, edges) {
            assign_glow(&mut seg, edges, source);
        }
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
        let (snapped, scale, palette, edges) = self.snap_full(img)?;
        let seg = self.inner(scale).segment_keyed(&snapped, has_transparency(&snapped))?;
        Ok(self.finish(seg, scale, &palette, edges.as_ref(), (img.width, img.height)))
    }

    fn segment_with(&self, img: &ColorImage, ctx: &mut Ctx) -> Result<Segmentation, Error> {
        let (snapped, scale, palette, edges) = self.snap_full(img)?;
        ctx.check()?;
        let seg = self
            .inner(scale)
            .segment_keyed_with(&snapped, has_transparency(&snapped), ctx)?;
        Ok(self.finish(seg, scale, &palette, edges.as_ref(), (img.width, img.height)))
    }
}

fn has_transparency(img: &ColorImage) -> bool {
    img.pixels.chunks_exact(4).any(|p| p[3] == 0)
}

/// Detect the dominant flat colors of `img`, most common first. `max_colors`
/// caps the result (0 = no cap).
pub fn detect_palette(img: &ColorImage, max_colors: usize) -> Vec<Color> {
    detect_palette_where(img, max_colors, None)
}

/// [`detect_palette`], also skipping pixels on soft edges (`soft` > 0.3).
/// Inside a wide, smooth fade neighbouring pixels differ so little that they
/// pass as flat, and the fade's in-between shades would become palette
/// colors, slicing a glow into concentric bands.
fn detect_palette_where(img: &ColorImage, max_colors: usize, soft: Option<&[f32]>) -> Vec<Color> {
    let (w, h) = (img.width, img.height);
    let px = |x: usize, y: usize| img.get_pixel(x, y);
    let lab: Vec<Oklab> = (0..w * h).map(|i| Oklab::from_color_toe(&px(i % w, i / w))).collect();

    // Bin flat, opaque pixels: (sum of RGB, count) per OKLab grid cell, plus
    // the cell's OKLab sum for the merge distance.
    let mut bins: HashMap<(i32, i32, i32), Bin> = HashMap::new();
    let mut flat_total = 0usize;
    let limit = FLAT_THRESHOLD * FLAT_THRESHOLD;
    for y in 0..h {
        for x in 0..w {
            let c = px(x, y);
            if c.a < OPAQUE || soft.is_some_and(|s| s[y * w + x] > 0.3) {
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

/// Separable Gaussian blur in place (clamped edges). `sigma` in pixels.
fn gaussian_blur(px: &mut [[f32; 4]], w: usize, h: usize, sigma: f64) {
    if sigma <= 0.0 {
        return;
    }
    let r = (sigma * 3.0).ceil() as i64;
    let mut kernel: Vec<f32> = (-r..=r)
        .map(|i| (-(i * i) as f64 / (2.0 * sigma * sigma)).exp() as f32)
        .collect();
    let sum: f32 = kernel.iter().sum();
    kernel.iter_mut().for_each(|k| *k /= sum);

    let mut tmp = vec![[0f32; 4]; w * h];
    let pass = |src: &[[f32; 4]], dst: &mut [[f32; 4]], horizontal: bool| {
        for y in 0..h as i64 {
            for x in 0..w as i64 {
                let mut acc = [0f32; 4];
                for (k, wt) in kernel.iter().enumerate() {
                    let d = k as i64 - r;
                    let (sx, sy) = if horizontal {
                        ((x + d).clamp(0, w as i64 - 1), y)
                    } else {
                        (x, (y + d).clamp(0, h as i64 - 1))
                    };
                    let p = src[sy as usize * w + sx as usize];
                    for c in 0..4 {
                        acc[c] += p[c] * wt;
                    }
                }
                dst[y as usize * w + x as usize] = acc;
            }
        }
    };
    pass(px, &mut tmp, true);
    pass(&tmp, px, false);
}

/// Edges whose ramp is at most this wide (px) are crisp: left alone.
const CRISP_WIDTH: f32 = 3.0;
/// Edges at least this wide are fully soft: smoothed at full strength.
const SOFT_WIDTH: f32 = 4.5;
/// Window radius (px) for an edge's contrast, and how far a soft decision
/// spreads from the edge's steepest point across its ramp.
const SOFT_RADIUS: usize = 4;
/// Minimum luma contrast (0-255) across the window for an edge to count.
const EDGE_CONTRAST: f32 = 40.0;

/// Separable running max (or min) over a `(2r+1)^2` window, clamped edges.
fn extremum_filter(v: &[f32], w: usize, h: usize, r: usize, max: bool) -> Vec<f32> {
    let pick = |a: f32, b: f32| if max { a.max(b) } else { a.min(b) };
    let mut tmp = vec![0f32; w * h];
    let mut out = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let (x0, x1) = (x.saturating_sub(r), (x + r).min(w - 1));
            tmp[y * w + x] = (x0..=x1).map(|i| v[y * w + i]).reduce(pick).unwrap();
        }
    }
    for y in 0..h {
        let (y0, y1) = (y.saturating_sub(r), (y + r).min(h - 1));
        for x in 0..w {
            out[y * w + x] = (y0..=y1).map(|j| tmp[j * w + x]).reduce(pick).unwrap();
        }
    }
    out
}

/// Per-pixel softness in [0, 1]: 0 on and around crisp (anti-aliased) edges
/// and in flat areas, rising to 1 across wide, soft ramps such as glows.
///
/// An edge's width is its local contrast (luma range over a window) divided
/// by its slope. That ratio only means something at the edge's steepest
/// point (a pixel beside a crisp edge sees the contrast in its window but no
/// slope of its own), so it is measured at gradient peaks, mapped to
/// softness, then spread across the ramp. Measured on small logos, crisp
/// edges come out 2.0-2.5 px wide and a soft moon glow up to ~9.
#[cfg(test)]
fn softness(px: &[[f32; 4]], w: usize, h: usize) -> Vec<f32> {
    edge_map(px, w, h).soft
}

/// Per-pixel edge measurements on the source image.
struct EdgeMap {
    /// Softness in [0, 1]; see [`edge_map`].
    soft: Vec<f32>,
    /// Width (px) of the soft edge at or right beside (3×3) each pixel; 0
    /// elsewhere. Kept tight on purpose: a crisp edge a few pixels from a
    /// glow must not inherit the glow's width.
    width: Vec<f32>,
}

/// Softness and width of the edges around each pixel. Softness is 0 on and
/// around crisp (anti-aliased) edges and in flat areas, rising to 1 across
/// wide, soft ramps such as glows.
fn edge_map(px: &[[f32; 4]], w: usize, h: usize) -> EdgeMap {
    let luma: Vec<f32> = px
        .iter()
        .map(|p| 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2])
        .collect();
    let at = |x: i64, y: i64| {
        luma[y.clamp(0, h as i64 - 1) as usize * w + x.clamp(0, w as i64 - 1) as usize]
    };
    let mut grad = vec![0f32; w * h];
    for y in 0..h as i64 {
        for x in 0..w as i64 {
            // Sobel, normalised to luma per pixel.
            let gx = (at(x + 1, y - 1) + 2.0 * at(x + 1, y) + at(x + 1, y + 1)
                - at(x - 1, y - 1)
                - 2.0 * at(x - 1, y)
                - at(x - 1, y + 1))
                / 8.0;
            let gy = (at(x - 1, y + 1) + 2.0 * at(x, y + 1) + at(x + 1, y + 1)
                - at(x - 1, y - 1)
                - 2.0 * at(x, y - 1)
                - at(x + 1, y - 1))
                / 8.0;
            grad[y as usize * w + x as usize] = (gx * gx + gy * gy).sqrt();
        }
    }
    let hi = extremum_filter(&luma, w, h, SOFT_RADIUS, true);
    let lo = extremum_filter(&luma, w, h, SOFT_RADIUS, false);
    let grad_max = extremum_filter(&grad, w, h, 1, true);

    let mut soft = vec![0f32; w * h];
    let mut widths = vec![0f32; w * h];
    for i in 0..w * h {
        let contrast = hi[i] - lo[i];
        let g = grad[i];
        // A real edge peak: locally steepest, with contrast and a real slope.
        if g >= grad_max[i] && contrast > EDGE_CONTRAST && g > contrast / 20.0 {
            let width = contrast / g;
            let t = ((width - CRISP_WIDTH) / (SOFT_WIDTH - CRISP_WIDTH)).clamp(0.0, 1.0);
            soft[i] = t * t * (3.0 - 2.0 * t);
            if t > 0.0 {
                widths[i] = width;
            }
        }
    }
    let width = extremum_filter(&widths, w, h, 1, true);
    let mut spread: Vec<[f32; 4]> = extremum_filter(&soft, w, h, SOFT_RADIUS, true)
        .into_iter()
        .map(|s| [s, 0.0, 0.0, 0.0])
        .collect();
    // Feather so the blend has no visible seam where softness starts.
    gaussian_blur(&mut spread, w, h, 1.0);
    EdgeMap {
        soft: spread.into_iter().map(|s| s[0].clamp(0.0, 1.0)).collect(),
        width,
    }
}

/// Minimum soft edge (source px) for a region to glow.
const GLOW_MIN_EDGE: usize = 12;
/// Minimum median width (px) of a region's soft edge for it to glow: only
/// clearly soft edges, not merely slightly blurry ones.
const GLOW_MIN_WIDTH: f32 = SOFT_WIDTH;
/// Minimum luma difference (0-255) between a glowing region and its
/// backdrop. Width = contrast / slope is unreliable on faint edges (a little
/// noise flattens a small step's slope), so faint "glows" are ignored; real
/// glows are light against dark or the reverse.
const GLOW_MIN_CONTRAST: f32 = EDGE_CONTRAST;
/// Share of the visible edge above which the halo goes all round rather than
/// just a zone around the soft stretches.
const GLOW_WHOLE_SHARE: f64 = 0.9;

/// Give regions with soft edges a glow: a halo matching the softness.
///
/// A region's edge counts only where it meets something *beneath* it (a
/// lower layer, or nothing): where a layer above occludes it, that edge
/// belongs to the occluder. Its soft stretches (by the edge map) set the
/// halo: for a Gaussian-blurred step, contrast / steepest slope is
/// σ·√(2π) ≈ 2.5σ, so σ = median soft width / 2.5. The halo's backdrop is
/// the layer most often beneath those stretches.
///
/// The region itself stays crisp; the halo is drawn under it, only over its
/// backdrop's color, and only within a *soft zone* (3σ around the soft
/// stretches) unless the region is soft nearly all round. So a moon glows
/// into the sky but never onto the silhouette or trees in front of it.
fn assign_glow(seg: &mut Segmentation, edges: &EdgeMap, (sw, sh): (usize, usize)) {
    let (w, h) = (seg.width as usize, seg.height as usize);
    let scale = seg.scale.max(1) as usize;
    let top = seg.topmost();
    let mut glows: Vec<(usize, usize, u16)> = Vec::new();
    for (i, layer) in seg.layers.iter_mut().enumerate() {
        let i = i as u32;
        let m = &layer.mask;
        let mut total = 0usize;
        let mut soft_px: Vec<usize> = Vec::new();
        let mut soft_widths: Vec<f32> = Vec::new();
        // Layers beneath the soft stretches, by count: the halo's backdrop.
        let mut onto: HashMap<u32, usize> = HashMap::new();
        for y in 0..m.height() {
            for x in 0..m.width() {
                if !m.image.get_pixel(x, y) {
                    continue;
                }
                let (cx, cy) = (x as i64 + m.offset.x as i64, y as i64 + m.offset.y as i64);
                // Skip the canvas border: the image edge is not an edge.
                if cx <= 0 || cy <= 0 || cx >= w as i64 - 1 || cy >= h as i64 - 1 {
                    continue;
                }
                if top[cy as usize * w + cx as usize] != i {
                    continue;
                }
                // Visible edge pixel against something beneath (or nothing).
                let beneath = [(1, 0), (-1, 0), (0, 1), (0, -1)].iter().find_map(|(dx, dy)| {
                    let n = top[((cy + dy) as usize) * w + (cx + dx) as usize];
                    (n == u32::MAX || n < i).then_some(n)
                });
                let Some(beneath) = beneath else { continue };
                total += 1;
                let (sx, sy) = ((cx as usize / scale).min(sw - 1), (cy as usize / scale).min(sh - 1));
                let at = sy * sw + sx;
                if edges.soft[at] > 0.5 && edges.width[at] >= GLOW_MIN_WIDTH {
                    soft_px.push(at);
                    soft_widths.push(edges.width[at]);
                    *onto.entry(beneath).or_default() += 1;
                }
            }
        }
        if soft_widths.len() < GLOW_MIN_EDGE * scale {
            continue;
        }
        soft_widths.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let median = soft_widths[soft_widths.len() / 2];
        if median < GLOW_MIN_WIDTH {
            continue;
        }
        // The halo fades into whatever lies beneath the soft stretches; with
        // nothing beneath (transparency) there is nothing to glow onto.
        let Some((&under, _)) = onto.iter().max_by_key(|(_, n)| **n) else { continue };
        if under == u32::MAX {
            continue;
        }
        let sigma = (median as f64 / 2.5).clamp(0.3, 20.0);
        glows.push((
            i as usize,
            under as usize,
            (sigma * 100.0).round() as u16,
        ));
        if (soft_widths.len() as f64) < GLOW_WHOLE_SHARE * total as f64 {
            let radius = (3.0 * sigma).ceil() as f32 + 1.0;
            layer.soft_zone = soft_zone(&soft_px, sw, sh, radius, scale);
        }
    }
    // Paints are set after the scan: `onto` reads the beneath layer's color.
    let luma = |c: Color| 0.299 * c.r as f32 + 0.587 * c.g as f32 + 0.114 * c.b as f32;
    for (i, under, blur) in glows {
        let onto = seg.layers[under].paint.color();
        let color = seg.layers[i].paint.color();
        if (luma(color) - luma(onto)).abs() < GLOW_MIN_CONTRAST {
            seg.layers[i].soft_zone = None;
            continue;
        }
        seg.layers[i].paint = Paint::Blurred { color, blur, onto };
    }
}

/// The band within `radius` source px of the `seeds` (source pixel indices),
/// as a mask on the working canvas (`scale`× the source).
fn soft_zone(seeds: &[usize], sw: usize, sh: usize, radius: f32, scale: usize) -> Option<RegionMask> {
    let dist = chamfer_distance(seeds, sw, sh);
    let inside = |i: usize| dist[i] <= radius;
    let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
    for y in 0..sh {
        for x in 0..sw {
            if inside(y * sw + x) {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
        }
    }
    if x0 > x1 {
        return None;
    }
    let (bw, bh) = ((x1 - x0 + 1) * scale, (y1 - y0 + 1) * scale);
    let mut image = BinaryImage::new_w_h(bw, bh);
    for y in y0..=y1 {
        for x in x0..=x1 {
            if !inside(y * sw + x) {
                continue;
            }
            for dy in 0..scale {
                for dx in 0..scale {
                    image.set_pixel((x - x0) * scale + dx, (y - y0) * scale + dy, true);
                }
            }
        }
    }
    let offset = PointI32 {
        x: (x0 * scale) as i32,
        y: (y0 * scale) as i32,
    };
    Some(RegionMask::new(image, offset))
}

/// Approximate Euclidean distance (px) from every pixel to the nearest seed:
/// a two-pass 3-4 chamfer transform, O(pixels).
fn chamfer_distance(seeds: &[usize], w: usize, h: usize) -> Vec<f32> {
    const FAR: f32 = f32::MAX / 4.0;
    let mut d = vec![FAR; w * h];
    for &s in seeds {
        d[s] = 0.0;
    }
    let (a, b) = (1.0f32, 1.4142f32);
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let mut v = d[i];
            if x > 0 {
                v = v.min(d[i - 1] + a);
            }
            if y > 0 {
                v = v.min(d[i - w] + a);
                if x > 0 {
                    v = v.min(d[i - w - 1] + b);
                }
                if x + 1 < w {
                    v = v.min(d[i - w + 1] + b);
                }
            }
            d[i] = v;
        }
    }
    for y in (0..h).rev() {
        for x in (0..w).rev() {
            let i = y * w + x;
            let mut v = d[i];
            if x + 1 < w {
                v = v.min(d[i + 1] + a);
            }
            if y + 1 < h {
                v = v.min(d[i + w] + a);
                if x + 1 < w {
                    v = v.min(d[i + w + 1] + b);
                }
                if x > 0 {
                    v = v.min(d[i + w - 1] + b);
                }
            }
            d[i] = v;
        }
    }
    d
}

/// Smooth only the soft parts of `px`: blend towards a Gaussian blur by each
/// pixel's [`softness`]. Crisp edges and their corners are left untouched.
fn smooth_soft_edges(px: &mut [[f32; 4]], w: usize, h: usize, sigma: f64, soft: &[f32]) {
    if sigma <= 0.0 {
        return;
    }
    if soft.iter().all(|&s| s == 0.0) {
        return;
    }
    let mut blurred = px.to_vec();
    gaussian_blur(&mut blurred, w, h, sigma);
    for i in 0..w * h {
        let s = soft[i];
        for c in 0..4 {
            px[i][c] += s * (blurred[i][c] - px[i][c]);
        }
    }
}

/// Premultiplied float RGBA (alpha 0-1), so interpolation and blurs do not
/// darken edges next to transparent pixels.
fn premultiplied(img: &ColorImage) -> Vec<[f32; 4]> {
    img.pixels
        .chunks_exact(4)
        .map(|p| {
            let a = p[3] as f32 / 255.0;
            [p[0] as f32 * a, p[1] as f32 * a, p[2] as f32 * a, a]
        })
        .collect()
}

/// Upscale premultiplied `src` (`w`×`h`) by `scale` with Catmull–Rom, then
/// snap every pixel to its nearest palette color (or full transparency).
fn upscale_snap(src: &[[f32; 4]], w: usize, h: usize, scale: usize, palette: &[Color]) -> ColorImage {
    let (ow, oh) = (w * scale, h * scale);

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

    /// Checkerboard of two colors in 4×4 blocks, so every block interior is
    /// flat but the two shades are both well represented.
    fn blocks(w: usize, h: usize, a: Color, b: Color) -> ColorImage {
        let mut img = ColorImage::new_w_h(w, h);
        for y in 0..h {
            for x in 0..w {
                img.set_pixel(x, y, if (x / 4 + y / 4) % 2 == 0 { &a } else { &b });
            }
        }
        img
    }

    #[test]
    fn near_blacks_merge_into_one_color() {
        // Plain OKLab puts these 0.124 apart (Apple Pay's background split
        // into two blacks and left specks); toe-corrected lightness does not.
        let palette = detect_palette(&blocks(40, 40, Color::new(0, 0, 0), Color::new(7, 6, 6)), 0);
        assert_eq!(palette.len(), 1, "got {palette:?}");
    }

    #[test]
    fn close_but_distinct_hues_stay_apart() {
        // Mastercard's red and the red-orange where its circles overlap.
        let red = Color::new(240, 2, 33);
        let overlap = Color::new(253, 85, 2);
        let palette = detect_palette(&blocks(40, 40, red, overlap), 0);
        assert_eq!(palette.len(), 2, "got {palette:?}");
    }

    /// A vertical dark-to-light edge whose ramp is `width` px wide, as
    /// premultiplied float pixels.
    fn ramp(w: usize, h: usize, width: f32) -> Vec<[f32; 4]> {
        let mut px = Vec::with_capacity(w * h);
        for _ in 0..h {
            for x in 0..w {
                let t = ((x as f32 - w as f32 / 2.0) / width + 0.5).clamp(0.0, 1.0);
                let v = 20.0 + t * 220.0;
                px.push([v, v, v, 1.0]);
            }
        }
        px
    }

    #[test]
    fn crisp_edges_are_not_soft_but_glows_are() {
        let (w, h) = (40, 12);
        let mid = |s: &[f32]| s[6 * w + w / 2];
        let crisp = softness(&ramp(w, h, 1.0), w, h);
        let glow = softness(&ramp(w, h, 8.0), w, h);
        assert!(mid(&crisp) < 0.05, "crisp edge softness {}", mid(&crisp));
        assert!(mid(&glow) > 0.9, "glow softness {}", mid(&glow));
    }

    /// A cream disc on teal whose edge is a Gaussian ramp of `sigma` px
    /// (0 = anti-aliased crisp edge).
    fn disc(sigma: f64) -> ColorImage {
        let (n, r) = (64usize, 18.0f64);
        let (bg, fg) = ([82.0, 191.0, 170.0], [240.0, 232.0, 214.0]);
        let mut img = ColorImage::new_w_h(n, n);
        for y in 0..n {
            for x in 0..n {
                let d = ((x as f64 + 0.5 - 32.0).powi(2) + (y as f64 + 0.5 - 32.0).powi(2)).sqrt() - r;
                // Coverage of the disc: a smooth step of width ~sigma.
                let s = sigma.max(0.35);
                let t = 0.5 * (1.0 - erf(d / (s * std::f64::consts::SQRT_2)));
                let c = |i: usize| (bg[i] + (fg[i] - bg[i]) * t).round() as u8;
                img.set_pixel(x, y, &Color::new(c(0), c(1), c(2)));
            }
        }
        img
    }

    /// Abramowitz–Stegun erf approximation (|error| < 1.5e-7).
    fn erf(x: f64) -> f64 {
        let t = 1.0 / (1.0 + 0.327_591_1 * x.abs());
        let y = 1.0
            - (((((1.061_405_429 * t - 1.453_152_027) * t) + 1.421_413_741) * t - 0.284_496_736) * t
                + 0.254_829_592)
                * t
                * (-x * x).exp();
        if x >= 0.0 { y } else { -y }
    }

    fn glows(img: &ColorImage) -> Vec<f64> {
        let snap = SnapFrontend {
            scale: 4,
            glow: true,
            ..SnapFrontend::default()
        };
        snap.segment(img)
            .unwrap()
            .layers
            .iter()
            .map(|l| l.paint.blur())
            .filter(|b| *b > 0.0)
            .collect()
    }

    #[test]
    fn a_soft_disc_glows_with_about_its_own_blur() {
        let blurs = glows(&disc(3.0));
        assert_eq!(blurs.len(), 1, "expected one glowing region, got {blurs:?}");
        assert!((2.0..=4.5).contains(&blurs[0]), "sigma {} not near 3", blurs[0]);
    }

    #[test]
    fn a_half_soft_disc_glows_only_along_its_soft_side() {
        // Left half of the disc's edge is a glow (sigma 3), right half crisp.
        let soft = disc(3.0);
        let mut img = disc(0.0);
        for y in 0..img.height {
            for x in 0..img.width / 2 {
                img.set_pixel(x, y, &soft.get_pixel(x, y));
            }
        }
        let snap = SnapFrontend {
            scale: 4,
            glow: true,
            ..SnapFrontend::default()
        };
        let seg = snap.segment(&img).unwrap();
        let glowing: Vec<_> = seg.layers.iter().filter(|l| l.paint.blur() > 0.0).collect();
        assert_eq!(glowing.len(), 1);
        let zone = glowing[0].soft_zone.as_ref().expect("a zone, not all round");
        // The zone is a band of ~3 sigma + 1 (about 10 px) around the soft
        // left half, which ends at the centre (x = 32). It must stop well
        // short of the crisp right edge at x = 50.
        let right_edge = (zone.offset.x as usize + zone.width()) / 4;
        assert!(right_edge <= 44, "zone reaches x={right_edge}, into the crisp side");
    }

    #[test]
    fn a_crisp_disc_does_not_glow() {
        assert!(glows(&disc(0.0)).is_empty());
    }

    #[test]
    fn auto_scale_shrinks_for_large_images() {
        let snap = SnapFrontend::default();
        assert_eq!(snap.scale_for(238, 139), 8);
        assert_eq!(snap.scale_for(1000, 1000), 2);
        assert_eq!(snap.scale_for(4000, 3000), 1);
    }
}
