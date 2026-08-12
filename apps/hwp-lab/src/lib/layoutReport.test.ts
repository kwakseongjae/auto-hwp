import { describe, expect, it } from "vitest";
import { layoutReportBody, layoutReportFormat, layoutReportUrl } from "./layoutReport";

describe("layout report privacy boundary", () => {
  it("파일명은 버리고 공개 가능한 형식만 남긴다", () => {
    expect(layoutReportFormat("주민번호-비밀-계약서.HWP")).toBe(".hwp");
    expect(layoutReportFormat("인사명단.hwpx")).toBe(".hwpx");
    expect(layoutReportFormat("private.pdf")).toBe("확인 필요");
  });

  it("제보 초안에는 문서 식별자나 콘텐츠가 들어갈 입력면이 없다", () => {
    const url = new URL(layoutReportUrl(layoutReportFormat("김철수-주민번호.hwpx")));
    const body = url.searchParams.get("body") ?? "";
    expect(body).toContain(".hwpx");
    expect(body).toContain("오토한글(auto-hwp)");
    expect(body).toContain("공개 이슈 내용은 GitHub에 저장됩니다");
    expect(url.toString()).not.toContain("김철수");
    expect(url.toString()).not.toContain("주민번호.hwpx");
  });

  it("본문은 민감 문서 첨부 금지와 사람이 채울 비교 항목을 명시한다", () => {
    const body = layoutReportBody(".hwp");
    expect(body).toContain("한/글 또는 한컴독스");
    expect(body).toContain("파일명·본문·개인정보·비공개 문서");
    expect(body).toContain("문서 파일, 파일명, 본문, 해시가 자동으로 포함되지 않습니다");
  });
});
