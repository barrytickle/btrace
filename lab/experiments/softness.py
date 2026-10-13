"""Experiment: per-pixel edge width = local contrast / local gradient.

Crisp (anti-aliased) edges span 1-2 px; soft glows span many. Writes the
softness mask (white = soft) next to the source for a visual check.
"""
import sys, cv2, numpy as np
img = cv2.imread(sys.argv[1], cv2.IMREAD_UNCHANGED)[..., :3].astype(np.float32)
L = img @ np.array([0.114, 0.587, 0.299], np.float32)          # BGR luma
Ls = cv2.GaussianBlur(L, (0, 0), 0.7)                          # suppress grain
gx = cv2.Sobel(Ls, cv2.CV_32F, 1, 0, ksize=3) / 8
gy = cv2.Sobel(Ls, cv2.CV_32F, 0, 1, ksize=3) / 8
G = np.hypot(gx, gy)
r = int(sys.argv[2]) if len(sys.argv) > 2 else 4
k = np.ones((2 * r + 1, 2 * r + 1), np.uint8)
C = cv2.dilate(L, k) - cv2.erode(L, k)
width = C / np.maximum(G, 1e-3)
# Width only means something at an edge's steepest point: elsewhere the window
# sees the contrast but the pixel sees no slope. Measure at gradient peaks.
peak = (G >= cv2.dilate(G, np.ones((3, 3), np.uint8)) * 0.85) & (C > 24)
edge = peak
soft_at_peak = np.where(peak, np.clip((width - 3) / 3, 0, 1), 0).astype(np.float32)
# Spread from the peak across the ramp (a soft ramp is several px wide).
soft = cv2.dilate(soft_at_peak, np.ones((2 * r + 1, 2 * r + 1), np.uint8))
vis = np.hstack([cv2.cvtColor(img.astype(np.uint8), cv2.COLOR_BGR2GRAY), (soft * 255).astype(np.uint8)])
cv2.imwrite(sys.argv[1].rsplit("/", 1)[-1].replace(".png", "") + ".soft.png", cv2.resize(vis, None, fx=2, fy=2, interpolation=cv2.INTER_NEAREST))
for name, m in (("crisp-edge px", edge & (soft < 0.5)), ("soft px", soft >= 0.5)):
    print(f"  {name:14} {int(m.sum())}")
