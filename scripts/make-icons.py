#!/usr/bin/env python3
"""Render the Goldfelty app icon.

There is no image toolchain in this repo on purpose: the icon is a handful of
shapes, so it is cheaper to rasterise them here than to depend on ImageMagick.
Output is a rounded gold tile carrying a "G", supersampled 4x for clean edges.
"""
import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SS = 4  # supersampling factor

GOLD_TOP = (0xE8, 0xC3, 0x5E)
GOLD_BOTTOM = (0xB8, 0x87, 0x0C)
GLYPH = (0x24, 0x1A, 0x05)


def rounded_rect(x, y, w, h, radius):
    """Coverage test for a rounded rectangle at a sample point."""
    cx = min(max(x, radius), w - radius)
    cy = min(max(y, radius), h - radius)
    return math.hypot(x - cx, y - cy) <= radius


def glyph_g(x, y, size):
    """Coverage test for the G: an open ring plus a crossbar."""
    cx = cy = size / 2
    dx = x - cx
    dy = cy - y  # flip so +y points up, which is how the angles below read
    d = math.hypot(dx, dy)

    r_out = size * 0.315
    r_in = size * 0.205

    if r_in <= d <= r_out:
        angle = math.degrees(math.atan2(dy, dx))
        # Leave the ring open on the upper right — that gap is what makes it a
        # G rather than an O.
        if not (0.0 <= angle <= 42.0):
            return True

    # Crossbar: runs from just left of centre out to the ring's outer edge,
    # tucked directly under the gap.
    bar_top = -size * 0.005
    bar_bottom = -size * 0.105
    if bar_bottom <= dy <= bar_top:
        # Stop at the ring's outer curve, not at r_out, or the bar grows a nub
        # where it pokes past the circle.
        bar_end = math.sqrt(max(r_out * r_out - dy * dy, 0.0))
        if size * 0.02 <= dx <= bar_end:
            return True

    return False


def render(size):
    pixels = bytearray()
    radius = size * 0.225
    inv = 1.0 / (SS * SS)

    for py in range(size):
        row = bytearray()
        for px in range(size):
            tile_hits = 0
            glyph_hits = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = px + (sx + 0.5) / SS
                    y = py + (sy + 0.5) / SS
                    if rounded_rect(x, y, size, size, radius):
                        tile_hits += 1
                        if glyph_g(x, y, size):
                            glyph_hits += 1

            alpha = tile_hits * inv
            if alpha == 0:
                row += b"\x00\x00\x00\x00"
                continue

            # Vertical gradient across the tile.
            t = py / max(size - 1, 1)
            base = tuple(
                round(GOLD_TOP[i] + (GOLD_BOTTOM[i] - GOLD_TOP[i]) * t) for i in range(3)
            )
            g = (glyph_hits * inv) / alpha if alpha else 0
            colour = tuple(round(base[i] + (GLYPH[i] - base[i]) * g) for i in range(3))
            row += bytes(colour) + bytes([round(alpha * 255)])
        pixels += b"\x00" + row  # filter byte 0 (None) per scanline
    return bytes(pixels)


def chunk(tag, data):
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path, size):
    raw = render(size)
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)
    print(f"wrote {path.relative_to(ROOT)} ({size}x{size}, {len(png)} bytes)")


if __name__ == "__main__":
    # electron-builder derives .icns and .ico from this one.
    write_png(ROOT / "resources" / "icon.png", 1024)
    for size in (512, 256, 128, 64, 48, 32, 16):
        write_png(ROOT / "resources" / "icons" / f"{size}x{size}.png", size)
