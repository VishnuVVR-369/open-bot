"""Writes the desktop wallpaper: a quiet dark gradient with a soft violet glow."""
import math, struct, sys, zlib

W, H = 1280, 800
rows = []
for y in range(H):
    row = bytearray(b"\x00")
    for x in range(W):
        # Base: deep graphite, slightly lighter at the top.
        t = y / H
        r, g, b = 16 - 6 * t, 17 - 6 * t, 22 - 7 * t
        # A soft violet glow in the upper right.
        d = math.hypot((x - W * 0.78) / W, (y - H * 0.18) / H)
        glow = max(0.0, 1 - d / 0.62) ** 2.2
        r += 70 * glow; g += 52 * glow; b += 140 * glow
        # A faint teal glow in the lower left.
        d2 = math.hypot((x - W * 0.12) / W, (y - H * 0.95) / H)
        glow2 = max(0.0, 1 - d2 / 0.55) ** 2.4
        r += 6 * glow2; g += 46 * glow2; b += 52 * glow2
        row += bytes((min(255, int(r)), min(255, int(g)), min(255, int(b))))
    rows.append(bytes(row))

def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")
open(sys.argv[1], "wb").write(png)
