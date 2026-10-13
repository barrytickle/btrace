"""Prototype pre-pass: smooth upscale, then snap every pixel to a small palette.

Usage: python prep.py <image> <out.png> [--k N] [--scale S]

Anti-aliased edge pixels hold sub-pixel position information. Upscaling with a
smooth filter before snapping to the palette turns that into a smooth staircase
at S times the resolution, which the tracer can then fit cleanly.
The palette is picked automatically with k-means in Lab space.
"""
import argparse

import cv2
import numpy as np


def pick_palette(lab: np.ndarray, k: int) -> np.ndarray:
    data = lab.reshape(-1, 3).astype(np.float32)
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 50, 0.2)
    _, _, centers = cv2.kmeans(data, k, None, crit, 5, cv2.KMEANS_PP_CENTERS)
    return centers


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--k", type=int, default=3)
    ap.add_argument("--scale", type=int, default=8)
    a = ap.parse_args()

    img = cv2.imread(a.src, cv2.IMREAD_UNCHANGED)
    if img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
    bgr, alpha = img[..., :3], img[..., 3]

    # Light edge-preserving denoise at source size, then smooth upscale.
    bgr = cv2.bilateralFilter(bgr, 5, 25, 5)
    h, w = alpha.shape
    size = (w * a.scale, h * a.scale)
    big = cv2.resize(bgr, size, interpolation=cv2.INTER_CUBIC)
    big_a = cv2.resize(alpha, size, interpolation=cv2.INTER_CUBIC)

    # Palette from flat, opaque pixels only. Anti-aliased edge pixels are
    # blends of their neighbours; left in, k-means spends a cluster on them
    # and the trace grows a halo outline around every shape.
    lab_src = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    grad = sum(np.abs(cv2.Sobel(lab_src[..., c], cv2.CV_32F, 1, 0)) +
               np.abs(cv2.Sobel(lab_src[..., c], cv2.CV_32F, 0, 1)) for c in range(3))
    flat = (alpha > 128) & (grad < np.percentile(grad[alpha > 128], 60))
    centers = pick_palette(lab_src[flat], a.k)

    lab = cv2.cvtColor(big, cv2.COLOR_BGR2LAB).astype(np.float32).reshape(-1, 3)
    idx = np.argmin(((lab[:, None, :] - centers[None]) ** 2).sum(-1), axis=1)
    snapped_lab = centers[idx].reshape(big.shape).astype(np.uint8)
    snapped = cv2.cvtColor(snapped_lab, cv2.COLOR_LAB2BGR)

    out = np.dstack([snapped, np.where(big_a > 128, 255, 0).astype(np.uint8)])
    cv2.imwrite(a.dst, out)
    hexes = ["#%02x%02x%02x" % tuple(c[::-1]) for c in
             cv2.cvtColor(centers[None].astype(np.uint8), cv2.COLOR_LAB2BGR)[0]]
    print(",".join(hexes))


if __name__ == "__main__":
    main()
