// 문서 세션 URL — `/d/<불투명 키>`.
//
// 왜: 문서를 열면 주소창이 "/" 그대로라, 새로고침·즐겨찾기·주소 공유가 전부 "첫 화면"으로 떨어졌다.
// 여기서 더하는 것 하나: **지금 보고 있는 문서에 이름표(URL)를 붙인다.**
//
// 규칙(이 파일이 소유하는 계약):
//  ① URL 에는 **불투명 키만** 싣는다 — 파일명·문서 내용은 절대 주소로 새어 나가지 않는다.
//     키는 자동저장 세션 키(`${docName}::${openedAt}`)의 해시라 결정적이지만 되돌릴 수 없다.
//  ② 키 → 스냅샷 키 매핑은 **이 브라우저 안에만** 산다(localStorage). 그래서 같은 주소를 다른
//     기기/브라우저에서 열면 "여기서 열렸던 문서"라고 정직하게 말하고 홈으로 보낼 수 있다.
//  ③ 매핑은 **재개해도 그대로**다: 새로고침 재개는 새 세션 키를 만들지만(autosave.openSession),
//     URL 키는 유지하고 그 키가 가리키는 스냅샷 키만 갈아끼운다 → 주소는 문서를 닫을 때까지 안 변한다.
//
// 헤드리스(DOM 의존 无 — 저장소는 주입 가능): 판정/해시는 순수 함수, 저장소 접근은 얇은 시임.
// 화면(pushState·안내·홈 복귀)은 LabWorkspace 가 붙인다.

/** 문서 세션 URL 접두 — `/d/<키>`. */
export const DOC_URL_PREFIX = "/d/";
/** URL 키 → 스냅샷 키 매핑 저장 위치(localStorage). */
export const DOC_URL_MAP_KEY = "auto-hwp:doc-urls";
/** 매핑 보관 상한(최근 순). 스냅샷 자체는 autosave 가 별도로 정리하므로 여기는 이름표만 센다. */
export const DOC_URL_MAP_MAX = 24;

/** localStorage 시임(테스트 주입용 — vitest 는 node 환경이라 실제 localStorage 가 없다). */
export interface DocUrlStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 브라우저 기본 저장소. 시크릿/차단 브라우저는 **접근 자체가 throw** 하므로 통째로 감싼다.
 *  없으면 null → URL 기능만 조용히 꺼지고(주소는 "/" 유지) 기존 재개/배너 경로는 그대로 동작한다. */
export function defaultDocUrlStorage(): DocUrlStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** 32비트 FNV-1a 두 벌(정방향·역방향)을 이어 붙인 12자 base36 해시. 되돌릴 수 없고, 같은 세션 키에
 *  대해서는 항상 같은 값이다(재개·재렌더에서 주소가 흔들리지 않는다). 암호학적 용도 아님 —
 *  "짧고 불투명한 이름표"가 전부다. */
export function shortDocKey(sessionKey: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < sessionKey.length; i++) {
    h ^= sessionKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let g = 0x84222325;
  for (let i = sessionKey.length - 1; i >= 0; i--) {
    g ^= sessionKey.charCodeAt(i) + i;
    g = Math.imul(g, 0x000001b3) >>> 0;
  }
  const enc = (n: number) => n.toString(36).padStart(6, "0").slice(-6);
  return enc(h) + enc(g);
}

/** 주소 → URL 키. basePath(프로젝트 페이지 배포) 아래도 같은 규칙. 아니면 null. */
export function parseDocUrl(pathname: string, basePath = ""): string | null {
  let p = pathname;
  if (basePath && p.startsWith(basePath)) p = p.slice(basePath.length);
  if (!p.startsWith(DOC_URL_PREFIX)) return null;
  const rest = p.slice(DOC_URL_PREFIX.length).replace(/\/$/, "");
  return /^[A-Za-z0-9_-]{1,64}$/.test(rest) ? rest : null;
}

/** URL 키 → 주소 문자열. */
export function docUrlPath(urlKey: string, basePath = ""): string {
  return `${basePath}${DOC_URL_PREFIX}${urlKey}`;
}

/** 홈 주소(문서를 닫으면 여기로 되돌린다). */
export function homePath(basePath = ""): string {
  return `${basePath}/`;
}

type Entry = [urlKey: string, snapshotKey: string];

/** 저장된 매핑(최근이 뒤). 형식이 깨졌으면 빈 목록 — 앱을 막지 않는다. */
export function readDocUrlMap(storage: DocUrlStorage | null = defaultDocUrlStorage()): Entry[] {
  try {
    const raw = storage?.getItem(DOC_URL_MAP_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is Entry => Array.isArray(e) && e.length === 2 && typeof e[0] === "string" && typeof e[1] === "string",
    );
  } catch {
    return [];
  }
}

/** 매핑 갱신(순수): 같은 URL 키는 갱신, 없으면 추가, 상한 초과분은 오래된 순으로 버린다. */
export function withDocUrl(entries: Entry[], urlKey: string, snapshotKey: string, max = DOC_URL_MAP_MAX): Entry[] {
  const next = entries.filter(([k]) => k !== urlKey);
  next.push([urlKey, snapshotKey]);
  return next.slice(Math.max(0, next.length - max));
}

/** 이 URL 키가 가리키는 스냅샷 키를 기억한다(재개로 세션 키가 바뀌어도 URL 키는 그대로 산다). */
export function rememberDocUrl(
  urlKey: string,
  snapshotKey: string,
  storage: DocUrlStorage | null = defaultDocUrlStorage(),
): void {
  try {
    storage?.setItem(DOC_URL_MAP_KEY, JSON.stringify(withDocUrl(readDocUrlMap(storage), urlKey, snapshotKey)));
  } catch {
    /* 용량/권한 거부 — 주소만 못 되살릴 뿐 자동저장·재개 마커는 계속 동작한다. */
  }
}

/** URL 키 → 스냅샷 키(이 브라우저에 기록이 없으면 null = "여기서 열린 문서가 아니다"). */
export function lookupDocUrl(urlKey: string, storage: DocUrlStorage | null = defaultDocUrlStorage()): string | null {
  const hit = readDocUrlMap(storage).find(([k]) => k === urlKey);
  return hit ? hit[1] : null;
}

/** 이 주소로는 아무것도 되살릴 수 없을 때의 안내 — 추측하지 않고 사실만 말한다. */
export const DOC_URL_MISSING_MESSAGE =
  "이 주소의 문서는 이 브라우저에서 열렸던 문서입니다 — 다른 기기·브라우저이거나 저장 기록이 지워졌습니다. 파일을 다시 열어 주세요.";
