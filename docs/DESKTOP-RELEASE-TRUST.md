# 데스크톱 릴리스 신뢰 계약

> 공개 이슈 #149 · 상위 #144. 이 문서는 서명이 완료됐다는 선언이 아니라, 서명 전에 반드시
> 통과해야 하는 비밀정보 없는 기반 계약이다.

## 현재 지원 주장

- 릴리스 후보 메타데이터의 첫 허용 대상은 `macos-universal`과 `windows-x86_64`다.
- Linux 설치본은 네이티브 클린머신 QA·패키지 형식·서명 정책이 정해질 때까지 **지원한다고
  주장하지 않는다**. Windows arm64도 네이티브 CI/QA 전에는 허용하지 않는다.
- 현재 `tauri.conf.json`의 `signingIdentity: "-"`는 로컬 Apple Silicon 실행을 위한 ad-hoc
  서명일 뿐이다. Developer ID 서명·공증·staple이나 GA 배포 증거가 아니다.

## 비밀정보 없는 프리플라이트

`scripts/desktop-release-manifest.mjs`는 다음을 fail-closed로 강제한다.

1. 요청 SHA는 소문자 40자리 Git SHA이며 별도로 조회한 현재 `origin/main` SHA와 같아야 한다.
2. 채널은 `preview`/`stable`만 허용한다. preview는 prerelease SemVer, stable은 정식 SemVer다.
3. 대상·플랫폼·아키텍처 조합은 고정 목록과 일치해야 하며 두 첫 대상이 모두 있어야 한다.
4. 산출물은 안전한 basename의 일반 파일이어야 한다. 빈 파일·심볼릭 링크·경로 탈출·중복·대상과
   맞지 않는 확장자를 거부한다.
5. 매니페스트는 바이트 길이와 SHA-256을 기록하며 검증 시 실파일과 다시 대조한다. unknown field는
   조용히 무시하지 않는다.

수동 `desktop-release-preflight` Actions는 읽기 권한만 갖고, 입력 SHA를 직접 checkout한 뒤 현재
원격 main과 다시 비교한다. 서명·업로드·Release 생성·비밀정보 접근은 의도적으로 할 수 없다.

## 자격증명 경계와 #144 잔여 게이트

- updater 공개키는 앱에 배포 가능하지만 개인키는 보호된 release environment에만 둔다. Tauri
  updater는 서명 검증을 끌 수 없으므로 공개키/엔드포인트/개인키 수명주기가 확정되기 전 플러그인을
  겉모양만 켜지 않는다.
- Apple Developer ID 인증서·App Store Connect 공증 자격증명, Windows Authenticode 또는 Azure
  Artifact Signing 권한은 저장소·로그·일반 Actions artifact에 넣지 않는다.
- #144는 Developer ID+hardened runtime+notarize/staple/Gatekeeper, Windows 서명 검증, updater의
  잘못된 서명·다운그레이드·잘못된 target 거부, SBOM/provenance, 중단 복구, 플랫폼별 설치 앱
  open/edit/save/PDF/print/relaunch/update 스모크가 실제로 끝날 때까지 열린다.

공식 기준: [Tauri updater](https://v2.tauri.app/plugin/updater/),
[macOS signing](https://v2.tauri.app/distribute/sign/macos/),
[Windows signing](https://v2.tauri.app/distribute/sign/windows/),
[GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).
