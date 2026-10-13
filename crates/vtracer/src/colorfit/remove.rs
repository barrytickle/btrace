//! Region removal: erase regions picked by point (a "remove background" click)
//! or found automatically along the image border.
//!
//! Removal works on what is *visible*. Layers can overlap (stacked clustering
//! keeps solid parent masks under their children), so deleting just the
//! clicked layer could expose the layer below it instead of leaving a hole.
//! Instead, every pixel whose topmost layer is being removed is cleared from
//! *all* layers, so those pixels end up uncovered (transparent) in both
//! stacked and cutout compositing.

use visioncortex::Color;

use crate::ir::Segmentation;

use super::oklab::Oklab;
use super::ColorFitter;

/// Paints closer than this (OKLab) count as "the same color" for
/// whole-color removal and background detection.
const SAME_COLOR: f64 = 0.06;
/// Auto background removal only fires when one color covers at least this
/// share of the border pixels.
const BACKGROUND_MIN_BORDER_SHARE: f64 = 0.25;

/// One removal request, in source-image pixel coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Removal {
    pub x: f64,
    pub y: f64,
    /// Remove every region of the clicked region's color, not just the one
    /// under the point (for backgrounds that show through gaps, such as the
    /// inside of an "O").
    pub whole_color: bool,
}

/// Erase the regions picked by [`Removal`]s and, optionally, the background.
#[derive(Debug, Clone, Default)]
pub struct RemoveRegions {
    pub removals: Vec<Removal>,
    /// Remove the background: the color covering most of the image border,
    /// in every region of that color that touches the border.
    pub background: bool,
}

impl RemoveRegions {
    pub fn is_empty(&self) -> bool {
        self.removals.is_empty() && !self.background
    }
}

const NONE: u32 = u32::MAX;

/// Index of the topmost layer covering each canvas pixel (`NONE` if none).
fn topmost(seg: &Segmentation) -> Vec<u32> {
    let (w, h) = (seg.width as usize, seg.height as usize);
    let mut top = vec![NONE; w * h];
    for (i, layer) in seg.layers.iter().enumerate() {
        let m = &layer.mask;
        for y in 0..m.height() {
            for x in 0..m.width() {
                if !m.image.get_pixel(x, y) {
                    continue;
                }
                let (cx, cy) = (x as i32 + m.offset.x, y as i32 + m.offset.y);
                if cx >= 0 && cy >= 0 && (cx as usize) < w && (cy as usize) < h {
                    top[cy as usize * w + cx as usize] = i as u32;
                }
            }
        }
    }
    top
}

fn same_color(a: &Color, b: &Color) -> bool {
    Oklab::from_color_toe(a).distance_squared(&Oklab::from_color_toe(b)) < SAME_COLOR * SAME_COLOR
}

/// Pixels along the canvas border, each once.
fn border_pixels(w: usize, h: usize) -> impl Iterator<Item = usize> {
    let top_bottom = (0..w).flat_map(move |x| {
        let bottom = (h > 1).then_some((h - 1) * w + x);
        std::iter::once(x).chain(bottom)
    });
    let sides = (1..h.saturating_sub(1)).flat_map(move |y| {
        let right = (w > 1).then_some(y * w + w - 1);
        std::iter::once(y * w).chain(right)
    });
    top_bottom.chain(sides)
}

impl ColorFitter for RemoveRegions {
    fn fit(&self, seg: &mut Segmentation) {
        if self.is_empty() || seg.layers.is_empty() {
            return;
        }
        let (w, h) = (seg.width as usize, seg.height as usize);
        let top = topmost(seg);
        let paints: Vec<Color> = seg.layers.iter().map(|l| l.paint.color()).collect();
        let mut remove = vec![false; seg.layers.len()];

        let mark_color = |remove: &mut Vec<bool>, color: &Color, only: Option<&[bool]>| {
            for (i, p) in paints.iter().enumerate() {
                if only.map_or(true, |o| o[i]) && same_color(p, color) {
                    remove[i] = true;
                }
            }
        };

        // Clicked points: source pixels -> working canvas.
        let s = seg.scale.max(1) as f64;
        for r in &self.removals {
            let (x, y) = ((r.x * s).floor(), (r.y * s).floor());
            if x < 0.0 || y < 0.0 || x >= w as f64 || y >= h as f64 {
                continue;
            }
            let t = top[y as usize * w + x as usize];
            if t == NONE {
                continue;
            }
            if r.whole_color {
                mark_color(&mut remove, &paints[t as usize], None);
            } else {
                remove[t as usize] = true;
            }
        }

        if self.background {
            // Border coverage per visible layer.
            let mut on_border = vec![0usize; seg.layers.len()];
            let mut total = 0usize;
            for i in border_pixels(w, h) {
                total += 1;
                if top[i] != NONE {
                    on_border[top[i] as usize] += 1;
                }
            }
            // The color whose layers cover the most border pixels.
            let best = (0..paints.len())
                .filter(|&i| on_border[i] > 0)
                .map(|i| {
                    let share: usize = (0..paints.len())
                        .filter(|&j| on_border[j] > 0 && same_color(&paints[i], &paints[j]))
                        .map(|j| on_border[j])
                        .sum();
                    (i, share)
                })
                .max_by_key(|&(_, share)| share);
            if let Some((i, share)) = best {
                if share as f64 >= total as f64 * BACKGROUND_MIN_BORDER_SHARE {
                    let touches: Vec<bool> = on_border.iter().map(|&n| n > 0).collect();
                    mark_color(&mut remove, &paints[i], Some(&touches));
                }
            }
        }

        if !remove.iter().any(|&r| r) {
            return;
        }

        // Clear every pixel whose visible layer is removed, from all layers.
        for layer in &mut seg.layers {
            let (ox, oy) = (layer.mask.offset.x, layer.mask.offset.y);
            let m = &mut layer.mask.image;
            for y in 0..m.height {
                for x in 0..m.width {
                    if !m.get_pixel(x, y) {
                        continue;
                    }
                    let (cx, cy) = (x as i32 + ox, y as i32 + oy);
                    if cx < 0 || cy < 0 || cx as usize >= w || cy as usize >= h {
                        continue;
                    }
                    let t = top[cy as usize * w + cx as usize];
                    if t != NONE && remove[t as usize] {
                        m.set_pixel(x, y, false);
                    }
                }
            }
        }
        let mut i = 0;
        seg.layers.retain(|l| {
            let keep = !remove[i] && l.mask.area() > 0;
            i += 1;
            keep
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{Layer, Paint, RegionMask};
    use visioncortex::{BinaryImage, PointI32};

    /// A `w`×`h` layer filled over `rect` = (x0, y0, x1, y1), exclusive.
    fn layer(w: u32, h: u32, rect: (u32, u32, u32, u32), color: Color) -> Layer {
        let mut img = BinaryImage::new_w_h(w as usize, h as usize);
        for y in rect.1..rect.3 {
            for x in rect.0..rect.2 {
                img.set_pixel(x as usize, y as usize, true);
            }
        }
        Layer {
            paint: Paint::Solid(color),
            mask: RegionMask::new(img, PointI32 { x: 0, y: 0 }),
        }
    }

    const WHITE: Color = Color { r: 255, g: 255, b: 255, a: 255 };
    const BLUE: Color = Color { r: 20, g: 60, b: 200, a: 255 };

    /// White 20×20 background, a blue 10×10 square at (5,5), and a white
    /// "counter" inside the square at (8,8)-(12,12), like the hole of an O.
    fn icon() -> Segmentation {
        let mut seg = Segmentation::new(20, 20);
        seg.layers.push(layer(20, 20, (0, 0, 20, 20), WHITE));
        seg.layers.push(layer(20, 20, (5, 5, 15, 15), BLUE));
        seg.layers.push(layer(20, 20, (8, 8, 12, 12), WHITE));
        seg
    }

    fn covered(seg: &Segmentation, x: usize, y: usize) -> bool {
        topmost(seg)[y * seg.width as usize + x] != NONE
    }

    #[test]
    fn click_removes_only_the_visible_region_under_the_point() {
        let mut seg = icon();
        RemoveRegions {
            removals: vec![Removal { x: 1.0, y: 1.0, whole_color: false }],
            background: false,
        }
        .fit(&mut seg);
        assert!(!covered(&seg, 1, 1), "background should be gone");
        assert!(covered(&seg, 6, 6), "blue square stays");
        assert!(covered(&seg, 10, 10), "inner white is a separate region; stays");
    }

    #[test]
    fn whole_color_click_also_clears_the_counter() {
        let mut seg = icon();
        RemoveRegions {
            removals: vec![Removal { x: 1.0, y: 1.0, whole_color: true }],
            background: false,
        }
        .fit(&mut seg);
        assert!(!covered(&seg, 1, 1));
        assert!(!covered(&seg, 10, 10), "counter is the same white");
        assert!(covered(&seg, 6, 6));
    }

    #[test]
    fn removing_a_child_leaves_a_hole_not_the_parent() {
        // Click the counter: the blue square's solid mask must not fill it.
        let mut seg = icon();
        RemoveRegions {
            removals: vec![Removal { x: 10.0, y: 10.0, whole_color: false }],
            background: false,
        }
        .fit(&mut seg);
        assert!(!covered(&seg, 10, 10));
        assert!(covered(&seg, 1, 1) && covered(&seg, 6, 6));
    }

    #[test]
    fn auto_background_takes_the_border_color_that_touches_the_border() {
        let mut seg = icon();
        RemoveRegions { removals: vec![], background: true }.fit(&mut seg);
        assert!(!covered(&seg, 1, 1));
        assert!(covered(&seg, 6, 6));
        assert!(covered(&seg, 10, 10), "counter does not touch the border");
    }

    #[test]
    fn click_coordinates_follow_the_working_scale() {
        let mut seg = icon();
        seg.scale = 4; // working canvas is 4× the source
        RemoveRegions {
            removals: vec![Removal { x: 2.5, y: 2.5, whole_color: false }], // -> (10,10)
            background: false,
        }
        .fit(&mut seg);
        assert!(!covered(&seg, 10, 10));
        assert!(covered(&seg, 1, 1));
    }
}
