"""Render the sample PDF to per-page PNGs and assemble a slow-moving preview GIF."""
from __future__ import annotations

import shutil
from pathlib import Path

import fitz
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCE_PDF = Path(r"C:\PBI-PBIP\PDF Sample\AI Business Value Dashboard - Sample.pdf")
IMAGES_DIR = REPO_ROOT / "Images"
PAGES_DIR = IMAGES_DIR / "pages"
SOURCE_DIR = IMAGES_DIR / "source"
GIF_PATH = IMAGES_DIR / "ABV-Preview.gif"

RENDER_DPI = 150
GIF_MAX_WIDTH = 1400
FRAME_DURATION_MS = 3500
GIF_COLORS = 192


def render_pdf_pages() -> list[Path]:
    PAGES_DIR.mkdir(parents=True, exist_ok=True)
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(SOURCE_PDF, SOURCE_DIR / SOURCE_PDF.name)

    page_paths: list[Path] = []
    zoom = RENDER_DPI / 72.0
    matrix = fitz.Matrix(zoom, zoom)

    with fitz.open(SOURCE_PDF) as doc:
        for index, page in enumerate(doc, start=1):
            pix = page.get_pixmap(matrix=matrix, alpha=False)
            out = PAGES_DIR / f"page-{index:02d}.png"
            pix.save(out)
            page_paths.append(out)
    return page_paths


def build_gif(page_paths: list[Path]) -> None:
    frames: list[Image.Image] = []
    for path in page_paths:
        img = Image.open(path).convert("RGB")
        if img.width > GIF_MAX_WIDTH:
            ratio = GIF_MAX_WIDTH / img.width
            img = img.resize((GIF_MAX_WIDTH, int(img.height * ratio)), Image.LANCZOS)
        quantized = img.quantize(colors=GIF_COLORS, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        frames.append(quantized)

    frames[0].save(
        GIF_PATH,
        save_all=True,
        append_images=frames[1:],
        duration=FRAME_DURATION_MS,
        loop=0,
        optimize=True,
        disposal=2,
    )


def main() -> None:
    pages = render_pdf_pages()
    build_gif(pages)
    print(f"Rendered {len(pages)} pages -> {PAGES_DIR}")
    print(f"GIF written -> {GIF_PATH} ({GIF_PATH.stat().st_size/1_048_576:.2f} MB)")


if __name__ == "__main__":
    main()
