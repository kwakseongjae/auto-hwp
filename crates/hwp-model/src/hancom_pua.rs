//! 한컴 Supplementary PUA-A 심볼 → 유니코드 표준 문자 변환 (이슈 245).
//!
//! ## 본질
//!
//! 정부 배포 양식은 섹션 번호·구분점·괘선에 **한컴 자체 PUA 문자**를 즐겨 쓴다. 옛한글
//! (`hwp_typeset::old_hangul`)이 BMP PUA(U+E000~F8FF)를 쓰는 것과 달리, 이쪽은 **평면 15
//! Supplementary PUA-A**(U+F0000~U+FFFFD)에 산다. 그래서 기존 `subst_glyph` 게이트
//! (`0xE000..=0xF8FF`)에 **원천적으로 걸리지 않았다**.
//!
//! 글리프를 가진 폰트는 함초롬 계열뿐인데 재배포가 금지돼 있어(`docs/LICENSE-POLICY.md` R8)
//! 임베드할 수 없다. 그 결과:
//!
//! - `export-html` — 코드포인트는 보존되지만 어느 폰트에도 글리프가 없어 두부(`□`)로 보인다
//! - `export-pdf`  — notdef 라 **조용히 사라진다**. 자리(어드밴스)만 남고 아무것도 안 그려진다
//!
//! 섹션 번호가 빠지면 목차 대조가 흐려지고, 구분점이 빠지면 "제품·서비스"가 "제품 서비스"로
//! **의미가 바뀐다**(이슈 245 실측). 본 모듈은 이 코드포인트들을 **유니코드 표준 문자**로
//! 바꿔 어느 OFL 폰트에서나 그려지고 PDF 텍스트에도 남게 한다.
//!
//! ## 매핑 표 출처 / 라이선스
//!
//! 데이터 원본: vendored **`external/rhwp`(MIT)** 의
//! `src/renderer/layout/paragraph_layout.rs::map_pua_bullet_char` 및 그 문서 주석.
//! 각 매핑은 rhwp 쪽에서 **한컴 PDF 정답지와의 시각 검증**으로 확정된 것이다
//! (원문자 영역 Task #509 · 저영역 글리프 외곽 분석 Task #588).
//! `old_hangul`(KTUG Public Domain)과 같은 승격 패턴이며, 코드 로직이 아니라 **데이터**를 옮긴다.
//!
//! rhwp 원본에서 **잠정**(`시각 판정 후 정정/조정`)으로 표시된 항목(U+F00DA·U+F0827)은
//! 의도적으로 제외했다 — 추측을 출력에 실어 보내지 않는다.
//!
//! ## 왜 rhwp 는 원문자를 매핑하지 않는데 우리는 하는가
//!
//! rhwp 는 U+F02B1~F02C4 를 raw PUA 로 통과시킨다. 그쪽 렌더러는 **함초롬바탕으로 폴백**할 수
//! 있어서, 통과시키면 한컴 원본과 같은 *사각 안 숫자* 글리프가 나오기 때문이다(캡스톤 F-1).
//! 우리는 R8 때문에 함초롬이 없다 — 통과시키면 두부이거나 소실이다. 그래서 **테두리 모양
//! (사각)을 잃더라도 번호의 의미를 지키는** 쪽을 택한다. 유니코드에는 사각 안 숫자 계열이
//! 없으므로 원문자(①~⑳)가 표준상 가장 가까운 대응이다. 이는 옛한글이 함초롬 PUA 글리프를
//! 포기하고 표준 자모 시퀀스를 택한 것과 같은 거래다.

/// 한컴 원문자 PUA 시작 — U+F02B1 이 "1", 이후 20개가 연속이다(①~⑳ = U+2460~U+2473).
const ENCLOSED_NUMBER_START: u32 = 0xF02B1;
const ENCLOSED_NUMBER_COUNT: u32 = 20;
/// ① CIRCLED DIGIT ONE.
const CIRCLED_ONE: u32 = 0x2460;

/// 연속 구간이 아닌 낱개 매핑. (PUA, 대체 문자) — 코드포인트 오름차순, 이진 검색.
static HANCOM_SYMBOL_PUA: &[(u32, char)] = &[
    (0xF003B, '\u{2193}'), // ↓ DOWNWARDS ARROW — 요약형 문항 화살표
    (0xF02EF, '\u{00B7}'), // · MIDDLE DOT — "제품·서비스" 구분점
    (0xF080F, '\u{2501}'), // ━ BOX DRAWINGS HEAVY HORIZONTAL — 머리말/꼬리말 굵은 가로선
    (0xF0811, '\u{250C}'), // ┌ BOX DRAWINGS LIGHT DOWN AND RIGHT
    (0xF0817, '\u{2514}'), // └ BOX DRAWINGS LIGHT UP AND RIGHT
    (0xF081A, '\u{2500}'), // ─ BOX DRAWINGS LIGHT HORIZONTAL
    (0xF0854, '\u{300A}'), // 《 LEFT DOUBLE ANGLE BRACKET — 책괄호
    (0xF0855, '\u{300B}'), // 》 RIGHT DOUBLE ANGLE BRACKET
];

/// 평면 15 Supplementary PUA-A 인지 — 표 검색 전 값싼 범위 게이트.
#[inline]
pub fn is_supplementary_pua(ch: char) -> bool {
    matches!(ch as u32, 0xF0000..=0xFFFFD)
}

/// 한컴 심볼 PUA 의 표준 유니코드 대응, 없으면 `None`.
pub fn map_hancom_symbol_pua(ch: char) -> Option<char> {
    let code = ch as u32;
    if !is_supplementary_pua(ch) {
        return None;
    }
    if (ENCLOSED_NUMBER_START..ENCLOSED_NUMBER_START + ENCLOSED_NUMBER_COUNT).contains(&code) {
        return char::from_u32(CIRCLED_ONE + (code - ENCLOSED_NUMBER_START));
    }
    HANCOM_SYMBOL_PUA
        .binary_search_by_key(&code, |(pua, _)| *pua)
        .ok()
        .map(|i| HANCOM_SYMBOL_PUA[i].1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_is_sorted_for_binary_search() {
        assert!(HANCOM_SYMBOL_PUA.windows(2).all(|w| w[0].0 < w[1].0));
    }

    #[test]
    fn enclosed_numbers_span_one_to_twenty() {
        assert_eq!(map_hancom_symbol_pua('\u{F02B1}'), Some('\u{2460}')); // ①
        assert_eq!(map_hancom_symbol_pua('\u{F02B4}'), Some('\u{2463}')); // ④
        assert_eq!(map_hancom_symbol_pua('\u{F02C4}'), Some('\u{2473}')); // ⑳
                                                                          // 구간 밖은 표에 없으면 매핑되지 않는다.
        assert_eq!(map_hancom_symbol_pua('\u{F02B0}'), None);
        assert_eq!(map_hancom_symbol_pua('\u{F02C5}'), None);
    }

    #[test]
    fn middle_dot_is_not_a_star() {
        // rhwp 가 한컴 PDF 시각 검증으로 ★(U+2605) 에서 정정한 항목이다.
        assert_eq!(map_hancom_symbol_pua('\u{F02EF}'), Some('\u{00B7}'));
    }

    #[test]
    fn bmp_pua_and_ordinary_text_are_untouched() {
        assert_eq!(
            map_hancom_symbol_pua('\u{E1A7}'),
            None,
            "BMP 옛한글은 old_hangul 몫"
        );
        assert_eq!(map_hancom_symbol_pua('가'), None);
        assert_eq!(map_hancom_symbol_pua('A'), None);
    }
}
