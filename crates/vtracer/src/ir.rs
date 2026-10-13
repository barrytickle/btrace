//! Core intermediate representation shared by the pipeline stages.
//!
//! Two IRs flow through the pipeline:
//!
//! * [`Segmentation`] — the frontend output: ordered paint layers over a
//!   raster canvas (painter's algorithm, bottom to top). This is what the
//!   [`crate::colorfit`] stages rewrite.
//! * [`VectorDoc`] — the output document: resolved shapes with fitted paths.
//!   This is what the [`crate::optimize`] passes and the [`crate::svg`] writer
//!   operate on.

mod region;
mod vector;

pub use region::{Layer, RegionMask, Segmentation};
pub use vector::{MultiPath, PathCmd, Shape, SubPath, VectorDoc};

use visioncortex::Color;

/// The final appearance of a region.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Paint {
    Solid(Color),
    /// A solid color that glows: drawn crisp, over a halo of itself that
    /// fades into the `onto` color beneath it (glows, soft light). `blur` is
    /// the halo's Gaussian standard deviation in hundredths of a source
    /// pixel. The halo only ever appears over `onto`-colored shapes.
    Blurred { color: Color, blur: u16, onto: Color },
}

impl Paint {
    /// The representative solid color of this paint.
    pub fn color(&self) -> Color {
        match self {
            Paint::Solid(c) | Paint::Blurred { color: c, .. } => *c,
        }
    }

    /// Edge blur (standard deviation, source px), or 0 for a hard edge.
    pub fn blur(&self) -> f64 {
        match self {
            Paint::Solid(_) => 0.0,
            Paint::Blurred { blur, .. } => *blur as f64 / 100.0,
        }
    }
}
