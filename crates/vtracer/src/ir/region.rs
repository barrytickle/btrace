use visioncortex::{BinaryImage, PointI32};

use super::Paint;

/// A region's pixel coverage: a local binary mask positioned on the canvas.
///
/// Foreground pixels are `true`. Holes (interior background) are already
/// punched out of the mask, so a mask is self-describing for tracing.
#[derive(Debug, Clone)]
pub struct RegionMask {
    /// Local coverage; `true` = inside the region.
    pub image: BinaryImage,
    /// Position of the mask's top-left corner in full-canvas coordinates.
    pub offset: PointI32,
}

impl RegionMask {
    pub fn new(image: BinaryImage, offset: PointI32) -> Self {
        Self { image, offset }
    }

    pub fn width(&self) -> usize {
        self.image.width
    }

    pub fn height(&self) -> usize {
        self.image.height
    }

    /// Number of foreground pixels.
    pub fn area(&self) -> usize {
        let mut count = 0;
        for y in 0..self.image.height {
            for x in 0..self.image.width {
                if self.image.get_pixel(x, y) {
                    count += 1;
                }
            }
        }
        count
    }

    /// Combine two masks into one covering the union of their bounding boxes.
    /// Foreground is the OR of both; this is used by the layer-merge step.
    pub fn union(&self, other: &RegionMask) -> RegionMask {
        Self::union_all(&[self, other])
    }

    /// Union any number of masks in one pass: size the destination from the
    /// combined bounding box, then blit each source into it exactly once.
    ///
    /// Folding [`union`](Self::union) instead costs one full-size allocation and
    /// rewrite of the accumulator *per input*. That is quadratic in the canvas
    /// area, and it bites precisely when a palette snap leaves a long run of
    /// same-paint layers for [`MergeAdjacent`](crate::colorfit::MergeAdjacent):
    /// the accumulator grows to the full canvas after the first few merges, so
    /// every remaining layer copies the entire canvas again.
    ///
    /// An empty input yields an empty mask at the origin.
    pub fn union_all(masks: &[&RegionMask]) -> RegionMask {
        let Some((first, rest)) = masks.split_first() else {
            return RegionMask::new(BinaryImage::new_w_h(0, 0), PointI32 { x: 0, y: 0 });
        };

        let mut left = first.offset.x;
        let mut top = first.offset.y;
        let mut right = first.offset.x + first.image.width as i32;
        let mut bottom = first.offset.y + first.image.height as i32;
        for m in rest {
            left = left.min(m.offset.x);
            top = top.min(m.offset.y);
            right = right.max(m.offset.x + m.image.width as i32);
            bottom = bottom.max(m.offset.y + m.image.height as i32);
        }

        let width = (right - left) as usize;
        let height = (bottom - top) as usize;
        let mut image = BinaryImage::new_w_h(width, height);

        for src in masks {
            let dx = (src.offset.x - left) as usize;
            let dy = (src.offset.y - top) as usize;
            for y in 0..src.image.height {
                for x in 0..src.image.width {
                    if src.image.get_pixel(x, y) {
                        image.set_pixel(x + dx, y + dy, true);
                    }
                }
            }
        }

        RegionMask::new(image, PointI32 { x: left, y: top })
    }
}

/// A single paint layer. Layers are painted bottom-to-top.
#[derive(Debug, Clone)]
pub struct Layer {
    /// Fill applied to the region. Starts as the cluster's mean color; a
    /// [`crate::colorfit::ColorFitter`] may rewrite it.
    pub paint: Paint,
    /// Pixel coverage of the region.
    pub mask: RegionMask,
    /// Where a [`Paint::Blurred`] layer's halo may appear: a band around the
    /// soft stretches of its edge. `None` = all round.
    pub soft_zone: Option<RegionMask>,
}

/// Frontend output: ordered layers over a canvas, in paint order.
#[derive(Debug, Clone)]
pub struct Segmentation {
    pub width: u32,
    pub height: u32,
    /// Bottom-to-top paint order.
    pub layers: Vec<Layer>,
    /// Working pixels per source pixel. A frontend that upscales before
    /// segmenting sets this; the pipeline divides the fitted geometry by it.
    pub scale: u32,
}

impl Segmentation {
    /// Index of the topmost layer covering each canvas pixel, row-major, or
    /// `u32::MAX` where no layer does. This is what is *visible*: layers can
    /// overlap (solid parents sit under their children).
    pub fn topmost(&self) -> Vec<u32> {
        let (w, h) = (self.width as usize, self.height as usize);
        let mut top = vec![u32::MAX; w * h];
        for (i, layer) in self.layers.iter().enumerate() {
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

    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            layers: Vec::new(),
            scale: 1,
        }
    }
}
