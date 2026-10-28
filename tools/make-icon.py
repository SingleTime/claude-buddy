#!/usr/bin/env python3
"""
生成 Claude Buddy 的应用图标。

    python3 tools/make-icon.py

纯 Pillow，不依赖任何外部素材，同一份代码在任何机器上产出同一张图 ——
图标这种东西最容易变成「某人桌面上一个来路不明的 psd」，所以这里把
它当代码管。

产出：
    assets/icon.png          1024×1024
    assets/icon.icns         macOS 图标包
    build/icon.iconset/      中间产物（已 gitignore）

设计约束：
  · 配色取自 renderer/style.css，和界面同一套（--bg-3 / --accent / --text）
  · 图形是终端提示符 `>` 加块状光标 —— 这个 app 的本质就是把 claude CLI
    的终端会话搬到窗口里，没有比这个更直接的隐喻
  · 不画 Claude / Anthropic 的 logo，那是商标；只用同色系表达关联
  · 遵循 Apple 图标网格：1024 画布，824×824 内容区，圆角半径 185
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
ICONSET = ROOT / "build" / "icon.iconset"

SIZE = 1024
PAD = 100                      # Apple 模板：内容区四周各留 100
BOX = SIZE - PAD * 2           # 824
RADIUS = 185                   # Apple 模板圆角

# 取自 renderer/style.css
BG_TOP = (28, 33, 44)          # 比 --bg-3 #1a1e27 略亮
BG_BOTTOM = (12, 14, 18)       # 略暗于 --bg #0f1115
ACCENT_LIGHT = (230, 145, 102) # --accent #d97757 提亮
ACCENT_DARK = (196, 96, 60)    # --accent 压暗
CARET = (230, 232, 238)        # --text #e6e8ee


def vertical_gradient(w: int, h: int, top, bottom) -> Image.Image:
    """一次性生成 1px 宽的渐变再拉宽，比逐像素 setpixel 快两个数量级"""
    strip = Image.new("RGB", (1, h))
    px = strip.load()
    for y in range(h):
        t = y / max(1, h - 1)
        px[0, y] = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
    return strip.resize((w, h), Image.BILINEAR)


def radial_falloff(size: tuple, exponent: float = 2.4) -> Image.Image:
    """低分辨率算距离场再放大 —— 双三次插值天然把色带抹平"""
    n = 128
    img = Image.new("L", (n, n), 0)
    px = img.load()
    c = (n - 1) / 2
    for y in range(n):
        for x in range(n):
            d = (((x - c) ** 2 + (y - c) ** 2) ** 0.5) / c
            a = max(0.0, 1.0 - d)
            px[x, y] = round(255 * (a ** exponent))
    return img.resize(size, Image.BICUBIC)


def squircle_mask(size: int, box: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    off = (size - box) // 2
    d.rounded_rectangle([off, off, off + box - 1, off + box - 1], radius=radius, fill=255)
    return mask


def draw_prompt(size: int, color, weight: int) -> Image.Image:
    """终端提示符 `>` + 块状光标，画在透明层上"""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # `>` 的几何形状。三条边取圆头，用「画线 + 两端补圆」实现 ——
    # PIL 的 line 只有 joint="curve" 管转折点，管不到端点是圆的。
    #
    # 数值按内容区（824×824）居中反推：符号含圆头的总高 400、总宽 400，
    # 各占内容区 49%。macOS 的 Terminal 大致也在这一档。
    x0, x1 = 350, 525
    y_top, y_mid, y_bot = 350, 512, 674
    d.line([(x0, y_top), (x1, y_mid), (x0, y_bot)], fill=color, width=weight, joint="curve")
    for p in ((x0, y_top), (x1, y_mid), (x0, y_bot)):
        d.ellipse(
            [p[0] - weight // 2, p[1] - weight // 2, p[0] + weight // 2, p[1] + weight // 2],
            fill=color,
        )

    # 块状光标：和 `>` 等高，两端全圆，终端里那个闪烁的东西
    cw = 60
    cx0 = 652
    d.rounded_rectangle(
        [cx0, y_top, cx0 + cw, y_bot],
        radius=cw // 2,
        fill=CARET + (255,),
    )
    return layer


def accent_gradient(size: int) -> Image.Image:
    """`>` 用上亮下暗的渐变，比纯色多一点体积感"""
    g = vertical_gradient(size, size, ACCENT_LIGHT, ACCENT_DARK)
    return g.convert("RGBA")


def build() -> Image.Image:
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # 1. 底：垂直渐变
    body = vertical_gradient(SIZE, SIZE, BG_TOP, BG_BOTTOM).convert("RGBA")

    # 2. 中心径向高光，让平面有一点纵深
    glow = Image.new("RGBA", (SIZE, SIZE), (255, 255, 255, 0))
    glow.putalpha(radial_falloff((SIZE, SIZE)).point(lambda v: int(v * 0.10)))
    body = Image.alpha_composite(body, glow)

    # 3. 裁成 squircle
    body.putalpha(squircle_mask(SIZE, BOX, RADIUS))
    canvas = Image.alpha_composite(canvas, body)

    # 4. 提示符：先铺一层模糊的橙色做辉光，再叠实心
    prompt = draw_prompt(SIZE, ACCENT_LIGHT + (255,), 76)
    halo = prompt.filter(ImageFilter.GaussianBlur(26))
    halo.putalpha(halo.getchannel("A").point(lambda v: int(v * 0.55)))
    canvas = Image.alpha_composite(canvas, halo)

    # 用渐变给 `>` 上色，光标保持原色
    tinted = accent_gradient(SIZE)
    tinted.putalpha(prompt.getchannel("A"))
    # 光标区域不该被橙色染上，最后再补一遍原色
    caret = draw_prompt(SIZE, CARET + (255,), 76)
    caret_only = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    caret_only.paste(caret.crop((620, 0, SIZE, SIZE)), (620, 0))

    canvas = Image.alpha_composite(canvas, tinted)
    canvas = Image.alpha_composite(canvas, caret_only)

    # 5. 内描边：squircle 边缘一道 1.5px 的亮线，模拟被光打到的棱
    edge = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(edge).rounded_rectangle(
        [PAD, PAD, PAD + BOX - 1, PAD + BOX - 1],
        radius=RADIUS,
        outline=(255, 255, 255, 26),
        width=3,
    )
    canvas = Image.alpha_composite(canvas, edge)

    return canvas


def write_icns(png1024: Path) -> None:
    if ICONSET.exists():
        shutil.rmtree(ICONSET)
    ICONSET.mkdir(parents=True)

    # Apple 要求的十档，缺一档 iconutil 会警告
    specs = [
        (16, "icon_16x16.png"),
        (32, "icon_16x16@2x.png"),
        (32, "icon_32x32.png"),
        (64, "icon_32x32@2x.png"),
        (128, "icon_128x128.png"),
        (256, "icon_128x128@2x.png"),
        (256, "icon_256x256.png"),
        (512, "icon_256x256@2x.png"),
        (512, "icon_512x512.png"),
        (1024, "icon_512x512@2x.png"),
    ]
    for px, name in specs:
        subprocess.run(
            ["sips", "-z", str(px), str(px), str(png1024), "--out", str(ICONSET / name)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    subprocess.run(
        ["iconutil", "-c", "icns", str(ICONSET), "-o", str(ASSETS / "icon.icns")],
        check=True,
    )


def main() -> int:
    ASSETS.mkdir(parents=True, exist_ok=True)
    icon = build()
    png = ASSETS / "icon.png"
    icon.save(png)

    if sys.platform != "darwin":
        print(f"非 macOS，只输出 {png.relative_to(ROOT)}（icns 需要 iconutil）")
        return 0

    write_icns(png)
    for f in (png, ASSETS / "icon.icns"):
        print(f"{f.relative_to(ROOT)}  {f.stat().st_size / 1024:.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
