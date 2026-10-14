//! A quick look at an image before tracing it: what kind of image it is, its
//! palette, its background, and whether it has soft edges. The app turns this
//! into recommendations ("Looks like a logo", "Remove the white background").
//!
//! Everything here reuses the snap frontend's own measurements (the palette
//! detector and the soft-edge map), so the advice matches what tracing does.

use visioncortex::{Color, ColorImage};

use super::{edge_map, palette_clusters, premultiplied, OPAQUE};
use crate::colorfit::oklab::Oklab;

/// A palette colour and how much of the image it covers.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Swatch {
    pub color: Color,
    /// Share (0-1): of the flat pixels for a palette entry, of the border
    /// pixels for a background.
    pub share: f64,
}

/// What kind of image this looks like; each maps to a set of trace settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageKind {
    /// Few flat colours, crisp edges.
    Logo,
    /// Flat colours, but many of them or with soft glows.
    Illustration,
    /// Shading and gradients: a photo or painted art.
    Detailed,
    /// Ink on paper: dark and light only.
    BlackAndWhite,
}

impl ImageKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ImageKind::Logo => "logo",
            ImageKind::Illustration => "illustration",
            ImageKind::Detailed => "detailed",
            ImageKind::BlackAndWhite => "bw",
        }
    }
}

/// See [`analyse`].
#[derive(Debug, Clone)]
pub struct Analysis {
    pub kind: ImageKind,
    /// The flat colours, most common first (what "N colours" keeps the top
    /// N of). Tiny clusters are already dropped.
    pub palette: Vec<Swatch>,
    /// Pairs of palette entries (indices) so alike they may be one colour.
    pub near_duplicates: Vec<(usize, usize)>,
    /// Share of opaque pixels in flat areas (high for logos, low for photos).
    pub flat_share: f64,
    /// Share of opaque pixels on soft edges: glows, blur.
    pub soft_share: f64,
    /// Share of pixels that are see-through.
    pub transparent_share: f64,
    /// The palette colour covering most of the border, if any covers much.
    pub background: Option<Swatch>,
    /// Whether removing that background is the better default.
    pub remove_background: bool,
}

/// A palette entry covering less than this share doesn't count as one of the
/// image's colours when judging its kind (speckles, edge shades).
const SIGNIFICANT_SHARE: f64 = 0.005;
/// Oklab distance under which two palette entries look like one colour.
const NEAR_DUPLICATE: f64 = 0.12;
/// Oklab distance for a border pixel to count as a palette colour.
const BORDER_MATCH: f64 = 0.1;
/// Soft-edge share above which an image has glows worth keeping.
const GLOW_SHARE: f64 = 0.02;
/// Soft-edge share above which an image is a photo: soft almost everywhere,
/// not a few glows (an illustration's moon glow is ~3%, a photo ~30%).
const PHOTO_SOFT_SHARE: f64 = 0.15;

/// Look at `img` and describe it. Cost: one soft-edge map and one palette
/// detection, about what the first stage of a snap trace costs.
pub fn analyse(img: &ColorImage) -> Analysis {
    let (w, h) = (img.width, img.height);
    let n = (w * h).max(1);
    let src = premultiplied(img);
    let edges = edge_map(&src, w, h);
    let (clusters, flat_total) = palette_clusters(img, Some(&edges.soft));

    let alpha = |i: usize| img.pixels[i * 4 + 3];
    let opaque = (0..w * h).filter(|&i| alpha(i) >= OPAQUE).count().max(1);
    let transparent = (0..w * h).filter(|&i| alpha(i) < 250).count();
    let soft = (0..w * h).filter(|&i| alpha(i) >= OPAQUE && edges.soft[i] > 0.3).count();

    let palette: Vec<Swatch> = clusters
        .iter()
        .map(|c| Swatch { color: c.color(), share: c.count as f64 / flat_total.max(1) as f64 })
        .collect();
    let labs: Vec<Oklab> = palette.iter().map(|s| Oklab::from_color_toe(&s.color)).collect();

    let mut near_duplicates = Vec::new();
    for i in 0..labs.len() {
        for j in i + 1..labs.len() {
            if labs[i].distance_squared(&labs[j]) < NEAR_DUPLICATE * NEAR_DUPLICATE {
                near_duplicates.push((i, j));
            }
        }
    }

    // Border: which palette colour covers the most of it.
    let mut on_border = vec![0usize; palette.len()];
    let mut border = 0usize;
    for i in border_pixels(w, h) {
        border += 1;
        let p = img.get_pixel(i % w, i / w);
        if p.a < OPAQUE {
            continue;
        }
        let lab = Oklab::from_color_toe(&p);
        let best = (0..labs.len())
            .map(|k| (k, labs[k].distance_squared(&lab)))
            .min_by(|a, b| a.1.total_cmp(&b.1));
        if let Some((k, d)) = best {
            if d < BORDER_MATCH * BORDER_MATCH {
                on_border[k] += 1;
            }
        }
    }
    let background = (0..palette.len())
        .max_by_key(|&k| on_border[k])
        .map(|k| Swatch { color: palette[k].color, share: on_border[k] as f64 / border.max(1) as f64 })
        .filter(|s| s.share >= 0.5);

    let flat_share = flat_total as f64 / opaque as f64;
    let soft_share = soft as f64 / opaque as f64;
    let significant: Vec<&Swatch> = palette.iter().filter(|s| s.share >= SIGNIFICANT_SHARE).collect();
    let ink_or_paper = |c: &Color| {
        let lab = Oklab::from_color(c);
        (lab.a * lab.a + lab.b * lab.b).sqrt() < 0.03 && (lab.l < 0.35 || lab.l > 0.85)
    };
    // Ink on paper: dark lines on a mostly light, opaque page, or dark lines
    // alone. White letters on a black card are a logo: tracing it as B&W
    // would turn the letters into holes.
    let paper: f64 = significant.iter().filter(|s| Oklab::from_color(&s.color).l > 0.85).map(|s| s.share).sum();
    let opaque_page = (transparent as f64 / n as f64) < 0.01;
    let ink_on_paper = paper == 0.0 || (paper >= 0.5 && opaque_page);
    let kind = if !significant.is_empty()
        && significant.len() <= 2
        && significant.iter().all(|s| ink_or_paper(&s.color))
        && ink_on_paper
    {
        ImageKind::BlackAndWhite
    } else if flat_share < 0.5 || significant.len() > 12 || soft_share >= PHOTO_SOFT_SHARE {
        ImageKind::Detailed
    } else if soft_share >= GLOW_SHARE || significant.len() >= 7 {
        ImageKind::Illustration
    } else {
        ImageKind::Logo
    };

    // A colour all round the edge is a background. Remove it by default when
    // it's plain white-ish, or the image is a logo (a badge on a coloured
    // square); a dark edge round an illustration is usually part of it.
    let light = |c: &Color| Oklab::from_color(c).l > 0.9;
    let remove_background = transparent as f64 / (n as f64) < 0.01
        && background.is_some_and(|b| b.share >= 0.9 && (light(&b.color) || kind == ImageKind::Logo));

    Analysis {
        kind,
        palette,
        near_duplicates,
        flat_share,
        soft_share,
        transparent_share: transparent as f64 / n as f64,
        background,
        remove_background,
    }
}

/// Pixel indices along the image border, each once.
fn border_pixels(w: usize, h: usize) -> impl Iterator<Item = usize> {
    let top = 0..w;
    let bottom = (0..w).filter(move |_| h > 1).map(move |x| (h - 1) * w + x);
    let sides = (1..h.saturating_sub(1)).flat_map(move |y| {
        let right = if w > 1 { Some(y * w + w - 1) } else { None };
        std::iter::once(y * w).chain(right)
    });
    top.chain(bottom).chain(sides)
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
    fn logo_on_white_has_a_white_background_to_remove() {
        let img = image(60, 40, |x, y| {
            if (15..45).contains(&x) && (10..30).contains(&y) { [29, 43, 83, 255] } else { [255, 255, 255, 255] }
        });
        let a = analyse(&img);
        assert_eq!(a.kind, ImageKind::Logo);
        assert_eq!(a.palette.len(), 2);
        assert_eq!(a.background.map(|b| b.color), Some(Color::new(255, 255, 255)));
        assert!(a.remove_background);
    }

    #[test]
    fn black_ink_on_white_is_black_and_white() {
        let img = image(60, 40, |x, _| if x % 10 < 3 { [10, 10, 10, 255] } else { [250, 250, 250, 255] });
        assert_eq!(analyse(&img).kind, ImageKind::BlackAndWhite);
    }

    #[test]
    fn white_letters_on_a_black_card_are_a_logo() {
        let img = image(60, 40, |x, _| if x % 10 < 2 { [250, 250, 250, 255] } else { [5, 5, 5, 255] });
        assert_eq!(analyse(&img).kind, ImageKind::Logo);
    }

    #[test]
    fn soft_everywhere_is_a_photo() {
        // Soft bands, 16 px apart: wide ramps everywhere, like a photo.
        let img = image(120, 120, |x, _| {
            let v = (127.5 + 127.5 * (x as f64 * std::f64::consts::PI / 8.0).sin()) as u8;
            [v, v, v / 2, 255]
        });
        assert_eq!(analyse(&img).kind, ImageKind::Detailed);
    }

    #[test]
    fn transparent_image_has_no_background_to_remove() {
        let img = image(40, 40, |x, y| {
            if (10..30).contains(&x) && (10..30).contains(&y) { [200, 40, 40, 255] } else { [0, 0, 0, 0] }
        });
        let a = analyse(&img);
        assert!(a.background.is_none());
        assert!(!a.remove_background);
        assert!(a.transparent_share > 0.5);
    }

    #[test]
    fn border_pixels_are_each_visited_once() {
        let mut seen: Vec<usize> = border_pixels(5, 4).collect();
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), 5 * 2 + 2 * 2);
        assert_eq!(border_pixels(1, 1).count(), 1);
    }
}
