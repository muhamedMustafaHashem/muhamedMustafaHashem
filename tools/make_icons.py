#!/usr/bin/env python3
"""Generate PWA icons into public/icons/ (needs pillow)."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)
BG = (16, 92, 72)       # deep green
FG = (255, 255, 255)
ACCENT = (255, 196, 61)


def draw(size):
    img = Image.new("RGBA", (size, size), BG)
    d = ImageDraw.Draw(img)
    u = size / 100
    # camera body
    d.rounded_rectangle([18 * u, 32 * u, 82 * u, 76 * u], radius=8 * u, fill=FG)
    d.rounded_rectangle([36 * u, 24 * u, 64 * u, 36 * u], radius=4 * u, fill=FG)
    # lens
    d.ellipse([37 * u, 41 * u, 63 * u, 67 * u], fill=BG)
    d.ellipse([42 * u, 46 * u, 58 * u, 62 * u], fill=ACCENT)
    # check mark badge
    d.ellipse([62 * u, 58 * u, 88 * u, 84 * u], fill=ACCENT)
    d.line([(68 * u, 71 * u), (74 * u, 77 * u), (83 * u, 64 * u)], fill=BG, width=max(2, int(4 * u)))
    return img


for s in (192, 512):
    draw(s).save(OUT / f"icon-{s}.png")
# maskable: same art with extra padding
big = draw(512)
m = Image.new("RGBA", (640, 640), BG)
m.paste(big, (64, 64))
m.resize((512, 512), Image.LANCZOS).save(OUT / "maskable-512.png")
draw(180).save(OUT / "apple-touch-icon.png")
print("icons written to", OUT)
