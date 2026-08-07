#!/usr/bin/env python3
"""로고 시스템(A 워드마크 · C 낙관) → 브랜드 파생 자산 일괄 생성.

원본(생성모델 산출, 흰 배경 RGB)은 `logo-candidates/` 에 있고 **손대지 않는다**.
여기서 나오는 것만 제품이 쓴다.

  assets/brand/
    wordmark.png       A 투명본(먹 획 + 보라 갈필). 라이트 배경용.
    wordmark-dark.png  같은 알파에 잉크만 밝게(먹→백지색, 보라→연보라). 다크 배경용.
    seal.png           C 투명본. **음각(흰 글자)도 투명**이다 — 배경이 글자로 비쳐야
                       종이에 찍은 낙관처럼 읽힌다(다크/라이트 양쪽에서 성립).
  apps/hwp-lab/public/
    favicon.ico   16/32/48   C 낙관
    icon.png      512        C 낙관(투명)
    apple-icon.png 180       C 낙관 + 불투명 종이 바탕(iOS 는 투명을 검게 깐다)
    og.png        1200x630   종이 위에 A 워드마크, 우하단에 C 낙관을 서명처럼
  apps/hwp-lab/public/brand/  (사이트가 내려받는 웹 사본 — 마스터보다 작다)
    wordmark.png / wordmark-dark.png / seal.png

Usage: python3 assets/brand/make-web-assets.py
Requires: Pillow.
"""

import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SRC = os.path.join(HERE, "logo-candidates")
OUT_PUB = os.path.join(ROOT, "apps", "hwp-lab", "public")
OUT_BRAND = os.path.join(OUT_PUB, "brand")

PAPER = 254.0  # 원본 배경 실측 최빈값(=흰 종이). 255 로 잡으면 254 배경이 알파 1/255 로 남는다.
DEADBAND = 0.015  # 종이 노이즈(253~255)를 알파 0 으로 눌러 붙인다. 획 안티앨리어싱은 그대로.

PAPER_BG = (245, 246, 251)  # --ah-bg (라이트) — OG/애플아이콘 바탕
INK_DARK = (244, 245, 251)  # 다크 테마용 먹색 대체(백지색)
ACCENT_DARK = (167, 139, 250)  # 다크 테마용 보라 대체 (#a78bfa)
SEAL_INK = (117, 25, 197)  # 낙관 인주 실측 중앙값 — 도장은 잉크 한 색이다
SD_GOTHIC = "/System/Library/Fonts/AppleSDGothicNeo.ttc"  # OG 타이포(빌드타임 전용, macOS)


def _is_purple(r, g, b):
    """보라 갈필/인주 판정 — 먹(무채색)과 갈라내기 위한 최소 조건."""
    return b - g > 40 and r - g > 25


def unmat(src, purple_green=None):
    """흰 배경 위 잉크를 **언매트**해 RGBA 로 되돌린다.

    obs = a*ink + (1-a)*paper 를 알파에 대해 푼다.
      · 먹(무채색): 어느 채널이든 같으므로 최소 채널로 커버리지를 잡는다.
      · 보라: 최소 채널(녹)이 0 이 아니라서 위 식이 알파를 과소평가한다(≈0.92).
        원본에서 실측한 보라의 녹 채널(purple_green)을 바닥으로 삼아 커버리지를 다시 잡는다.
    색은 언매트(un-premultiply)해 되돌리므로 흰 배경에 다시 얹으면 원본과 같은 픽셀이 된다.
    """
    src = src.convert("RGB")
    w, h = src.size
    px = src.load()
    out = Image.new("RGBA", (w, h))
    op = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            m = min(r, g, b)
            if purple_green is not None and _is_purple(r, g, b):
                a = (PAPER - g) / (PAPER - purple_green)
            else:
                a = (PAPER - m) / PAPER
            a = (a - DEADBAND) / (1.0 - DEADBAND)
            if a <= 0:
                op[x, y] = (0, 0, 0, 0)
                continue
            a = min(1.0, a)
            # un-premultiply: ink = (obs - (1-a)*paper) / a
            inv = (1.0 - a) * 255.0
            ink = tuple(max(0, min(255, round((c - inv) / a))) for c in (r, g, b))
            op[x, y] = (*ink, round(a * 255))
    return out


def trim(im, pad=0):
    """알파 bbox 로 잘라 여백을 없앤다 — 레이아웃은 CSS 가 잡게 두는 게 낫다."""
    box = im.getchannel("A").getbbox()
    if not box:
        return im
    l, t, r, b = box
    l, t = max(0, l - pad), max(0, t - pad)
    r, b = min(im.width, r + pad), min(im.height, b + pad)
    return im.crop((l, t, r, b))


def recolor_for_dark(im):
    """알파는 그대로 두고 잉크색만 다크 배경용으로 바꾼다(먹→백지색, 보라→연보라)."""
    out = im.copy()
    p = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = p[x, y]
            if a == 0:
                continue
            p[x, y] = (*(ACCENT_DARK if _is_purple(r, g, b) else INK_DARK), a)
    return out


def flatten_ink(im, ink):
    """농담(濃淡)은 이미 알파가 들고 있다 — RGB 를 한 색으로 눌러 인주색을 통일한다.
    부수 효과로 RGB 3면이 상수가 되어 PNG 가 훨씬 작아진다(1.4MB → 수십 KB)."""
    solid = Image.new("RGBA", im.size, (*ink, 255))
    solid.putalpha(im.getchannel("A"))
    return solid


def save_alpha_palette(im, path, ink, levels=64):
    """단색 잉크 + 알파만 있는 그림을 **팔레트 PNG(index=알파)** 로 저장한다.

    32bpp RGBA 로 두면 도장의 인주 텍스처(알파 노이즈)가 압축을 방해해 600KB 가 넘는다.
    RGB 가 이미 한 색이므로 index 를 알파로 쓰고 팔레트 256칸을 전부 잉크색으로 채우면
    8bpp 가 된다(tRNS 로 알파 복원). 거기에 알파를 64단계로 눌러 텍스처 노이즈의
    엔트로피를 줄인다 — 눈으로는 구분되지 않고 크기는 다시 절반이 된다(398→231KB).
    """
    step = 255 / (levels - 1)
    idx = im.getchannel("A").point(lambda v: round(round(v / step) * step))
    out = Image.new("P", im.size)
    out.putdata(list(idx.get_flattened_data()))
    out.putpalette(list(ink) * 256)
    out.save(path, transparency=bytes(range(256)), optimize=True)


def fit(im, box_w, box_h):
    """비율 유지 축소."""
    s = min(box_w / im.width, box_h / im.height)
    return im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)


def seal_icon(seal, side, bg=None, inset=0.94):
    """낙관을 정사각 캔버스에 앉힌다. inset = 도장이 차지하는 한 변 비율.

    작은 크기에서 테두리가 뭉개지지 않으려면 여백이 적을수록 좋다 — 도장 자체가
    이미 '테두리 + 안쪽 여백'을 갖고 있어 캔버스 여백을 더 줄 이유가 없다.
    """
    canvas = Image.new("RGBA", (side, side), (*bg, 255) if bg else (0, 0, 0, 0))
    g = fit(seal, round(side * inset), round(side * inset))
    canvas.alpha_composite(g, ((side - g.width) // 2, (side - g.height) // 2))
    return canvas


# 낙관의 '안쪽 블록'(가는 바깥 테두리 + 그 틈을 뺀 부분)의 실측 박스. 알파 스캔라인에서
# 바깥테두리 44px → 틈 28px → 안쪽테두리 34px 로 읽힌다(959x986 기준).
INNER_BLOCK = (78, 78, 882, 908)


def favicon_tile(seal, size):
    """탭 크기별로 **다르게** 만든다 — 16px 에서 이중 테두리는 정보가 아니라 뭉개짐이다.

      16px  안쪽 블록만 + 알파 침식(MinFilter 7) — 음각 획이 0.6px 라 그냥 줄이면
            "토" 의 가로 세 획이 한 덩어리로 붙는다. 보라를 조금 깎아 획을 넓힌다.
      32px  안쪽 블록만(침식 없이) — 이미 획이 또렷하다.
      48px  원본 그대로 — 이중 테두리(도장의 성격)가 살아나는 최소 크기.

    ⚠️ 비율 유지(레터박스)로 넣지 않는다 — 도장이 세로로 2.8% 길어 16칸 중 한 칸이
       빈 열로 날아가고, 그 한 칸이 16px 가독성을 눈에 띄게 깎는다. 정사각으로
       늘려 채운다(손으로 판 도장이라 3% 왜곡은 보이지 않는다).
    """
    src = seal if size >= 48 else seal.crop(INNER_BLOCK)
    if size <= 16:
        src = Image.merge("RGBA", (*src.split()[:3], src.getchannel("A").filter(ImageFilter.MinFilter(7))))
    return src.resize((size, size), Image.LANCZOS)


def og_card(wordmark, seal, w=1200, h=630):
    """종이(=--ah-bg) 위 워드마크 + 우하단 낙관. 브랜드 은유 = '문서에 찍힌 도장'.

    ⚠️ 타이포는 macOS 시스템 폰트(Apple SD Gothic Neo)로 굽는다 — 라이브 랜딩의
       font-family 첫 항목과 같다. 이 스크립트는 빌드타임 전용(산출 PNG 만 커밋)이라
       런타임 폰트 의존이 아니다.
    """
    card = Image.new("RGBA", (w, h), (*PAPER_BG, 255))

    # 라이브 랜딩과 같은 보라/파랑 글로우 — 단색 판때기로 보이지 않게 아주 옅게.
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gp = glow.load()
    for y in range(h):
        for x in range(w):
            d1 = ((x - w * 0.88) / (w * 0.55)) ** 2 + ((y - h * 0.04) / (h * 0.75)) ** 2
            d2 = ((x - w * 0.04) / (w * 0.5)) ** 2 + ((y - h * 1.02) / (h * 0.8)) ** 2
            a1 = max(0.0, 1.0 - d1) * 0.11
            a2 = max(0.0, 1.0 - d2) * 0.07
            gp[x, y] = (124, 58, 237, round(a1 * 255)) if a1 >= a2 else (37, 99, 235, round(a2 * 255))
    card.alpha_composite(glow)

    draw = ImageDraw.Draw(card)
    cx = round(w * 0.47)  # 낙관이 오른쪽 아래를 차지하므로 텍스트 축을 살짝 왼쪽으로

    kicker = ImageFont.truetype(SD_GOTHIC, 21, index=6)  # Bold
    tagline = ImageFont.truetype(SD_GOTHIC, 33, index=4)  # SemiBold
    sub = ImageFont.truetype(SD_GOTHIC, 21, index=2)  # Medium

    def center(text, font, y, fill, tracking=0):
        if tracking:
            total = sum(draw.textlength(c, font=font) + tracking for c in text) - tracking
            x = cx - total / 2
            for c in text:
                draw.text((x, y), c, font=font, fill=fill, anchor="lt")
                x += draw.textlength(c, font=font) + tracking
        else:
            draw.text((cx, y), text, font=font, fill=fill, anchor="mt")

    center("한글 문서를 직접 다루는 엔진", kicker, round(h * 0.135), (109, 40, 217, 255), tracking=4.6)

    mark = fit(wordmark, round(w * 0.56), round(h * 0.30))
    card.alpha_composite(mark, (cx - mark.width // 2, round(h * 0.235)))

    center("AI와 함께, 한 화면을 보면서 쓰는 한글", tagline, round(h * 0.615), (10, 15, 28, 255))
    center("설치도 회원가입도 없이 — 열기 · 편집 · PDF 내보내기가 브라우저 안에서", sub, round(h * 0.735), (90, 98, 116, 255))

    # 서명 위치의 낙관 — 워드마크보다 확실히 작게(도장은 거드는 요소다).
    st = fit(seal, round(h * 0.155), round(h * 0.155))
    card.alpha_composite(st, (w - st.width - round(w * 0.045), h - st.height - round(h * 0.075)))
    return card


def main():
    wordmark = trim(unmat(Image.open(os.path.join(SRC, "logo-a-full.png")), purple_green=19))
    seal = flatten_ink(trim(unmat(Image.open(os.path.join(SRC, "logo-c-seal.png")), purple_green=25)), SEAL_INK)

    wordmark.save(os.path.join(HERE, "wordmark.png"), optimize=True)
    recolor_for_dark(wordmark).save(os.path.join(HERE, "wordmark-dark.png"), optimize=True)
    save_alpha_palette(seal, os.path.join(HERE, "seal.png"), SEAL_INK)

    save_alpha_palette(seal_icon(seal, 512), os.path.join(OUT_PUB, "icon.png"), SEAL_INK)
    # apple-touch-icon 은 투명을 지원하지 않는 자리(홈 화면)에 깔린다 — 종이 바탕을 깔아 준다.
    seal_icon(seal, 180, bg=PAPER_BG, inset=0.80).save(os.path.join(OUT_PUB, "apple-icon.png"), optimize=True)
    # ⚠️ sizes= 만 주면 한 장을 축소해 세 칸을 채운다 — 그러면 16px 가 뭉갠다.
    #    append_images 로 **크기별로 다르게 만든 타일**을 직접 넣는다(favicon_tile 참고).
    favicon_tile(seal, 48).save(
        os.path.join(OUT_PUB, "favicon.ico"),
        sizes=[(16, 16), (32, 32), (48, 48)],
        append_images=[favicon_tile(seal, 16), favicon_tile(seal, 32)],
    )

    og_card(wordmark, seal).convert("RGB").save(os.path.join(OUT_PUB, "og.png"), optimize=True)

    # 사이트가 실제로 내려받는 사본 — 마스터를 그대로 실으면 표시 크기의 3~4배라 낭비다.
    # 워드마크는 히어로에서 최대 ~460px 로 그려지므로 960px(≈2x), 낙관은 헤더 20px 용 128px.
    os.makedirs(OUT_BRAND, exist_ok=True)
    fit(wordmark, 960, 960).save(os.path.join(OUT_BRAND, "wordmark.png"), optimize=True)
    fit(recolor_for_dark(wordmark), 960, 960).save(os.path.join(OUT_BRAND, "wordmark-dark.png"), optimize=True)
    save_alpha_palette(fit(seal, 128, 128), os.path.join(OUT_BRAND, "seal.png"), SEAL_INK)

    print("[brand] wordmark(.png/-dark.png) · seal.png →", HERE)
    print("[brand] favicon.ico · icon.png · apple-icon.png · og.png →", OUT_PUB)
    print("[brand] wordmark(.png/-dark.png) · seal.png (웹 사본) →", OUT_BRAND)


if __name__ == "__main__":
    main()
