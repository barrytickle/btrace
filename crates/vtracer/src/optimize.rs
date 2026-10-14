//! Optimizer passes over the [`VectorDoc`] before serialization.
//!
//! * [`QuantizePass`] — round every coordinate once, in document space. Doing
//!   it here (rather than at write time) lets [`CleanupPass`] act on the
//!   rounded geometry, and it bakes offsets into coordinates so the writer
//!   never needs a per-path `translate`.
//! * [`CleanupPass`] — drop zero-length and collinear-redundant segments that
//!   quantization may have created.
//! * [`CropPass`] — trim the canvas to the drawing's exact bounds (plus
//!   padding), like svgcrop.com but from the geometry rather than pixels. (Curve *simplification* is not an
//!   optimizer pass: it must run on shared fitted geometry before composition
//!   — see [`crate::simplify`].)

use visioncortex::PointF64;

use crate::ir::{MultiPath, PathCmd, Shape, SubPath, VectorDoc};

/// An optimizer pass rewrites the document in place.
pub trait OptimizerPass {
    fn run(&self, doc: &mut VectorDoc);
}

/// Round all coordinates to `precision` decimal places.
#[derive(Debug, Clone, Copy)]
pub struct QuantizePass {
    pub precision: u32,
}

impl QuantizePass {
    pub fn new(precision: u32) -> Self {
        Self { precision }
    }

    fn round(&self, v: f64) -> f64 {
        let factor = 10f64.powi(self.precision as i32);
        (v * factor).round() / factor
    }

    fn round_pt(&self, p: PointF64) -> PointF64 {
        PointF64 {
            x: self.round(p.x),
            y: self.round(p.y),
        }
    }
}

impl OptimizerPass for QuantizePass {
    fn run(&self, doc: &mut VectorDoc) {
        for shape in &mut doc.shapes {
            for sub in shape.paths_mut().flat_map(|p| p.subpaths.iter_mut()) {
                for cmd in &mut sub.commands {
                    *cmd = match *cmd {
                        PathCmd::MoveTo(p) => PathCmd::MoveTo(self.round_pt(p)),
                        PathCmd::LineTo(p) => PathCmd::LineTo(self.round_pt(p)),
                        PathCmd::CubicTo(c1, c2, e) => PathCmd::CubicTo(
                            self.round_pt(c1),
                            self.round_pt(c2),
                            self.round_pt(e),
                        ),
                        PathCmd::Close => PathCmd::Close,
                    };
                }
            }
        }
    }
}

/// Remove zero-length segments and collinear-redundant line vertices.
#[derive(Debug, Clone, Copy, Default)]
pub struct CleanupPass;

/// Tolerance for treating two points as coincident.
const COINCIDENT_EPS: f64 = 1e-6;
/// Perpendicular-distance tolerance for treating three points as collinear.
const COLLINEAR_EPS: f64 = 1e-4;

fn approx_eq(a: PointF64, b: PointF64) -> bool {
    (a.x - b.x).abs() < COINCIDENT_EPS && (a.y - b.y).abs() < COINCIDENT_EPS
}

/// Perpendicular distance of `b` from the line through `a` and `c`.
fn collinear(a: PointF64, b: PointF64, c: PointF64) -> bool {
    let cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    let base = ((c.x - a.x).powi(2) + (c.y - a.y).powi(2)).sqrt();
    if base < COINCIDENT_EPS {
        return true;
    }
    (cross.abs() / base) < COLLINEAR_EPS
}

/// Distance (px) a handle may sit off the chord and still count as on it.
/// Covers coordinate rounding at the default 2 decimal places.
const STRAIGHT_EPS: f64 = 0.02;

/// Whether the cubic `s, c1, c2, e` is a straight segment: both handles on
/// the chord, between its ends. Such a curve traces exactly the chord.
fn straight_cubic(s: PointF64, c1: PointF64, c2: PointF64, e: PointF64) -> bool {
    let (dx, dy) = (e.x - s.x, e.y - s.y);
    let len2 = dx * dx + dy * dy;
    if len2 < COINCIDENT_EPS {
        return false;
    }
    let len = len2.sqrt();
    [c1, c2].iter().all(|c| {
        let (px, py) = (c.x - s.x, c.y - s.y);
        let off = (px * dy - py * dx).abs() / len;
        let t = (px * dx + py * dy) / len2;
        off <= STRAIGHT_EPS && (-1e-6..=1.0 + 1e-6).contains(&t)
    })
}

/// [`cleanup_subpath`] over a whole path, dropping subpaths left without
/// geometry (a MoveTo plus at least one drawing command beyond Close).
fn cleanup_path(path: &MultiPath) -> MultiPath {
    let subpaths = path
        .subpaths
        .iter()
        .map(cleanup_subpath)
        .filter(|s| {
            s.commands
                .iter()
                .any(|c| matches!(c, PathCmd::LineTo(_) | PathCmd::CubicTo(..)))
        })
        .collect();
    MultiPath { subpaths }
}

fn cleanup_subpath(sub: &SubPath) -> SubPath {
    let mut out = SubPath::new();
    // `prev` is the point active before the last emitted command; `last` is the
    // current point after it. Both are needed to test collinearity of a run.
    let mut prev = PointF64::default();
    let mut last = PointF64::default();

    for cmd in &sub.commands {
        match *cmd {
            PathCmd::MoveTo(p) => {
                out.commands.push(PathCmd::MoveTo(p));
                prev = p;
                last = p;
            }
            PathCmd::LineTo(p) => {
                if approx_eq(last, p) {
                    continue; // zero-length
                }
                if let Some(PathCmd::LineTo(_)) = out.commands.last() {
                    if collinear(prev, last, p) {
                        *out.commands.last_mut().unwrap() = PathCmd::LineTo(p);
                        last = p; // anchor `prev` unchanged
                        continue;
                    }
                }
                out.commands.push(PathCmd::LineTo(p));
                prev = last;
                last = p;
            }
            PathCmd::CubicTo(c1, c2, e) if straight_cubic(last, c1, c2, e) => {
                // A cubic whose handles lie on its chord traces the chord:
                // write it as a line (and let the line rules above merge it).
                if approx_eq(last, e) {
                    continue;
                }
                if let Some(PathCmd::LineTo(_)) = out.commands.last() {
                    if collinear(prev, last, e) {
                        *out.commands.last_mut().unwrap() = PathCmd::LineTo(e);
                        last = e;
                        continue;
                    }
                }
                out.commands.push(PathCmd::LineTo(e));
                prev = last;
                last = e;
            }
            PathCmd::CubicTo(c1, c2, e) => {
                out.commands.push(PathCmd::CubicTo(c1, c2, e));
                prev = last;
                last = e;
            }
            PathCmd::Close => {
                out.commands.push(PathCmd::Close);
            }
        }
    }

    out
}

impl OptimizerPass for CleanupPass {
    fn run(&self, doc: &mut VectorDoc) {
        for shape in &mut doc.shapes {
            shape.path = cleanup_path(&shape.path);
            shape.soft_zone = shape
                .soft_zone
                .as_ref()
                .map(cleanup_path)
                .filter(|z| !z.is_empty());
        }
        doc.shapes.retain(|s| !s.path.is_empty());
    }
}

/// Trim the canvas to the exact bounding box of every shape, plus `padding`
/// px on each side. Curves count by their true extent (a cubic can bulge
/// past its endpoints), not their control points.
///
/// The canvas is whole pixels, so its size rounds up; the drawing is centred
/// in that fractional slack (under half a pixel per side). Run before
/// [`QuantizePass`] so rounding happens on the final coordinates.
#[derive(Debug, Clone, Copy, Default)]
pub struct CropPass {
    pub padding: f64,
}

/// Exact bounds of a document's geometry: (min, max), or `None` if empty.
pub fn bounds(doc: &VectorDoc) -> Option<(PointF64, PointF64)> {
    doc.shapes.iter().filter_map(shape_bounds).reduce(union)
}

/// Exact bounds of one shape (a blurred edge counts by its visible spread).
pub fn shape_bounds(shape: &Shape) -> Option<(PointF64, PointF64)> {
    // A blurred edge spreads visibly about 3 sigma beyond the path.
    let spread = 3.0 * shape.paint.blur();
    shape.path.subpaths.iter().filter_map(|sub| subpath_bounds(sub, spread)).reduce(union)
}

fn union((a, b): (PointF64, PointF64), (c, d): (PointF64, PointF64)) -> (PointF64, PointF64) {
    (PointF64 { x: a.x.min(c.x), y: a.y.min(c.y) }, PointF64 { x: b.x.max(d.x), y: b.y.max(d.y) })
}

/// Exact bounds of one outline, grown by `spread` on every side.
fn subpath_bounds(sub: &SubPath, spread: f64) -> Option<(PointF64, PointF64)> {
    let mut min = PointF64 { x: f64::INFINITY, y: f64::INFINITY };
    let mut max = PointF64 { x: f64::NEG_INFINITY, y: f64::NEG_INFINITY };
    let mut add = |p: PointF64| {
        min.x = min.x.min(p.x - spread);
        min.y = min.y.min(p.y - spread);
        max.x = max.x.max(p.x + spread);
        max.y = max.y.max(p.y + spread);
    };
    let mut cur = PointF64::default();
    for cmd in &sub.commands {
        match *cmd {
            PathCmd::MoveTo(p) | PathCmd::LineTo(p) => {
                add(p);
                cur = p;
            }
            PathCmd::CubicTo(c1, c2, e) => {
                add(e);
                for t in cubic_extrema(cur, c1, c2, e) {
                    add(cubic_at(cur, c1, c2, e, t));
                }
                cur = e;
            }
            PathCmd::Close => {}
        }
    }
    (min.x <= max.x).then_some((min, max))
}

/// Largest side of a stray shape, as a share of the canvas's shorter side.
const STRAY_SIZE: f64 = 0.04;
/// A shape this close (share of the shorter side) to another of its colour
/// belongs with it: the dot of an "i", a full stop after a word.
const STRAY_GAP: f64 = 0.025;

/// Tiny shapes with no other shape of their colour nearby: the specks a
/// compressed or scanned image leaves behind. Returns a point inside each
/// (its centre), in canvas px, ready to use as a removal click.
pub fn strays(doc: &VectorDoc) -> Vec<PointF64> {
    let short = doc.width.min(doc.height) as f64;
    let max_side = (STRAY_SIZE * short).max(2.0);
    let gap = (STRAY_GAP * short).max(3.0);
    // Judge each outline on its own: shapes of one colour are often merged
    // into one path, so a speck can share a shape with the logo it's near.
    struct Piece<'a> {
        sub: &'a SubPath,
        shape: usize,
        color: visioncortex::Color,
        blurred: bool,
        bounds: (PointF64, PointF64),
        outline: Vec<PointF64>,
    }
    let pieces: Vec<Piece> = doc
        .shapes
        .iter()
        .enumerate()
        .flat_map(|(k, shape)| {
            shape.path.subpaths.iter().filter_map(move |sub| {
                subpath_bounds(sub, 0.0).map(|bounds| Piece {
                    sub,
                    shape: k,
                    color: shape.paint.color(),
                    blurred: shape.paint.blur() > 0.0,
                    bounds,
                    outline: flatten(sub),
                })
            })
        })
        .collect();
    let mut out = Vec::new();
    for (i, p) in pieces.iter().enumerate() {
        let (a, z) = p.bounds;
        if p.blurred || (z.x - a.x).max(z.y - a.y) > max_side {
            continue;
        }
        let centre = PointF64 { x: (a.x + z.x) / 2.0, y: (a.y + z.y) / 2.0 };
        // The removal click must land on the speck itself.
        if !inside(&p.outline, centre) {
            continue;
        }
        // A hole (an outline inside another outline of its own shape) is a
        // gap in that shape, not a shape of its own: never a stray.
        let hole = pieces.iter().enumerate().any(|(j, o)| {
            j != i && o.shape == p.shape && box_gap(p.bounds, o.bounds) == 0.0 && inside(&o.outline, centre)
        });
        if hole {
            continue;
        }
        let radius = (z.x - a.x).max(z.y - a.y) / 2.0;
        // Near another outline of its colour: within `gap` of the outline
        // itself (a box check alone would call a speck in the corner of a
        // circle's bounding box "near"). Holes are near their own outer edge.
        let near = pieces.iter().enumerate().any(|(j, o)| {
            j != i
                && o.color == p.color
                && box_gap(p.bounds, o.bounds) <= gap
                && outline_distance(o.sub, centre) - radius <= gap
        });
        if !near {
            out.push(centre);
        }
    }
    out
}

/// Distance from `p` to an outline: exact along straight edges, curves
/// split into short straight pieces.
fn outline_distance(sub: &SubPath, p: PointF64) -> f64 {
    let mut best = f64::INFINITY;
    let mut edge = |a: PointF64, b: PointF64| best = best.min(segment_distance(p, a, b));
    {
        let mut cur = PointF64::default();
        let mut start = cur;
        for cmd in &sub.commands {
            match *cmd {
                PathCmd::MoveTo(q) => {
                    cur = q;
                    start = q;
                }
                PathCmd::LineTo(q) => {
                    edge(cur, q);
                    cur = q;
                }
                PathCmd::CubicTo(c1, c2, e) => {
                    let mut prev = cur;
                    for k in 1..=16 {
                        let q = cubic_at(cur, c1, c2, e, k as f64 / 16.0);
                        edge(prev, q);
                        prev = q;
                    }
                    cur = e;
                }
                PathCmd::Close => {
                    edge(cur, start);
                    cur = start;
                }
            }
        }
    }
    best
}

/// An outline as a polygon: straight edges kept, curves split into 16.
fn flatten(sub: &SubPath) -> Vec<PointF64> {
    let mut out = Vec::new();
    let mut cur = PointF64::default();
    for cmd in &sub.commands {
        match *cmd {
            PathCmd::MoveTo(q) | PathCmd::LineTo(q) => {
                out.push(q);
                cur = q;
            }
            PathCmd::CubicTo(c1, c2, e) => {
                out.extend((1..=16).map(|k| cubic_at(cur, c1, c2, e, k as f64 / 16.0)));
                cur = e;
            }
            PathCmd::Close => {}
        }
    }
    out
}

/// Whether `p` is inside polygon `poly` (even-odd).
fn inside(poly: &[PointF64], p: PointF64) -> bool {
    let mut odd = false;
    for (i, a) in poly.iter().enumerate() {
        let b = poly[(i + 1) % poly.len()];
        if (a.y > p.y) != (b.y > p.y) && p.x < a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y) {
            odd = !odd;
        }
    }
    odd
}

/// Distance from `p` to the segment `a`-`b`.
fn segment_distance(p: PointF64, a: PointF64, b: PointF64) -> f64 {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let len2 = dx * dx + dy * dy;
    let t = if len2 > 0.0 { (((p.x - a.x) * dx + (p.y - a.y) * dy) / len2).clamp(0.0, 1.0) } else { 0.0 };
    let (x, y) = (a.x + t * dx - p.x, a.y + t * dy - p.y);
    (x * x + y * y).sqrt()
}

/// Distance between two boxes (0 when they touch or overlap).
fn box_gap((a, b): (PointF64, PointF64), (c, d): (PointF64, PointF64)) -> f64 {
    let dx = (c.x - b.x).max(a.x - d.x).max(0.0);
    let dy = (c.y - b.y).max(a.y - d.y).max(0.0);
    (dx * dx + dy * dy).sqrt()
}

fn cubic_at(p0: PointF64, p1: PointF64, p2: PointF64, p3: PointF64, t: f64) -> PointF64 {
    let u = 1.0 - t;
    let (a, b, c, d) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
    PointF64 {
        x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
        y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    }
}

/// Parameters in (0, 1) where the cubic's x or y derivative is zero.
fn cubic_extrema(p0: PointF64, p1: PointF64, p2: PointF64, p3: PointF64) -> Vec<f64> {
    let mut ts = Vec::new();
    for (a0, a1, a2, a3) in [(p0.x, p1.x, p2.x, p3.x), (p0.y, p1.y, p2.y, p3.y)] {
        // B'(t)/3 = a t^2 + b t + c
        let a = -a0 + 3.0 * a1 - 3.0 * a2 + a3;
        let b = 2.0 * (a0 - 2.0 * a1 + a2);
        let c = a1 - a0;
        if a.abs() < 1e-12 {
            if b.abs() > 1e-12 {
                ts.push(-c / b);
            }
        } else {
            let disc = b * b - 4.0 * a * c;
            if disc >= 0.0 {
                let r = disc.sqrt();
                ts.push((-b + r) / (2.0 * a));
                ts.push((-b - r) / (2.0 * a));
            }
        }
    }
    ts.retain(|t| *t > 0.0 && *t < 1.0);
    ts
}

impl OptimizerPass for CropPass {
    fn run(&self, doc: &mut VectorDoc) {
        let Some((min, max)) = bounds(doc) else { return };
        let pad = self.padding.max(0.0);
        let (bw, bh) = (max.x - min.x + 2.0 * pad, max.y - min.y + 2.0 * pad);
        let (w, h) = (bw.ceil().max(1.0), bh.ceil().max(1.0));
        let dx = pad - min.x + (w - bw) / 2.0;
        let dy = pad - min.y + (h - bh) / 2.0;
        let mv = |p: PointF64| PointF64 { x: p.x + dx, y: p.y + dy };
        for shape in &mut doc.shapes {
            for sub in shape.paths_mut().flat_map(|p| p.subpaths.iter_mut()) {
                for cmd in &mut sub.commands {
                    *cmd = match *cmd {
                        PathCmd::MoveTo(p) => PathCmd::MoveTo(mv(p)),
                        PathCmd::LineTo(p) => PathCmd::LineTo(mv(p)),
                        PathCmd::CubicTo(a, b, c) => PathCmd::CubicTo(mv(a), mv(b), mv(c)),
                        PathCmd::Close => PathCmd::Close,
                    };
                }
            }
        }
        doc.width = w as u32;
        doc.height = h as u32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::Paint;
    use visioncortex::Color;

    fn pt(x: f64, y: f64) -> PointF64 {
        PointF64 { x, y }
    }

    fn doc_with(commands: Vec<PathCmd>) -> VectorDoc {
        let mut doc = VectorDoc::new(100, 100);
        doc.shapes.push(Shape {
            paint: Paint::Solid(Color::new(0, 0, 0)),
            path: MultiPath {
                subpaths: vec![SubPath { commands }],
            },
            soft_zone: None,
        });
        doc
    }

    fn rect(doc: &mut VectorDoc, (x0, y0, x1, y1): (f64, f64, f64, f64), color: Color) {
        doc.shapes.push(Shape {
            paint: Paint::Solid(color),
            path: MultiPath {
                subpaths: vec![SubPath {
                    commands: vec![
                        PathCmd::MoveTo(pt(x0, y0)),
                        PathCmd::LineTo(pt(x1, y0)),
                        PathCmd::LineTo(pt(x1, y1)),
                        PathCmd::LineTo(pt(x0, y1)),
                        PathCmd::Close,
                    ],
                }],
            },
            soft_zone: None,
        });
    }

    #[test]
    fn lone_specks_are_strays_but_dots_beside_letters_are_not() {
        let navy = Color::new(29, 43, 83);
        let orange = Color::new(242, 140, 40);
        let mut doc = VectorDoc::new(200, 100);
        rect(&mut doc, (0.0, 0.0, 200.0, 100.0), Color::new(255, 255, 255));
        rect(&mut doc, (40.0, 30.0, 60.0, 80.0), navy); // a letter stem
        rect(&mut doc, (48.0, 24.0, 51.0, 27.0), navy); // its dot, 3 px above
        rect(&mut doc, (150.0, 10.0, 151.5, 11.5), navy); // a lone speck
        rect(&mut doc, (100.0, 50.0, 101.0, 51.0), orange); // a lone speck, other colour
        // A big navy diamond whose bounding box holds a speck in its corner,
        // far from the diamond itself: still a stray.
        doc.shapes.push(Shape {
            paint: Paint::Solid(navy),
            path: MultiPath {
                subpaths: vec![SubPath {
                    commands: vec![
                        PathCmd::MoveTo(pt(130.0, 50.0)),
                        PathCmd::LineTo(pt(160.0, 20.0)),
                        PathCmd::LineTo(pt(190.0, 50.0)),
                        PathCmd::LineTo(pt(160.0, 80.0)),
                        PathCmd::Close,
                    ],
                }],
            },
            soft_zone: None,
        });
        rect(&mut doc, (186.0, 76.0, 187.5, 77.5), navy); // in the diamond's box corner
        // An orange sun with a far-off speck merged into the same shape.
        rect(&mut doc, (70.0, 60.0, 90.0, 80.0), orange);
        let speck = SubPath {
            commands: vec![
                PathCmd::MoveTo(pt(10.0, 90.0)),
                PathCmd::LineTo(pt(11.0, 90.0)),
                PathCmd::LineTo(pt(11.0, 91.0)),
                PathCmd::Close,
            ],
        };
        doc.shapes.last_mut().unwrap().path.subpaths.push(speck);
        // A tiny hole in the white background (a gap between two leaves):
        // part of the background, not a stray.
        let hole = SubPath {
            commands: vec![
                PathCmd::MoveTo(pt(120.0, 90.0)),
                PathCmd::LineTo(pt(120.0, 92.0)),
                PathCmd::LineTo(pt(122.0, 92.0)),
                PathCmd::LineTo(pt(122.0, 90.0)),
                PathCmd::Close,
            ],
        };
        doc.shapes[0].path.subpaths.push(hole);
        let found = strays(&doc);
        assert_eq!(found.len(), 4, "{found:?}");
        assert!(found.iter().any(|p| (p.x - 150.75).abs() < 1e-9 && (p.y - 10.75).abs() < 1e-9));
        assert!(found.iter().any(|p| (p.x - 100.5).abs() < 1e-9));
    }

    #[test]
    fn quantize_rounds_coordinates() {
        let mut doc = doc_with(vec![
            PathCmd::MoveTo(pt(1.234, 5.678)),
            PathCmd::LineTo(pt(9.876, 0.001)),
            PathCmd::Close,
        ]);
        QuantizePass::new(1).run(&mut doc);
        let cmds = &doc.shapes[0].path.subpaths[0].commands;
        assert_eq!(cmds[0], PathCmd::MoveTo(pt(1.2, 5.7)));
        assert_eq!(cmds[1], PathCmd::LineTo(pt(9.9, 0.0)));
    }

    #[test]
    fn cleanup_drops_collinear_and_zero_length() {
        // A straight run of colinear points plus a duplicate should collapse.
        let mut doc = doc_with(vec![
            PathCmd::MoveTo(pt(0.0, 0.0)),
            PathCmd::LineTo(pt(1.0, 0.0)),
            PathCmd::LineTo(pt(2.0, 0.0)), // collinear with previous run
            PathCmd::LineTo(pt(2.0, 0.0)), // zero-length
            PathCmd::LineTo(pt(2.0, 5.0)),
            PathCmd::Close,
        ]);
        CleanupPass.run(&mut doc);
        let cmds = &doc.shapes[0].path.subpaths[0].commands;
        // MoveTo, one merged horizontal LineTo, one vertical LineTo, Close.
        assert_eq!(cmds.len(), 4);
        assert_eq!(cmds[0], PathCmd::MoveTo(pt(0.0, 0.0)));
        assert_eq!(cmds[1], PathCmd::LineTo(pt(2.0, 0.0)));
        assert_eq!(cmds[2], PathCmd::LineTo(pt(2.0, 5.0)));
        assert_eq!(cmds[3], PathCmd::Close);
    }

    #[test]
    fn crop_fits_the_canvas_to_the_drawing() {
        let mut doc = doc_with(vec![
            PathCmd::MoveTo(pt(30.0, 40.0)),
            PathCmd::LineTo(pt(50.0, 40.0)),
            PathCmd::LineTo(pt(50.0, 60.0)),
            PathCmd::Close,
        ]);
        CropPass { padding: 2.0 }.run(&mut doc);
        assert_eq!((doc.width, doc.height), (24, 24));
        assert_eq!(bounds(&doc), Some((pt(2.0, 2.0), pt(22.0, 22.0))));
    }

    #[test]
    fn crop_counts_a_curve_by_its_bulge_not_its_endpoints() {
        // Endpoints at y=50; the curve bulges up to y=35 (control points y=30).
        let mut doc = doc_with(vec![
            PathCmd::MoveTo(pt(10.0, 50.0)),
            PathCmd::CubicTo(pt(10.0, 30.0), pt(30.0, 30.0), pt(30.0, 50.0)),
            PathCmd::Close,
        ]);
        let (min, max) = bounds(&doc).unwrap();
        assert!((min.y - 35.0).abs() < 1e-9 && (max.y - 50.0).abs() < 1e-9);
        CropPass { padding: 0.0 }.run(&mut doc);
        assert_eq!((doc.width, doc.height), (20, 15));
    }
}
