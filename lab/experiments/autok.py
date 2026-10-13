"""Experiment: choose the palette size automatically (k-means k=max, then merge/drop)."""
import sys, cv2, numpy as np
img = cv2.imread(sys.argv[1], cv2.IMREAD_UNCHANGED)
bgr, alpha = img[..., :3], img[..., 3]
for bil in (True, False):
    src = cv2.bilateralFilter(bgr, 5, 25, 5) if bil else bgr
    lab = cv2.cvtColor(src.astype(np.float32) / 255, cv2.COLOR_BGR2LAB)  # L 0..100
    grad = sum(np.abs(cv2.Sobel(lab[..., c], cv2.CV_32F, 1, 0)) + np.abs(cv2.Sobel(lab[..., c], cv2.CV_32F, 0, 1)) for c in range(3))
    op = alpha > 128
    flat = op & (grad < np.percentile(grad[op], 60))
    data = lab[flat].reshape(-1, 3).astype(np.float32)
    _, lbl, c = cv2.kmeans(data, 8, None, (3, 50, 0.1), 5, cv2.KMEANS_PP_CENTERS)
    w = np.bincount(lbl.ravel(), minlength=8) / len(lbl)
    order = np.argsort(-w)
    print("bilateral" if bil else "raw", "flat px", flat.sum())
    for i in order: print("   L%5.1f a%6.1f b%6.1f  %5.2f%%" % (*c[i], 100 * w[i]))
