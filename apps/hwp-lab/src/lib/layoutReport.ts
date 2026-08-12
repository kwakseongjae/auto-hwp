const REPO_ISSUES_NEW = "https://github.com/kwakseongjae/auto-hwp/issues/new";

export type LayoutReportFormat = ".hwp" | ".hwpx" | "확인 필요";

/** 파일명은 버리고 확장자만 남긴다. 제보 URL에 문서 식별자가 섞이지 않게 하는 프라이버시 경계다. */
export function layoutReportFormat(filename: string): LayoutReportFormat {
  if (/\.hwpx$/i.test(filename)) return ".hwpx";
  if (/\.hwp$/i.test(filename)) return ".hwp";
  return "확인 필요";
}

export function layoutReportBody(format: LayoutReportFormat): string {
  return `## 브라우저에서 본 차이

- 원본 형식: ${format}
- 오토한글(auto-hwp)에서 보이는 쪽수:
- 한/글 또는 한컴독스에서 보이는 쪽수:
- 처음 다르게 보이는 쪽:
- 차이 유형: 줄바꿈 / 표 / 글꼴 / 그림 / 머리말·꼬리말 / 기타

## 재현 단서

- 문서 내용이 아니라 구조만 적어 주세요(예: 다쪽 표, 중첩 표, 강제 쪽 나누기).
- 공개 양식이면 원본 출처 URL을 적어 주세요.

## 개인정보 확인

- [ ] 파일명·본문·개인정보·비공개 문서를 이 공개 이슈에 넣지 않았습니다.

> 이 초안에는 문서 파일, 파일명, 본문, 해시가 자동으로 포함되지 않습니다. 공개 이슈 내용은 GitHub에 저장됩니다.`;
}

/** GitHub에 보내는 값은 사용자가 확인할 수 있는 구조 정보뿐이다. 문서 바이트는 이 함수의 입력조차 아니다. */
export function layoutReportUrl(format: LayoutReportFormat): string {
  const query = new URLSearchParams({
    labels: "layout",
    title: `[조판] 브라우저 렌더 차이 (${format})`,
    body: layoutReportBody(format),
  });
  return `${REPO_ISSUES_NEW}?${query.toString()}`;
}
