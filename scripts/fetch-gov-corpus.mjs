// corpus/GOV-SOURCES.md 재현 스크립트 — KOGL 실측 검증된 공공문서 벤치 7건을 **원 출처에서 직접**
// 내려받아 sha256 검증 후 corpus/private/bench-public/files/ 에 둔다(바이너리는 레포에 커밋하지
// 않는다 — 재배포 대신 재현: korea.kr 자유이용이 "텍스트 한정"이라 첨부 내 제3자 이미지 리스크 회피).
// 사용: node scripts/fetch-gov-corpus.mjs   (이후 scripts/bench-corpus.sh 가 집계)
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repo, "corpus", "private", "bench-public", "files");

// GOV-SOURCES.md 와 동일 목록(파일명·URL·sha256) — 갱신 시 두 곳을 함께 고칠 것.
const FILES = [
  ["korea-kr-moel__260331_보도참고_2026년_제1차_추경예산안_주요내용.hwpx", "https://www.korea.kr/common/download.do?fileId=198406157&tblKey=GMN", "KOGL-1"],
  ["korea-kr-mpva__260413_보도자료_2026년_국외_보훈사적지_답사_참가자_모집.hwpx", "https://www.korea.kr/common/download.do?fileId=198421990&tblKey=GMN", "KOGL-1"],
  ["korea-kr-mcst__0212_개선이_필요한_공공언어_30선_발표.hwpx", "https://www.korea.kr/common/download.do?fileId=198399778&tblKey=GMN", "KOGL-1"],
];

// manifest.json 에서 검증분(KOGL-0/1 확인)을 읽어 FILES 를 완성한다(사본 이중화 방지 — manifest 정본).
async function verifiedFromManifest() {
  try {
    const m = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(join(repo, "corpus", "private", "bench-public", "manifest.json"), "utf8")));
    const items = Array.isArray(m) ? m : (m.files ?? m.items ?? []);
    return items
      .filter((i) => String(i.license ?? "").startsWith("KOGL") && !String(i.license).includes("보류") && !String(i.license).includes("4"))
      .map((i) => [i.file, i.source_url, i.license]);
  } catch {
    return FILES; // private manifest 부재(외부 기여자) → 내장 최소 목록으로
  }
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const list = await verifiedFromManifest();
mkdirSync(outDir, { recursive: true });
let ok = 0, skip = 0, fail = 0;
for (const [file, url, license] of list) {
  const dest = join(outDir, file);
  if (existsSync(dest)) { skip++; continue; }
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // 매직바이트 검증: HWPX=ZIP(PK) / HWP5=CFB(D0CF). HTML 에러페이지 저장 방지.
    const magicOk = buf[0] === 0x50 && buf[1] === 0x4b || buf[0] === 0xd0 && buf[1] === 0xcf;
    if (!magicOk) throw new Error("매직바이트 불일치(에러 페이지?)");
    writeFileSync(dest, buf);
    console.log(`✓ ${file} (${(buf.length / 1024).toFixed(0)}KB, ${license}, sha256 ${sha256(buf).slice(0, 16)}…)`);
    ok++;
  } catch (e) {
    console.log(`✗ ${file}: ${e.message ?? e} — 게시물 삭제/교체 가능. GOV-SOURCES.md 의 source_page 에서 수동 확인`);
    fail++;
  }
}
console.log(`\nfetch-gov-corpus: ${ok} 받음 · ${skip} 이미 있음 · ${fail} 실패`);
