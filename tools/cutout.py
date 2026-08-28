#!/usr/bin/env python3
# Copyright 2026 match-stik. Licensed under the Apache License 2.0.
"""Subject cut-out — remove the background from a single still image.

Runs a U^2-Net ONNX model locally: no API, no per-image cost, no network once
the model file is on disk. Reads an image, writes an RGBA PNG whose alpha is
the model's saliency mask.

Usage:
    cutout.py <input> <output> [--feather N] [--threshold 0..1]

Where the runtime lives is deployment-specific, so the backend resolves both
the interpreter and the model through the environment:

    GIFLAB_PYTHON  interpreter with onnxruntime, numpy and pillow
    GIFLAB_MODEL   path to a u2net-style .onnx file

Get a model with, e.g.:
    curl -L -o u2net.onnx \\
      https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx
"""

import argparse
import os
import sys

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageFilter

# Two model families are worth supporting and they disagree about both input
# size and normalization, so read the size off the graph and pick the constants
# from it rather than hardcoding one family's numbers.
#   u2net  320x320, ImageNet mean/std  — fast, but only really sees one subject
#   isnet 1024x1024, mean 0.5 std 1.0  — slower, keeps everyone in a group shot
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
FLAT_MEAN = np.array([0.5, 0.5, 0.5], dtype=np.float32)
FLAT_STD = np.array([1.0, 1.0, 1.0], dtype=np.float32)


def load_session(model_path: str) -> ort.InferenceSession:
    if not os.path.exists(model_path):
        raise SystemExit(f"cutout: model not found at {model_path}")
    options = ort.SessionOptions()
    # One image at a time on a shared box — don't let inference eat every core.
    options.intra_op_num_threads = max(1, min(4, (os.cpu_count() or 2) - 1))
    options.log_severity_level = 3
    return ort.InferenceSession(model_path, options, providers=["CPUExecutionProvider"])


def model_input(session: ort.InferenceSession, model_path: str = "") -> tuple[int, np.ndarray, np.ndarray]:
    """Input size comes off the graph; normalization has to come from the family.

    Size alone is not enough to tell them apart — IS-Net and BiRefNet both take
    1024x1024 but disagree about normalization, and feeding one the other's
    constants produces a confident, wrong mask rather than an error.
    """
    shape = session.get_inputs()[0].shape
    size = shape[2] if isinstance(shape[2], int) else 320
    family = os.path.basename(model_path).lower()
    if "isnet" in family:
        return size, FLAT_MEAN, FLAT_STD
    return size, IMAGENET_MEAN, IMAGENET_STD


def saliency_mask(session: ort.InferenceSession, image: Image.Image, model_path: str = "") -> Image.Image:
    size, mean, std = model_input(session, model_path)
    resized = image.resize((size, size), Image.LANCZOS)
    array = np.asarray(resized, dtype=np.float32) / 255.0
    array = (array - mean) / std
    tensor = array.transpose(2, 0, 1)[np.newaxis, ...]

    outputs = session.run(None, {session.get_inputs()[0].name: tensor})
    # U^2-Net emits one full-resolution prediction plus six coarser side outputs;
    # the first is the one worth keeping. BiRefNet emits a single one.
    prediction = outputs[0][0][0]

    low, high = float(prediction.min()), float(prediction.max())
    if low < -1.0 or high > 2.0:
        # Raw logits (BiRefNet's range runs roughly -25..70). Min-max scaling
        # them squashes an otherwise excellent mask into speckle, because the
        # extremes set the scale for everything in between. Sigmoid is the
        # activation the family actually wants. Detected from the range rather
        # than a list of filenames, so an unfamiliar model behaves correctly.
        normalized = 1.0 / (1.0 + np.exp(-prediction))
    else:
        spread = high - low
        normalized = (prediction - low) / spread if spread > 1e-8 else np.zeros_like(prediction)

    mask = Image.fromarray((normalized * 255).astype(np.uint8), mode="L")
    return mask.resize(image.size, Image.LANCZOS)


def close_gaps(mask: Image.Image, radius: int) -> Image.Image:
    """Bridge thin gaps the models cut through a subject.

    Dark fabric beside dark hair reads as background to every saliency model
    tried here — they do not disagree about it, they are wrong about it together,
    so unioning more of them changes nothing. A morphological close (grow, then
    shrink by the same amount) reconnects a strip like that while leaving the
    outer silhouette roughly where it was. It can also bridge a genuine gap, so
    it is a deliberate option rather than the default.
    """
    if radius <= 0:
        return mask
    size = radius * 2 + 1
    return mask.filter(ImageFilter.MaxFilter(size)).filter(ImageFilter.MinFilter(size))


def apply_mask(
    image: Image.Image,
    mask: Image.Image,
    feather: float = 0.0,
    threshold: float | None = None,
) -> Image.Image:
    if threshold is not None:
        # A hard edge is what stickers and emoji want; a soft one leaves a halo
        # of half-transparent background color around the subject.
        cut = int(max(0.0, min(1.0, threshold)) * 255)
        mask = mask.point(lambda value: 255 if value >= cut else 0)
    if feather > 0:
        mask = mask.filter(ImageFilter.GaussianBlur(radius=feather))

    out = image.convert("RGBA")
    out.putalpha(mask)
    return out


def combine(masks: list[Image.Image]) -> Image.Image:
    """Per-pixel maximum across models.

    The two families fail in different places — one loses a secondary person,
    the other loses low-contrast clothing against a busy room — and a union
    keeps whatever either of them was confident about. Cheap insurance: the
    second pass costs about two seconds.
    """
    if len(masks) == 1:
        return masks[0]
    stack = np.stack([np.asarray(m, dtype=np.uint8) for m in masks])
    return Image.fromarray(stack.max(axis=0), mode="L")


def main() -> int:
    parser = argparse.ArgumentParser(description="Remove an image's background locally.")
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--also-model", action="append", default=[],
                        help="Additional model to union with the first (repeatable).")
    parser.add_argument("--close", type=int, default=0,
                        help="Bridge gaps up to this radius in px (morphological close).")
    parser.add_argument("--feather", type=float, default=0.0,
                        help="Gaussian blur radius on the alpha edge (px).")
    parser.add_argument("--threshold", type=float, default=None,
                        help="Harden the mask at this cutoff (0..1). Omit to keep it soft.")
    parser.add_argument("--model", default=os.environ.get("GIFLAB_MODEL", ""))
    args = parser.parse_args()

    if not args.model:
        raise SystemExit("cutout: set GIFLAB_MODEL or pass --model")

    image = Image.open(args.input).convert("RGB")
    masks = [saliency_mask(load_session(path), image, path)
             for path in [args.model, *args.also_model] if path]
    mask = close_gaps(combine(masks), args.close)
    apply_mask(image, mask, args.feather, args.threshold).save(args.output, "PNG")

    coverage = np.asarray(mask, dtype=np.float32).mean() / 255.0
    print(f"{args.output} subject_coverage={coverage:.3f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
