"""Generate bundled icons from the supplied artwork (requires Pillow and pnpm)."""

from pathlib import Path
import shutil
import subprocess

from PIL import Image, ImageDraw


app = Path(__file__).resolve().parents[1]
source = app.parent / "deslop icon.png"
artwork = Image.open(source).convert("RGBA")

# The supplied export has an opaque, pure-black outer canvas. Remove only
# black connected to its outside corner; keep enclosed dark parts of the drive.
if artwork.getpixel((0, 0)) == (0, 0, 0, 255):
    ImageDraw.floodfill(artwork, (0, 0), (0, 0, 0, 0), thresh=0)

bounds = artwork.getchannel("A").getbbox()
if bounds is None:
    raise ValueError("The source icon is empty")
artwork = artwork.crop(bounds)
artwork.thumbnail((896, 896), Image.Resampling.LANCZOS)
canvas = Image.new("RGBA", (1024, 1024))
canvas.alpha_composite(artwork, ((1024 - artwork.width) // 2, (1024 - artwork.height) // 2))
canvas.save(app / "app-icon.png", optimize=True)

subprocess.run(["pnpm", "tauri", "icon", "app-icon.png"], cwd=app, check=True)
shutil.copyfile(app / "src-tauri/icons/128x128.png", app / "public/favicon.png")
print("Updated app-icon.png, native bundle icons, and favicon.png")
