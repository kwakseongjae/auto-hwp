#!/usr/bin/env python3
"""브랜드 배너(autohwp-banner.png) → 웹 공유용 정적 자산 생성 (apps/hwp-lab/public/).

새로 디자인하지 않는다 — 이미 있는 배너(banner.html → shot.mjs 산출물) 하나에서 파생만 한다.
  * og.png        1200x630  OG/twitter 카드. 배너(2560x1040, 2.46:1)를 폭 기준으로 줄이고
                            위/아래 여백은 가장자리 행을 늘려 채운다(단색 패드는 글로우가 잘려
                            가로 이음선이 보인다).
  * icon.png      512x512   워드마크 첫 글자 "오"를 배너 배경색 위에 중앙 정렬. 배너에서 정사각
                            크롭을 뜨면 옆 글자 "토"가 딸려오므로, 밝기를 알파로 써서 오려 붙인다.
  * apple-icon.png 180x180  위와 동일(apple-touch-icon).
  * favicon.ico   16/32/48  위와 동일(멀티 사이즈).

Usage: python3 assets/brand/make-web-assets.py
Requires: Pillow.
"""
import os

from PIL import Image, ImageStat

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
BANNER = os.path.join(HERE, "autohwp-banner.png")
OUT = os.path.join(ROOT, "apps", "hwp-lab", "public")

# 배너(2560x1040) 픽셀 좌표 — 워드마크 첫 글자 "오"의 실측 bbox와 그 바로 위 빈 배경 띠.
GLYPH_BOX = (173, 280, 423, 483)
BG_BOX = (180, 240, 415, 265)
GLYPH_RATIO = 0.74  # 아이콘 한 변 대비 글자 크기


def og_card(src, w=1200, h=630):
    """배너를 폭에 맞춰 줄이고, 남는 위/아래를 가장자리 행 확대로 이어 붙인다."""
    bh = round(src.height * w / src.width)
    band = src.resize((w, bh), Image.LANCZOS)
    top = (h - bh) // 2
    card = Image.new("RGB", (w, h))
    card.paste(band.crop((0, 0, w, 2)).resize((w, top + 1), Image.BICUBIC), (0, 0))
    card.paste(band.crop((0, bh - 2, w, bh)).resize((w, h - top - bh + 1), Image.BICUBIC), (0, top + bh - 1))
    card.paste(band, (0, top))
    return card


def icon(src):
    """"오" 글자를 알파로 오려 배너 배경색 정사각 캔버스 중앙에 놓는다."""
    bg = tuple(round(v) for v in ImageStat.Stat(src.crop(BG_BOX)).mean)
    # 배경 밝기 + 여유 = 알파 0. 여유가 없으면 배너의 얇은 괘선(화이트 4%)이 살아남아 붙인
    # 사각형 경계가 아이콘에 가로줄로 보인다.
    floor = sum(bg) // 3 + 16
    mask = (
        src.convert("L")
        .crop(GLYPH_BOX)
        .point(lambda v: 0 if v <= floor else min(255, round((v - floor) * 255 / (255 - floor))))
    )
    gw, gh = mask.size
    side = round(max(gw, gh) / GLYPH_RATIO)
    canvas = Image.new("RGB", (side, side), bg)
    canvas.paste(Image.new("RGB", (gw, gh), (255, 255, 255)), ((side - gw) // 2, (side - gh) // 2), mask)
    return canvas


def main():
    src = Image.open(BANNER).convert("RGB")
    og_card(src).save(os.path.join(OUT, "og.png"), optimize=True)
    ico = icon(src)
    ico.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "icon.png"), optimize=True)
    ico.resize((180, 180), Image.LANCZOS).save(os.path.join(OUT, "apple-icon.png"), optimize=True)
    ico.resize((48, 48), Image.LANCZOS).save(
        os.path.join(OUT, "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)]
    )
    print("[brand] og.png · icon.png · apple-icon.png · favicon.ico →", OUT)


if __name__ == "__main__":
    main()
