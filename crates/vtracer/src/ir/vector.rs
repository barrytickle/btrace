use visioncortex::PointF64;

use super::Paint;

/// A single drawing command in a subpath. Coordinates are absolute, in
/// full-canvas (document) space — the writer bakes any offset into them.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PathCmd {
    /// Start a new subpath at the given point.
    MoveTo(PointF64),
    /// Straight line to the given point.
    LineTo(PointF64),
    /// Cubic Bézier: two control points then the endpoint.
    CubicTo(PointF64, PointF64, PointF64),
    /// Close the current subpath back to its start.
    Close,
}

/// One connected outline: a `MoveTo` followed by line/cubic segments, usually
/// terminated by `Close`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SubPath {
    pub commands: Vec<PathCmd>,
}

impl SubPath {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.commands.is_empty()
    }

    /// The starting point of the subpath, if any.
    pub fn start(&self) -> Option<PointF64> {
        match self.commands.first() {
            Some(PathCmd::MoveTo(p)) => Some(*p),
            _ => None,
        }
    }
}

/// A shape may consist of several subpaths (outer ring plus holes).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MultiPath {
    pub subpaths: Vec<SubPath>,
}

impl MultiPath {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.subpaths.iter().all(SubPath::is_empty)
    }

    pub fn push(&mut self, subpath: SubPath) {
        if !subpath.is_empty() {
            self.subpaths.push(subpath);
        }
    }
}

/// A filled shape in the output document.
#[derive(Debug, Clone)]
pub struct Shape {
    pub paint: Paint,
    pub path: MultiPath,
}

/// The output document IR: what the optimizer passes and the writer consume.
#[derive(Debug, Clone)]
pub struct VectorDoc {
    pub width: u32,
    pub height: u32,
    /// Shapes in paint order (first drawn is bottom).
    pub shapes: Vec<Shape>,
}

impl VectorDoc {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            shapes: Vec::new(),
        }
    }

    /// Shrink the document by an integer factor: every coordinate and the
    /// canvas size are divided by `factor`. Used to map geometry traced on an
    /// upscaled working image back to source pixels.
    pub fn downscale(&mut self, factor: u32) {
        if factor <= 1 {
            return;
        }
        let f = factor as f64;
        let s = |p: PointF64| PointF64 { x: p.x / f, y: p.y / f };
        for shape in &mut self.shapes {
            for sub in &mut shape.path.subpaths {
                for cmd in &mut sub.commands {
                    *cmd = match *cmd {
                        PathCmd::MoveTo(p) => PathCmd::MoveTo(s(p)),
                        PathCmd::LineTo(p) => PathCmd::LineTo(s(p)),
                        PathCmd::CubicTo(a, b, c) => PathCmd::CubicTo(s(a), s(b), s(c)),
                        PathCmd::Close => PathCmd::Close,
                    };
                }
            }
        }
        self.width /= factor;
        self.height /= factor;
    }
}
