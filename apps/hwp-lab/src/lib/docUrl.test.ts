// 문서 세션 URL(/d/<키>) — 해시·주소 파싱·매핑 저장(순수 로직) 단위 테스트.
// 화면(pushState·재개·안내 후 홈)은 e2e(doc-url.spec.ts)가 실브라우저로 검증한다.
import { describe, expect, it } from "vitest";
import {
  DOC_URL_MAP_KEY,
  DOC_URL_MAP_MAX,
  docUrlPath,
  homePath,
  lookupDocUrl,
  parseDocUrl,
  readDocUrlMap,
  rememberDocUrl,
  shortDocKey,
  withDocUrl,
  type DocUrlStorage,
} from "./docUrl";

function fakeStorage(): DocUrlStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe("shortDocKey", () => {
  it("결정적이고 짧다 — 같은 세션 키는 항상 같은 주소가 된다", () => {
    const key = "보고서.hwp::1754400000000";
    expect(shortDocKey(key)).toBe(shortDocKey(key));
    expect(shortDocKey(key)).toMatch(/^[a-z0-9]{12}$/);
  });

  it("파일명·내용을 주소로 흘리지 않는다(불투명)", () => {
    const k = shortDocKey("2026년_인사평가_홍길동.hwp::1754400000000");
    expect(k).not.toContain("hwp");
    expect(k).not.toContain("홍길동");
    expect(k).not.toContain("인사");
  });

  it("세션이 다르면 키도 다르다(문서명 1글자·열기 시각 1ms 차이 포함)", () => {
    const keys = new Set([
      shortDocKey("a.hwp::1"),
      shortDocKey("b.hwp::1"),
      shortDocKey("a.hwp::2"),
      shortDocKey("a.hwpx::1"),
      shortDocKey("a.hwp::1754400000000"),
      shortDocKey("a.hwp::1754400000001"),
    ]);
    expect(keys.size).toBe(6);
  });
});

describe("주소 파싱/조립", () => {
  it("/d/<키> 만 인정한다(홈·다른 라우트·이상한 키는 null)", () => {
    expect(parseDocUrl("/d/abc123def456")).toBe("abc123def456");
    expect(parseDocUrl("/d/abc123def456/")).toBe("abc123def456"); // trailingSlash 배포 대비
    expect(parseDocUrl("/")).toBeNull();
    expect(parseDocUrl("/bulk")).toBeNull();
    expect(parseDocUrl("/docs/embed")).toBeNull();
    expect(parseDocUrl("/d/")).toBeNull();
    expect(parseDocUrl("/d/../../etc/passwd")).toBeNull();
    expect(parseDocUrl("/d/a b")).toBeNull();
  });

  it("basePath(프로젝트 페이지) 아래에서도 같은 규칙", () => {
    expect(parseDocUrl("/auto-hwp/d/abc123def456", "/auto-hwp")).toBe("abc123def456");
    expect(parseDocUrl("/auto-hwp/", "/auto-hwp")).toBeNull();
    expect(docUrlPath("abc", "/auto-hwp")).toBe("/auto-hwp/d/abc");
    expect(homePath("/auto-hwp")).toBe("/auto-hwp/");
    expect(docUrlPath("abc")).toBe("/d/abc");
    expect(homePath()).toBe("/");
  });

  it("조립 → 파싱 왕복", () => {
    const k = shortDocKey("문서.hwp::1");
    expect(parseDocUrl(docUrlPath(k))).toBe(k);
    expect(parseDocUrl(docUrlPath(k, "/auto-hwp"), "/auto-hwp")).toBe(k);
  });
});

describe("URL 키 → 스냅샷 키 매핑", () => {
  it("기억 → 조회 · 없는 키는 null", () => {
    const s = fakeStorage();
    expect(lookupDocUrl("nope", s)).toBeNull();
    rememberDocUrl("u1", "a.hwp::1", s);
    expect(lookupDocUrl("u1", s)).toBe("a.hwp::1");
  });

  it("같은 URL 키는 갱신된다 — 재개로 세션 키가 바뀌어도 주소는 그대로", () => {
    const s = fakeStorage();
    rememberDocUrl("u1", "a.hwp::1", s);
    rememberDocUrl("u1", "a.hwp::2", s);
    expect(readDocUrlMap(s)).toHaveLength(1);
    expect(lookupDocUrl("u1", s)).toBe("a.hwp::2");
  });

  it("상한을 넘으면 오래된 것부터 버린다", () => {
    let entries: [string, string][] = [];
    for (let i = 0; i < DOC_URL_MAP_MAX + 5; i++) entries = withDocUrl(entries, `u${i}`, `k${i}`);
    expect(entries).toHaveLength(DOC_URL_MAP_MAX);
    expect(entries[0][0]).toBe("u5");
    expect(entries[entries.length - 1][0]).toBe(`u${DOC_URL_MAP_MAX + 4}`);
  });

  it("깨진 저장값·저장소 없음은 조용히 빈 목록(앱을 막지 않는다)", () => {
    const s = fakeStorage();
    s.map.set(DOC_URL_MAP_KEY, "{{{not json");
    expect(readDocUrlMap(s)).toEqual([]);
    s.map.set(DOC_URL_MAP_KEY, JSON.stringify([1, "x", ["only-one"]]));
    expect(readDocUrlMap(s)).toEqual([]);
    expect(readDocUrlMap(null)).toEqual([]);
    expect(lookupDocUrl("u1", null)).toBeNull();
    expect(() => rememberDocUrl("u1", "k", null)).not.toThrow();
  });

  it("저장소가 throw 해도(시크릿 모드) 삼킨다", () => {
    const boom: DocUrlStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {},
    };
    expect(readDocUrlMap(boom)).toEqual([]);
    expect(() => rememberDocUrl("u1", "k", boom)).not.toThrow();
    expect(lookupDocUrl("u1", boom)).toBeNull();
  });
});
