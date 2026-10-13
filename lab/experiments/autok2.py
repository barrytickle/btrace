"""Experiment: absolute flatness + agglomerative merge by perceptual distance."""
import sys, cv2, numpy as np
img = cv2.imread(sys.argv[1], cv2.IMREAD_UNCHANGED)
bgr, alpha = img[..., :3], img[..., 3]
lab = cv2.cvtColor(bgr.astype(np.float32) / 255, cv2.COLOR_BGR2LAB)
pad = np.pad(lab, ((1, 1), (1, 1), (0, 0)), mode="edge")
h, w = alpha.shape
dmax = np.zeros((h, w), np.float32)
for dy in (-1, 0, 1):
    for dx in (-1, 0, 1):
        n = pad[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]
        dmax = np.maximum(dmax, np.linalg.norm(lab - n, axis=2))
op = alpha > 128
for T_flat in (4, 6, 8):
    flat = op & (dmax < T_flat)
    pts = lab[flat]
    # greedy agglomeration: repeatedly take most common remaining colour bin as seed
    q = np.round(pts / 3).astype(int)
    keys, inv, cnt = np.unique(q, axis=0, return_inverse=True, return_counts=True)
    means = np.array([pts[inv.ravel() == i].mean(0) for i in range(len(keys))])
    clusters = []  # [mean, count]
    for i in np.argsort(-cnt):
        m, c = means[i], cnt[i]
        for cl in clusters:
            if np.linalg.norm(cl[0] - m) < 12:
                cl[0] = (cl[0] * cl[1] + m * c) / (cl[1] + c); cl[1] += c; break
        else:
            clusters.append([m, c])
    print(f"T_flat={T_flat} flat={flat.sum()}")
    for m, c in clusters[:8]:
        print("   L%5.1f a%6.1f b%6.1f  %5d px" % (*m, c))
