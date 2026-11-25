"""Make every iOS and Android launcher icon from one picture.

Source: assets/icon/app_icon.png - square, opaque, the symbol on a black background
(the Hashnate-coloured WorkSight icon). Replace it and run this again to change the icon.

    cd mobile && python3 tool/make_icons.py        # needs: pip install pillow numpy

Writes:
  ios/Runner/Assets.xcassets/AppIcon.appiconset/*.png   every size Contents.json lists, no alpha
  android/app/src/main/res/mipmap-*/ic_launcher.png      Android 7.x (rounded square)
  android/app/src/main/res/mipmap-*/ic_launcher_foreground.png, ic_launcher_monochrome.png
  android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml + values/ic_launcher_background.xml
  assets/icon/play_store_512.png                          for the Google Play listing
"""

import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets/icon/app_icon.png"
IOS_SET = ROOT / "ios/Runner/Assets.xcassets/AppIcon.appiconset"
RES = ROOT / "android/app/src/main/res"
BACKGROUND = "#000000"

# Android adaptive icons are 108dp; launchers show the middle 72dp and may cut it to a circle
# (66dp is always safe). 44dp keeps the symbol the same share of the visible icon as on iOS
# (61%) and inside the safe circle.
ADAPTIVE_DP, SYMBOL_DP = 108, 44
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
NOISE = 10  # channel values below this in the background count as black


def load_master() -> np.ndarray:
    rgb = np.asarray(Image.open(SRC).convert("RGB")).astype(np.float32)
    rgb[rgb.max(axis=2) < NOISE] = 0  # flatten the near-black compression noise
    return rgb


def opaque(rgb: np.ndarray, size: int) -> Image.Image:
    return Image.fromarray(rgb.astype(np.uint8), "RGB").resize((size, size), Image.LANCZOS)


def symbol_only(rgb: np.ndarray) -> Image.Image:
    """The symbol on transparency: undo the blend with black (alpha = brightest channel)."""
    alpha = rgb.max(axis=2)
    colour = np.where(alpha[..., None] > 0, rgb * 255.0 / np.maximum(alpha, 1)[..., None], 0)
    rgba = np.dstack([np.clip(colour, 0, 255), alpha]).astype(np.uint8)
    img = Image.fromarray(rgba, "RGBA")
    return img.crop(img.getbbox())


def centred(symbol: Image.Image, canvas: int, symbol_px: int, white: bool = False) -> Image.Image:
    scale = symbol_px / max(symbol.size)
    s = symbol.resize((round(symbol.width * scale), round(symbol.height * scale)), Image.LANCZOS)
    if white:  # monochrome layer: Android tints it, only the shape matters
        s = Image.merge("RGBA", (*Image.new("RGB", s.size, "white").split(), s.getchannel("A")))
    out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    out.paste(s, ((canvas - s.width) // 2, (canvas - s.height) // 2), s)
    return out


def rounded(img: Image.Image, radius_share: float = 0.22) -> Image.Image:
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, img.width - 1, img.height - 1),
                                           radius=round(img.width * radius_share), fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def main() -> None:
    master = load_master()
    symbol = symbol_only(master)

    # iOS: every file the asset catalogue lists, opaque (App Store rejects alpha).
    for entry in json.loads((IOS_SET / "Contents.json").read_text())["images"]:
        if "filename" not in entry:
            continue
        points = float(entry["size"].split("x")[0])
        px = round(points * int(entry["scale"].rstrip("x")))
        opaque(master, px).save(IOS_SET / entry["filename"], optimize=True)

    # Android
    for name, factor in DENSITIES.items():
        folder = RES / f"mipmap-{name}"
        folder.mkdir(exist_ok=True)
        rounded(opaque(master, round(48 * factor))).save(folder / "ic_launcher.png", optimize=True)
        canvas, sym = round(ADAPTIVE_DP * factor), round(SYMBOL_DP * factor)
        centred(symbol, canvas, sym).save(folder / "ic_launcher_foreground.png", optimize=True)
        centred(symbol, canvas, sym, white=True).save(folder / "ic_launcher_monochrome.png", optimize=True)

    (RES / "mipmap-anydpi-v26").mkdir(exist_ok=True)
    (RES / "mipmap-anydpi-v26/ic_launcher.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@color/ic_launcher_background" />\n'
        '    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n'
        '    <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />\n'
        '</adaptive-icon>\n')
    (RES / "values/ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
        f'    <color name="ic_launcher_background">{BACKGROUND}</color>\n</resources>\n')

    opaque(master, 512).save(ROOT / "assets/icon/play_store_512.png", optimize=True)
    print("Icons written for iOS and Android.")


if __name__ == "__main__":
    main()
