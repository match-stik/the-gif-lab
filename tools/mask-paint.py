#!/usr/bin/env python3
"""Apply hand-painted corrections to a cut-out's transparency.

No model is right on every picture — a dark sleeve against a dark room, a hand
crossing a face — so the mask has to be editable by the person looking at it.
This edits the alpha channel only: color data is never touched, so strokes
cannot smear or recolour the subject, and a restore brings back the original
pixels rather than a guess at them.

Needs nothing but Pillow.

Usage:
    mask-paint.py <frame> <original> <output> [--restore mask.png] [--erase mask.png]

Painted layers are PNGs at any size (they get resized to the frame): opaque or
white means painted, transparent or black means leave alone.
"""

import argparse
import sys

from PIL import Image, ImageChops


def load_paint(path: str, size: tuple[int, int]) -> Image.Image:
    """Read a painted layer as a coverage mask.

    A browser canvas sends transparent pixels with strokes drawn on them, so the
    alpha channel is the stroke. Accept a plain greyscale mask too, since that is
    what anything scripting this would naturally produce.
    """
    paint = Image.open(path)
    coverage = paint.getchannel("A") if paint.mode in ("RGBA", "LA") else paint.convert("L")
    if coverage.size != size:
        coverage = coverage.resize(size, Image.LANCZOS)
    # Anti-aliased stroke edges arrive as mid-greys. Keep them soft rather than
    # hardening them, so a painted edge blends instead of stair-stepping.
    return coverage


def main() -> int:
    parser = argparse.ArgumentParser(description="Paint a cut-out's alpha by hand.")
    parser.add_argument("frame", help="Current cut frame (RGBA).")
    parser.add_argument("original", help="Untouched frame — the source of restored pixels.")
    parser.add_argument("output")
    parser.add_argument("--restore", help="Painted layer marking what should be opaque.")
    parser.add_argument("--erase", help="Painted layer marking what should be transparent.")
    args = parser.parse_args()

    frame = Image.open(args.frame).convert("RGBA")
    original = Image.open(args.original).convert("RGB")
    if original.size != frame.size:
        original = original.resize(frame.size, Image.LANCZOS)

    alpha = frame.getchannel("A")

    if args.restore:
        # lighter() takes the per-pixel maximum, so restoring beside an already
        # solid edge can only add opacity — it can never punch a hole.
        alpha = ImageChops.lighter(alpha, load_paint(args.restore, frame.size))

    if args.erase:
        # darker() against the inverted stroke: painted areas go transparent,
        # everything else keeps whatever alpha it had.
        alpha = ImageChops.darker(alpha, ImageChops.invert(load_paint(args.erase, frame.size)))

    # Color comes from the original everywhere, so a restored area carries real
    # pixels even if an earlier pass wrote over what sat under the transparency.
    out = original.convert("RGBA")
    out.putalpha(alpha)
    out.save(args.output, "PNG")

    print(f"{args.output} painted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
