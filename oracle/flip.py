"""NVIDIA FLIP (LDR, 67 pixels per degree) between two PNGs, for oracle/run.ts.

usage: flip.py REFERENCE.png TEST.png [HEATMAP.png]
prints {"mean": ..., "p99": ...}; writes the magma heat map when a path is given.
Requires `pip install flip-evaluator numpy pillow`.
"""

import json
import sys

import flip_evaluator as flip
import numpy as np
from PIL import Image


def load(path):
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255.0


def main():
    reference, test = load(sys.argv[1]), load(sys.argv[2])
    if reference.shape != test.shape:
        raise SystemExit(f"size mismatch {reference.shape} vs {test.shape}")
    error, mean, _ = flip.evaluate(reference, test, "LDR", applyMagma=False)
    error = np.asarray(error, dtype=np.float32)
    if len(sys.argv) > 3:
        heatmap, _, _ = flip.evaluate(reference, test, "LDR", applyMagma=True)
        pixels = np.clip(np.asarray(heatmap) * 255.0 + 0.5, 0, 255).astype(np.uint8)
        Image.fromarray(pixels).save(sys.argv[3])
    print(json.dumps({"mean": float(mean), "p99": float(np.percentile(error, 99))}))


main()
