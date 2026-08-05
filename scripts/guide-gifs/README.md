# 가이드 영상(GIF) 재촬영

라이브 사이트(https://kwakseongjae.github.io/auto-hwp/)를 playwright 로 실제 구동해
`docs/assets/guide-{engine,vibe,bulk}.gif` 3종을 다시 찍는다. 목업/합성 없음 — 전부 실화면이다.

```bash
export GIF_OUT_DIR=/tmp/guide-gifs   # 프레임 PNG 를 레포 밖에 쌓는다(미설정 시 이 폴더 옆)
cd apps/hwp-lab                      # playwright 는 여기 node_modules 에 있다
node ../../scripts/guide-gifs/cap-engine.mjs   # → $GIF_OUT_DIR/frames-engine/*.png
node ../../scripts/guide-gifs/cap-vibe.mjs     # 데모 AI 실호출 1회(동의 confirm 자동 수락)
node ../../scripts/guide-gifs/cap-bulk.mjs

cd ../..                             # 레포 루트
scripts/guide-gifs/mkgif.sh $GIF_OUT_DIR/frames-engine docs/assets/guide-engine.gif 15 160
scripts/guide-gifs/mkgif.sh $GIF_OUT_DIR/frames-vibe   docs/assets/guide-vibe.gif   15 160
scripts/guide-gifs/mkgif.sh $GIF_OUT_DIR/frames-bulk   docs/assets/guide-bulk.gif   13 160
```

* `rec.mjs` — 캡처 하네스(프레임 시퀀스 + 커서 오버레이 + freeze/타임랩스 대기).
* `mkgif.sh` — ffmpeg palettegen/paletteuse 로 960px GIF 조립 + PIL 로 메타 출력(크기·프레임·길이).
* 캡처 스크립트는 자기검증을 한다: `cap-vibe` 는 적용/undo 가 실제로 문서를 바꿨는지 확인하고
  실패하면 exit≠0(재촬영 신호), `cap-bulk` 는 ⑤단계 도달을 확인한다.

## 규격
960px 폭 · 각 ≤8초 · ≤4MB · 라이트 모드(디폴트) · 시작/끝 정지 프레임.

## 알려진 한계
`guide-vibe` 의 **AI 전송 동의는 브라우저 네이티브 `window.confirm`** 이라 화면 캡처에 찍히지
않는다(스크립트는 실제로 수락한다 — `page.on("dialog") → accept`). 동의 장면을 영상에 담으려면
동의 게이트를 앱 내부 모달로 바꿔야 한다.
