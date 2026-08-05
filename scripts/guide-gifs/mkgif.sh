#!/bin/bash
# 프레임 시퀀스 → 960px 폭 GIF (palettegen/paletteuse + 프레임 간 diff 최적화)
# usage: mkgif.sh <frames-dir> <out.gif> [fps] [colors] [lossy]
set -euo pipefail
DIR="$1"; OUT="$2"; FPS="${3:-13}"; COLORS="${4:-128}"; DITHER="${5:-bayer:bayer_scale=3}"
PAL="$(dirname "$OUT")/.pal-$(basename "$OUT").png"
ffmpeg -v error -y -framerate "$FPS" -i "$DIR/f%04d.png" \
  -vf "scale=960:-2:flags=lanczos,palettegen=max_colors=$COLORS:stats_mode=diff" "$PAL"
ffmpeg -v error -y -framerate "$FPS" -i "$DIR/f%04d.png" -i "$PAL" \
  -lavfi "scale=960:-2:flags=lanczos[x];[x][1:v]paletteuse=dither=$DITHER:diff_mode=rectangle" \
  -loop 0 "$OUT"
rm -f "$PAL"
python3 - "$OUT" <<'PY'
import sys
from PIL import Image
import os
p = sys.argv[1]
im = Image.open(p)
n = 0
dur = 0
try:
    while True:
        dur += im.info.get("duration", 0)
        n += 1
        im.seek(im.tell() + 1)
except EOFError:
    pass
print(f"{p}: {os.path.getsize(p)/1024/1024:.2f} MB · {n} frames · {im.size[0]}x{im.size[1]} · {dur/1000:.2f}s")
PY
