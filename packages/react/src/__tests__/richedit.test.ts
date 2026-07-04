import { describe, expect, it } from "vitest";
import type { RunSpec } from "@tf-hwp/editor-core";
import {
  runsToHtml,
  serializeEditor,
  runsText,
  runsEqual,
  canonRuns,
  runsUnchanged,
  sizePx,
} from "../richedit";

// The round-trip is the 1급 산출물 (issue 040): render runs → contentEditable DOM → serialize back → canon
// equal to the original. jsdom's getComputedStyle reports inline font-weight/style/size/color/decoration
// (verified), so the styleOf read path exercises the SAME code the real browser runs on commit.
const SCALE = 1;

/** Render runs into a real (jsdom) contentEditable div exactly as the editor does on open. */
function mount(runs: RunSpec[], scale = SCALE): HTMLElement {
  const el = document.createElement("div");
  el.style.color = "#000"; // 교훈 1: the editor renders pure black (styles.css) so untouched text is color-less
  el.innerHTML = runsToHtml(runs, scale);
  document.body.appendChild(el);
  return el;
}

/** The full open→serialize round-trip, canonicalized on both ends (the no-op baseline compare). */
function roundTrip(runs: RunSpec[], scale = SCALE): RunSpec[] {
  return serializeEditor(mount(runs, scale), scale);
}

describe("richedit sizePx (issue 040) — pt→screen px at zoom", () => {
  it("is 4/3 page px per point × scale (100 HWPUNIT/pt ÷ 75 HWPUNIT/px)", () => {
    expect(sizePx(9, 1)).toBeCloseTo(12, 6); // 9pt × 4/3 = 12px
    expect(sizePx(12, 2)).toBeCloseTo(32, 6); // 12pt × 4/3 × 2 = 32px
  });
  it("an inherited (unset) size draws at the ~10pt doc default", () => {
    expect(sizePx(null, 1)).toBeCloseTo(40 / 3, 6); // 10pt × 4/3
    expect(sizePx(undefined, 1)).toBeCloseTo(40 / 3, 6);
  });
});

describe("richedit round-trip — lossless render↔serialize (issue 040)", () => {
  it("a plain single run round-trips to itself (no spurious style)", () => {
    const runs: RunSpec[] = [{ text: "안녕하세요" }];
    expect(runsUnchanged(roundTrip(runs), runs)).toBe(true);
    expect(runsText(roundTrip(runs))).toBe("안녕하세요");
  });

  it("bold / italic / underline / strike each round-trip (교훈 3: strike in render+read+compare)", () => {
    for (const key of ["bold", "italic", "underline", "strike"] as const) {
      const runs: RunSpec[] = [{ text: "형식", [key]: true }];
      const out = roundTrip(runs);
      expect(out.length).toBe(1);
      expect(!!out[0][key], `${key} survives round-trip`).toBe(true);
      expect(runsUnchanged(out, runs)).toBe(true);
    }
  });

  it("a PARTIALLY-bold paragraph keeps distinct runs (부분 서식 — the whole point of 040)", () => {
    const runs: RunSpec[] = [{ text: "보통" }, { text: "굵게", bold: true }, { text: "다시보통" }];
    const out = roundTrip(runs);
    // The bold middle stays its own run; the neighbours stay unbold and untouched.
    const bold = out.filter((r) => r.bold);
    expect(bold.map((r) => r.text)).toEqual(["굵게"]);
    expect(out.filter((r) => !r.bold).map((r) => r.text).join("")).toBe("보통다시보통");
    expect(runsUnchanged(out, runs)).toBe(true);
  });

  it("size + color round-trip on the styled run", () => {
    const runs: RunSpec[] = [{ text: "빨강14", size_pt: 14, color: "#ff0000" }];
    const out = roundTrip(runs);
    expect(out[0].size_pt).toBeCloseTo(14, 5);
    expect(out[0].color).toBe("#ff0000");
    expect(runsUnchanged(out, runs)).toBe(true);
  });

  it("adjacent same-style segments MERGE back into one run", () => {
    // Rendered as two separate <span>s but identical style → serialize merges them.
    const el = document.createElement("div");
    el.style.color = "#000";
    el.innerHTML = `<div><span style="font-weight:700">가</span><span style="font-weight:700">나</span></div>`;
    document.body.appendChild(el);
    const out = serializeEditor(el, SCALE);
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ text: "가나", bold: true });
  });
});

describe("richedit #000 rule (교훈 1) — untouched black serializes color-less", () => {
  it("exact rgb(0,0,0) text yields NO color field → a re-commit is a no-op", () => {
    const el = document.createElement("div");
    el.innerHTML = `<div><span style="color:rgb(0,0,0)">검정</span></div>`;
    document.body.appendChild(el);
    const out = serializeEditor(el, SCALE);
    expect(out[0].color).toBeUndefined();
    expect(runsUnchanged(out, [{ text: "검정" }])).toBe(true);
  });
});

describe("richedit multi-paragraph (교훈 2) — split on \\n, structure preserved", () => {
  it("a 2-paragraph cell (join run) round-trips, no spurious change", () => {
    const runs: RunSpec[] = [{ text: "첫줄" }, { text: "\n" }, { text: "둘째줄" }];
    const out = roundTrip(runs);
    expect(runsText(out)).toBe("첫줄\n둘째줄");
    expect(runsUnchanged(out, runs)).toBe(true);
  });

  it("paragraphs with DIFFERENT styles keep their own style across the break", () => {
    const runs: RunSpec[] = [{ text: "굵은문단", bold: true }, { text: "\n" }, { text: "보통문단" }];
    const out = roundTrip(runs);
    // canon form: the bold para carries the trailing \n, then the plain para. (Each run also carries the
    // rendered DEFAULT_PT size, which eqStyle treats as the inherit default → still a no-op vs the input.)
    const canon = canonRuns(out);
    expect(canon).toHaveLength(2);
    expect(canon[0]).toMatchObject({ text: "굵은문단\n", bold: true });
    expect(canon[1].text).toBe("보통문단");
    expect(canon[1].bold).toBeFalsy();
    expect(runsUnchanged(out, runs)).toBe(true);
  });

  it("embedded-\\n runs (post-commit snapshot shape) canon-equal the join-run shape", () => {
    const joinShape: RunSpec[] = [{ text: "a" }, { text: "\n" }, { text: "b" }];
    const embeddedShape: RunSpec[] = [{ text: "a\nb" }];
    expect(canonRuns(joinShape)).toEqual(canonRuns(embeddedShape));
    expect(runsUnchanged(embeddedShape, joinShape)).toBe(true);
  });
});

describe("richedit no-op judgment (미접촉 셀 재커밋 = no-op)", () => {
  it("empty cell round-trips to one empty run, unchanged", () => {
    expect(roundTrip([])).toEqual([{ text: "" }]);
    expect(runsUnchanged(roundTrip([]), [])).toBe(true);
    expect(runsUnchanged(roundTrip([{ text: "" }]), [{ text: "" }])).toBe(true);
  });

  it("an inherited-size run (size unset) is NOT a spurious size-pinning change", () => {
    // runsToHtml draws an unset size at DEFAULT_PT; styleOf reads it back as 10pt. eqStyle treats unset and
    // 10 as equal, so opening + leaving an inherited-size run is a no-op (no size write).
    const runs: RunSpec[] = [{ text: "기본크기", bold: true }];
    expect(runsUnchanged(roundTrip(runs), runs)).toBe(true);
  });

  it("a REAL edit is detected as changed (guards against a false no-op)", () => {
    const before: RunSpec[] = [{ text: "원본" }];
    const after: RunSpec[] = [{ text: "원본", bold: true }];
    expect(runsUnchanged(after, before)).toBe(false);
    expect(runsEqual(canonRuns(after), canonRuns(before))).toBe(false);
  });
});

describe("richedit serialize structural boundaries", () => {
  it("a <br> with following content → intra-paragraph newline; a trailing filler <br> is ignored", () => {
    const el = document.createElement("div");
    el.innerHTML = `<div><span>가</span><br><span>나</span></div>`;
    document.body.appendChild(el);
    expect(runsText(serializeEditor(el, SCALE))).toBe("가\n나");

    const el2 = document.createElement("div");
    el2.innerHTML = `<div><span>끝</span><br></div>`; // trailing filler br
    document.body.appendChild(el2);
    expect(runsText(serializeEditor(el2, SCALE))).toBe("끝");
  });

  it("&nbsp; decodes to a regular space", () => {
    const el = document.createElement("div");
    el.innerHTML = `<div><span>가&nbsp;나</span></div>`;
    document.body.appendChild(el);
    expect(runsText(serializeEditor(el, SCALE))).toBe("가 나");
  });
});
