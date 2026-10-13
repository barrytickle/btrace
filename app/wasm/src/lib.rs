//! WebAssembly core for the Btrace app.
//!
//! A [`Tracer`] holds one image in a [`Session`], so the expensive clustering
//! runs once and every slider move or removal click only re-runs the cheap
//! stages. The app calls it from a Web Worker to keep the UI responsive.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use vtracer::{Color, ColorImage, Config, Removal, Session};
use wasm_bindgen::prelude::*;

/// Options from the app (camelCase). Anything omitted keeps the engine
/// default.
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    clustering: Option<String>,
    hierarchical: Option<String>,
    mode: Option<String>,
    filter_speckle: Option<usize>,
    color_precision: Option<i32>,
    layer_difference: Option<i32>,
    corner_threshold: Option<i32>,
    simplify: Option<f64>,
    path_precision: Option<u32>,
    palette: Option<Vec<String>>,
    max_colors: Option<usize>,
    binary_threshold: Option<u8>,
    adaptive: Option<bool>,
    watershed_detail: Option<u32>,
    snap_scale: Option<u32>,
    snap_smooth: Option<f64>,
    snap_glow: Option<bool>,
    lines: Option<bool>,
    remove_background: Option<bool>,
    remove: Vec<Point>,
    /// Crop padding in px; omit or null for no crop.
    crop: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Point {
    x: f64,
    y: f64,
    #[serde(default)]
    whole_color: bool,
}

/// What [`Tracer::render`] returns to JS.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Rendered {
    svg: String,
    width: u32,
    height: u32,
    shapes: usize,
    /// Colors in the output, most-used (by shape count) first, `#rrggbb`.
    colors: Vec<String>,
    /// Exact extent of the drawing, `[min_x, min_y, max_x, max_y]` in canvas
    /// px (glows count by their spread); `None` if nothing was drawn.
    bounds: Option<[f64; 4]>,
}

fn err(msg: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&msg.to_string())
}

fn parse_hex(token: &str) -> Result<Color, JsValue> {
    let hex = token.strip_prefix('#').unwrap_or(token);
    let bad = || err(format!("`{token}` is not a #rrggbb color"));
    if hex.len() != 6 {
        return Err(bad());
    }
    let b = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).map_err(|_| bad());
    Ok(Color::new(b(0)?, b(2)?, b(4)?))
}

fn config_from(options: JsValue) -> Result<Config, JsValue> {
    let o: Options = if options.is_undefined() || options.is_null() {
        Options::default()
    } else {
        serde_wasm_bindgen::from_value(options).map_err(err)?
    };
    let mut c = Config::default();
    if let Some(v) = o.clustering {
        c.clustering = v.parse().map_err(err)?;
    }
    if let Some(v) = o.hierarchical {
        c.hierarchical = v.parse().map_err(err)?;
    }
    if let Some(v) = o.mode {
        c.mode = v.parse().map_err(err)?;
    }
    if let Some(v) = o.filter_speckle {
        c.filter_speckle = v;
    }
    if let Some(v) = o.color_precision {
        c.color_precision = v;
    }
    if let Some(v) = o.layer_difference {
        c.layer_difference = v;
    }
    if let Some(v) = o.corner_threshold {
        c.corner_threshold = v;
    }
    c.simplify = o.simplify.filter(|v| *v > 0.0);
    if let Some(v) = o.path_precision {
        c.path_precision = Some(v);
    }
    if let Some(list) = o.palette {
        c.palette = list.iter().map(|s| parse_hex(s)).collect::<Result<_, _>>()?;
    }
    c.max_colors = o.max_colors.filter(|v| *v > 0);
    if let Some(v) = o.binary_threshold {
        c.binary_threshold = v;
    }
    if let Some(v) = o.adaptive {
        c.binary_adaptive = v;
    }
    if let Some(v) = o.watershed_detail {
        c.watershed_detail = v;
    }
    if let Some(v) = o.snap_scale {
        c.snap_scale = v;
    }
    if let Some(v) = o.snap_smooth {
        c.snap_smooth = v;
    }
    c.snap_glow = o.snap_glow.unwrap_or(false);
    c.lines = o.lines.unwrap_or(false);
    c.remove_background = o.remove_background.unwrap_or(false);
    c.remove = o
        .remove
        .iter()
        .map(|p| Removal {
            x: p.x,
            y: p.y,
            whole_color: p.whole_color,
        })
        .collect();
    c.crop = o.crop;
    Ok(c)
}

/// An interactive tracing session over one image.
#[wasm_bindgen]
pub struct Tracer {
    session: Session,
}

#[wasm_bindgen]
impl Tracer {
    /// Start a session over raw RGBA pixels (row-major, 4 bytes per pixel).
    #[wasm_bindgen(constructor)]
    pub fn new(rgba: Vec<u8>, width: usize, height: usize) -> Result<Tracer, JsValue> {
        if width == 0 || height == 0 || rgba.len() != width * height * 4 {
            return Err(err("pixel buffer does not match width × height × 4"));
        }
        let img = ColorImage {
            pixels: rgba,
            width,
            height,
        };
        Ok(Tracer {
            session: Session::new(img),
        })
    }

    /// Trace with `options`; re-clusters only when a clustering option
    /// changed since the last call. Returns `{ svg, width, height, shapes,
    /// colors }`.
    pub fn render(&mut self, options: JsValue) -> Result<JsValue, JsValue> {
        let config = config_from(options)?;
        let writer = config.build().map_err(err)?.writer;
        let doc = self.session.render(&config).map_err(err)?;

        let mut counts: HashMap<[u8; 3], usize> = HashMap::new();
        for shape in &doc.shapes {
            *counts.entry(shape.paint.color().rgb_u8()).or_default() += 1;
        }
        let mut colors: Vec<([u8; 3], usize)> = counts.into_iter().collect();
        colors.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));

        let bounds = vtracer::optimize::bounds(&doc).map(|(a, b)| [a.x, a.y, b.x, b.y]);
        let out = Rendered {
            bounds,
            svg: writer.write(&doc),
            width: doc.width,
            height: doc.height,
            shapes: doc.shapes.len(),
            colors: colors
                .iter()
                .map(|(c, _)| format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2]))
                .collect(),
        };
        serde_wasm_bindgen::to_value(&out).map_err(err)
    }
}
