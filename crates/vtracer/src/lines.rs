//! Straight-line detection and corner sharpening, as a [`CurvePass`].
//!
//! Traced outlines of straight edges come out as chains of gently wobbling
//! cubics: the pixel boundary carries noise, and the spline fitter has no
//! notion of "straight". [`StraightenLines`] finds runs that are straight to
//! within a tolerance and replaces them with exact lines, then sharpens
//! corners where two lines meet across a small rounded-off stub.
//!
//! How a run qualifies:
//!
//! * **Close to its chord.** Every sample lies within `tolerance` of the line
//!   between the run's ends. This absorbs edge noise.
//! * **No bow.** The mean *signed* deviation stays within `bow`. A noisy
//!   straight edge wanders to both sides and averages out; an arc bulges to
//!   one side, so a large circle is not mistaken for a polygon even where
//!   its chords are within the noise tolerance.
//! * **Long enough.** At least `min_length`.
//!
//! The curves between lines are kept exactly as fitted: the chain is cut at
//! each run's ends by de Casteljau subdivision, so nothing is re-fitted.
//! Lines are emitted as cubics with control points at the thirds of the
//! chord; [`CleanupPass`](crate::optimize::CleanupPass) writes those as
//! straight `L` segments.
//!
//! Units are source pixels (see [`apply_passes`](crate::simplify)).

use visioncortex::PointF64;

use crate::fitter::FittedGeom;
use crate::simplify::CurvePass;

/// Sample spacing along the outline, px.
const SPACING: f64 = 0.25;

/// Straight-line detection and corner sharpening. See the [module docs](self).
#[derive(Debug, Clone, Copy)]
pub struct StraightenLines {
    /// Max distance (px) of any point of a run from its chord.
    pub tolerance: f64,
    /// Max mean signed distance (px) from the chord: how far a run may bow.
    pub bow: f64,
    /// Shortest run (px) that becomes a line.
    pub min_length: f64,
    /// Two lines whose directions differ by at least this (radians) and that
    /// are separated by a stub of at most `corner_reach` px are joined at
    /// their intersection: a sharp corner.
    pub corner_angle: f64,
    /// Longest rounded stub (px) a sharpened corner may replace, and the
    /// furthest the intersection may sit from either line's end.
    pub corner_reach: f64,
}

impl Default for StraightenLines {
    fn default() -> Self {
        Self {
            tolerance: 0.35,
            bow: 0.08,
            min_length: 8.0,
            corner_angle: 25f64.to_radians(),
            corner_reach: 2.0,
        }
    }
}

impl CurvePass for StraightenLines {
    fn open(&self, geom: FittedGeom) -> FittedGeom {
        match geom {
            FittedGeom::Beziers(chain) => FittedGeom::Beziers(self.straighten(chain, false)),
            other => other,
        }
    }

    fn ring(&self, geom: FittedGeom) -> FittedGeom {
        match geom {
            FittedGeom::Beziers(chain) => FittedGeom::Beziers(self.straighten(chain, true)),
            other => other,
        }
    }
}

/// A point on the chain: cubic index and parameter.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Loc {
    k: usize,
    t: f64,
}

#[derive(Debug, Clone, Copy)]
struct Sample {
    p: PointF64,
    loc: Loc,
}

/// A piece of the rebuilt chain, between two sample indices.
#[derive(Debug, Clone, Copy)]
enum Piece {
    Line { a: usize, b: usize },
    Curve { a: usize, b: usize },
}

impl StraightenLines {
    fn straighten(&self, mut chain: Vec<[PointF64; 4]>, closed: bool) -> Vec<[PointF64; 4]> {
        if chain.is_empty() {
            return chain;
        }
        if closed {
            // Seam at the sharpest junction, so a straight side is not split
            // by the ring's start point unless it has to be.
            let seam = (0..chain.len())
                .max_by(|&i, &j| {
                    let turn = |k: usize| {
                        let prev = if k == 0 { chain.len() - 1 } else { k - 1 };
                        turn_angle(&chain[prev], &chain[k])
                    };
                    turn(i).partial_cmp(&turn(j)).unwrap_or(std::cmp::Ordering::Equal)
                })
                .unwrap_or(0);
            chain.rotate_left(seam);
        }

        let samples = sample_chain(&chain);
        let runs = self.find_runs(&samples);
        if runs.is_empty() {
            return chain;
        }

        // Pieces: lines for the runs, curves for the gaps between them.
        let last = samples.len() - 1;
        let mut pieces = Vec::new();
        let mut at = 0;
        for &(a, b) in &runs {
            if a > at {
                pieces.push(Piece::Curve { a: at, b: a });
            }
            pieces.push(Piece::Line { a, b });
            at = b;
        }
        if at < last {
            pieces.push(Piece::Curve { a: at, b: last });
        }

        // Endpoint of each piece as rebuilt; corner sharpening may move the
        // shared point of two lines to their intersection.
        let mut ends: Vec<(PointF64, PointF64)> = pieces
            .iter()
            .map(|p| match *p {
                Piece::Line { a, b } | Piece::Curve { a, b } => (samples[a].p, samples[b].p),
            })
            .collect();
        let mut dropped = vec![false; pieces.len()];
        self.sharpen(&pieces, &samples, &mut ends, &mut dropped, closed);

        let mut out = Vec::new();
        for (i, piece) in pieces.iter().enumerate() {
            if dropped[i] {
                continue;
            }
            let (p0, p1) = ends[i];
            match *piece {
                Piece::Line { .. } => out.push(line(p0, p1)),
                Piece::Curve { a, b } => {
                    let mut sub = subchain(&chain, samples[a].loc, samples[b].loc);
                    if sub.is_empty() {
                        continue;
                    }
                    sub.first_mut().unwrap()[0] = p0;
                    sub.last_mut().unwrap()[3] = p1;
                    out.extend(sub);
                }
            }
        }
        // Chain ends are pinned (mosaic junctions must not move); a ring
        // stays closed.
        if let (Some(first), Some(last)) = (chain.first(), chain.last()) {
            if !closed {
                out.first_mut().unwrap()[0] = first[0];
                out.last_mut().unwrap()[3] = last[3];
            } else {
                let start = out[0][0];
                out.last_mut().unwrap()[3] = start;
            }
        }
        out
    }

    /// Greedy maximal straight runs over the samples, as (start, end) index
    /// pairs in order, non-overlapping.
    fn find_runs(&self, s: &[Sample]) -> Vec<(usize, usize)> {
        let mut runs = Vec::new();
        let mut a = 0;
        while a + 1 < s.len() {
            let mut best = a;
            let mut b = a + 1;
            while b < s.len() && self.straight(&s[a..=b]) {
                best = b;
                b += 1;
            }
            if dist(s[a].p, s[best].p) >= self.min_length {
                runs.push((a, best));
                a = best;
            } else {
                a += 1;
            }
        }
        runs
    }

    /// Whether every sample of `run` is within tolerance of the chord between
    /// its ends, without a consistent bow to one side.
    fn straight(&self, run: &[Sample]) -> bool {
        let (p, q) = (run[0].p, run[run.len() - 1].p);
        let len = dist(p, q);
        if len < 1e-9 {
            return run.iter().all(|s| dist(s.p, p) <= self.tolerance);
        }
        let (nx, ny) = (-(q.y - p.y) / len, (q.x - p.x) / len);
        let mut sum = 0.0;
        for s in &run[1..run.len() - 1] {
            let d = (s.p.x - p.x) * nx + (s.p.y - p.y) * ny;
            if d.abs() > self.tolerance {
                return false;
            }
            sum += d;
        }
        let interior = run.len().saturating_sub(2).max(1) as f64;
        (sum / interior).abs() <= self.bow
    }

    /// Join line pairs across short curve stubs at their intersection.
    fn sharpen(
        &self,
        pieces: &[Piece],
        samples: &[Sample],
        ends: &mut [(PointF64, PointF64)],
        dropped: &mut [bool],
        closed: bool,
    ) {
        let n = pieces.len();
        let lines: Vec<usize> = (0..n).filter(|&i| matches!(pieces[i], Piece::Line { .. })).collect();
        let pairs = lines.len().saturating_sub(if closed { 0 } else { 1 });
        for w in 0..pairs {
            let (i, j) = (lines[w], lines[(w + 1) % lines.len()]);
            if i == j {
                continue;
            }
            // What lies between: nothing, or exactly one short curve.
            let gap: Vec<usize> = if j > i {
                (i + 1..j).collect()
            } else {
                (i + 1..n).chain(0..j).collect()
            };
            let stub = match gap.as_slice() {
                [] => None,
                [g] => match pieces[*g] {
                    Piece::Curve { a, b } if arc_length(&samples[a..=b]) <= self.corner_reach => Some(*g),
                    _ => continue,
                },
                _ => continue,
            };
            let (a0, a1) = ends[i];
            let (b0, b1) = ends[j];
            let (Some(da), Some(db)) = (dir(a0, a1), dir(b0, b1)) else { continue };
            let turn = (da.0 * db.0 + da.1 * db.1).clamp(-1.0, 1.0).acos();
            if turn < self.corner_angle {
                continue;
            }
            let Some(x) = intersect(a0, da, b0, db) else { continue };
            if dist(x, a1) > self.corner_reach || dist(x, b0) > self.corner_reach {
                continue;
            }
            // Never move a pinned chain end: an open chain's first and last
            // points are junctions shared with other segments.
            if !closed && (j == 0 || i == n - 1) {
                continue;
            }
            ends[i].1 = x;
            ends[j].0 = x;
            if let Some(g) = stub {
                dropped[g] = true;
            }
        }
        // A ring's seam point may have moved with a sharpened corner.
        if closed {
            if let (Some(first), Some(last)) = (
                (0..n).find(|&k| !dropped[k]),
                (0..n).rev().find(|&k| !dropped[k]),
            ) {
                ends[last].1 = ends[first].0;
            }
        }
    }
}

fn line(a: PointF64, b: PointF64) -> [PointF64; 4] {
    let lerp = |t: f64| PointF64 {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
    };
    [a, lerp(1.0 / 3.0), lerp(2.0 / 3.0), b]
}

fn dist(a: PointF64, b: PointF64) -> f64 {
    ((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt()
}

fn dir(a: PointF64, b: PointF64) -> Option<(f64, f64)> {
    let len = dist(a, b);
    (len > 1e-9).then(|| ((b.x - a.x) / len, (b.y - a.y) / len))
}

fn arc_length(s: &[Sample]) -> f64 {
    s.windows(2).map(|w| dist(w[0].p, w[1].p)).sum()
}

/// Intersection of the lines through `p` along `d` and through `q` along `e`.
fn intersect(p: PointF64, d: (f64, f64), q: PointF64, e: (f64, f64)) -> Option<PointF64> {
    let den = d.0 * e.1 - d.1 * e.0;
    if den.abs() < 1e-9 {
        return None;
    }
    let t = ((q.x - p.x) * e.1 - (q.y - p.y) * e.0) / den;
    Some(PointF64 {
        x: p.x + t * d.0,
        y: p.y + t * d.1,
    })
}

/// Turn angle between the end tangent of `prev` and the start of `next`.
fn turn_angle(prev: &[PointF64; 4], next: &[PointF64; 4]) -> f64 {
    let tin = dir(prev[2], prev[3]).or_else(|| dir(prev[1], prev[3])).or_else(|| dir(prev[0], prev[3]));
    let tout = dir(next[0], next[1]).or_else(|| dir(next[0], next[2])).or_else(|| dir(next[0], next[3]));
    match (tin, tout) {
        (Some(a), Some(b)) => (a.0 * b.0 + a.1 * b.1).clamp(-1.0, 1.0).acos(),
        _ => std::f64::consts::PI,
    }
}

fn cubic_at(c: &[PointF64; 4], t: f64) -> PointF64 {
    let u = 1.0 - t;
    let (b0, b1, b2, b3) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
    PointF64 {
        x: b0 * c[0].x + b1 * c[1].x + b2 * c[2].x + b3 * c[3].x,
        y: b0 * c[0].y + b1 * c[1].y + b2 * c[2].y + b3 * c[3].y,
    }
}

/// Samples every ~[`SPACING`] px; first and last are the chain's ends.
fn sample_chain(chain: &[[PointF64; 4]]) -> Vec<Sample> {
    let mut out = vec![Sample {
        p: chain[0][0],
        loc: Loc { k: 0, t: 0.0 },
    }];
    for (k, c) in chain.iter().enumerate() {
        let len = dist(c[0], c[1]) + dist(c[1], c[2]) + dist(c[2], c[3]);
        let n = ((len / SPACING).ceil() as usize).clamp(1, 4096);
        for i in 1..=n {
            let t = i as f64 / n as f64;
            let p = if i == n { c[3] } else { cubic_at(c, t) };
            out.push(Sample { p, loc: Loc { k, t } });
        }
    }
    out
}

/// Split cubic `c` at `t`: (left, right).
fn split(c: &[PointF64; 4], t: f64) -> ([PointF64; 4], [PointF64; 4]) {
    let lerp = |a: PointF64, b: PointF64| PointF64 {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
    };
    let (p01, p12, p23) = (lerp(c[0], c[1]), lerp(c[1], c[2]), lerp(c[2], c[3]));
    let (p012, p123) = (lerp(p01, p12), lerp(p12, p23));
    let m = lerp(p012, p123);
    ([c[0], p01, p012, m], [m, p123, p23, c[3]])
}

/// The part of cubic `c` between parameters `t0 < t1`.
fn segment(c: &[PointF64; 4], t0: f64, t1: f64) -> [PointF64; 4] {
    let left = if t1 < 1.0 { split(c, t1).0 } else { *c };
    if t0 <= 0.0 {
        left
    } else {
        split(&left, t0 / t1).1
    }
}

/// The exact sub-chain between two locations (`from` before `to`).
fn subchain(chain: &[[PointF64; 4]], from: Loc, to: Loc) -> Vec<[PointF64; 4]> {
    let mut out = Vec::new();
    for k in from.k..=to.k {
        let t0 = if k == from.k { from.t } else { 0.0 };
        let t1 = if k == to.k { to.t } else { 1.0 };
        if t1 - t0 > 1e-9 {
            out.push(segment(&chain[k], t0, t1));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pt(x: f64, y: f64) -> PointF64 {
        PointF64 { x, y }
    }

    /// A chain of `n` cubics along a polyline through `pts`, each edge
    /// wobbling sideways by `wobble` px (alternating), like a noisy trace.
    fn wobbly(pts: &[PointF64], n: usize, wobble: f64) -> Vec<[PointF64; 4]> {
        let mut chain = Vec::new();
        for w in pts.windows(2) {
            let (a, b) = (w[0], w[1]);
            let len = dist(a, b);
            let (nx, ny) = (-(b.y - a.y) / len, (b.x - a.x) / len);
            for i in 0..n {
                let at = |t: f64| pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
                let (p0, p3) = (at(i as f64 / n as f64), at((i + 1) as f64 / n as f64));
                let s = if i % 2 == 0 { wobble } else { -wobble };
                let mid = |t: f64| {
                    let q = at((i as f64 + t) / n as f64);
                    pt(q.x + nx * s, q.y + ny * s)
                };
                chain.push([p0, mid(1.0 / 3.0), mid(2.0 / 3.0), p3]);
            }
        }
        chain
    }

    /// A circle of radius `r` as `n` cubics.
    fn circle(r: f64, n: usize) -> Vec<[PointF64; 4]> {
        let step = std::f64::consts::TAU / n as f64;
        let k = 4.0 / 3.0 * (step / 4.0).tan();
        (0..n)
            .map(|i| {
                let (a0, a1) = (i as f64 * step, (i + 1) as f64 * step);
                let (p0, p3) = (pt(r * a0.cos(), r * a0.sin()), pt(r * a1.cos(), r * a1.sin()));
                [
                    p0,
                    pt(p0.x - k * r * a0.sin(), p0.y + k * r * a0.cos()),
                    pt(p3.x + k * r * a1.sin(), p3.y - k * r * a1.cos()),
                    p3,
                ]
            })
            .collect()
    }

    fn is_line(c: &[PointF64; 4]) -> bool {
        let l = line(c[0], c[3]);
        (0..4).all(|i| dist(l[i], c[i]) < 1e-9)
    }

    #[test]
    fn noisy_square_becomes_four_lines_with_sharp_corners() {
        let sq = [pt(0.0, 0.0), pt(40.0, 0.0), pt(40.0, 40.0), pt(0.0, 40.0), pt(0.0, 0.0)];
        let out = StraightenLines::default().straighten(wobbly(&sq, 8, 0.15), true);
        assert_eq!(out.len(), 4, "got {out:?}");
        assert!(out.iter().all(is_line));
        for c in &out {
            // Every corner lands on a true corner of the square.
            let near = sq.iter().any(|&q| dist(q, c[0]) < 0.3);
            assert!(near, "corner {:?} not sharp", c[0]);
        }
    }

    #[test]
    fn a_circle_stays_curved() {
        let ring = circle(45.0, 12);
        let out = StraightenLines::default().straighten(ring.clone(), true);
        assert!(!out.iter().any(is_line), "circle grew straight segments");
    }

    #[test]
    fn open_chain_keeps_its_endpoints() {
        let pts = [pt(3.0, 7.0), pt(50.0, 9.0)];
        let chain = wobbly(&pts, 6, 0.1);
        let out = StraightenLines::default().straighten(chain.clone(), false);
        assert_eq!(out.first().unwrap()[0], chain.first().unwrap()[0]);
        assert_eq!(out.last().unwrap()[3], chain.last().unwrap()[3]);
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn subchain_reproduces_the_original_curve() {
        let ring = circle(10.0, 4);
        let from = Loc { k: 0, t: 0.3 };
        let to = Loc { k: 2, t: 0.6 };
        let sub = subchain(&ring, from, to);
        assert_eq!(sub.len(), 3);
        assert!(dist(sub[0][0], cubic_at(&ring[0], 0.3)) < 1e-9);
        assert!(dist(sub[2][3], cubic_at(&ring[2], 0.6)) < 1e-9);
        assert!(dist(cubic_at(&sub[1], 0.5), cubic_at(&ring[1], 0.5)) < 1e-9);
    }
}
