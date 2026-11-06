/**
 * 오류 기록에 넣기 전에 개인정보·권한 값을 가리는 함수들(migrations/0018). 화면과 서버가 같이 쓴다.
 * 서버는 화면이 보낸 값을 믿지 않고 한 번 더 가린다.
 *
 * 가리는 것:
 * - 경로의 토큰(조회·참가 신청·인수·공동 운영자 초대 링크)과 ID(모임·경기·참가자·시즌 등). 낱말로 된 화면 이름만 남긴다.
 * - 메시지·스택 속 주소: 쿼리(?…)는 통째로, 경로·# 뒤는 위 규칙으로.
 * - 주소가 아니어도 UUID, 긴 토큰처럼 보이는 문자열, 이메일, "token=…" 같은 값.
 */

/** 메시지·스택·경로 길이 상한(글자). */
export const ERROR_MESSAGE_MAX = 500;
export const ERROR_STACK_MAX = 2000;
export const ERROR_PATH_MAX = 200;

/** 이 낱말 바로 뒤 칸은 그 자체로 권한(토큰)이다. */
const TOKEN_AFTER = new Set(["v", "view", "join", "transfer", "co-invite", "claim"]);

/** 화면·API 경로의 한 칸을 남겨도 되는지: 소문자 낱말(화면 이름), 짧은 숫자(경기 번호·연도), 스크립트 파일 이름만. */
function keepSegment(segment: string): boolean {
  return (
    /^[a-z][a-z-]{0,23}$/.test(segment) ||
    /^\d{1,5}$/.test(segment) ||
    /^[A-Za-z0-9_.-]{1,60}\.(m?js|css|html|tsx?)$/.test(segment)
  );
}

/**
 * 경로(/api/... 또는 #/...)의 토큰·ID 칸을 가린다. 쿼리와 # 뒤도 함께 다룬다.
 * 예: "/api/view/AbC9xyz/..." → "/api/view/[token]/...", "#/p/2f1c…" → "#/p/[id]".
 */
export function scrubPath(path: string): string {
  let rest = path;
  let hash = "";
  const hashAt = rest.indexOf("#");
  if (hashAt >= 0) {
    hash = rest.slice(hashAt + 1);
    rest = rest.slice(0, hashAt);
  }
  const queryAt = rest.indexOf("?");
  const query = queryAt >= 0 ? "?[가림]" : "";
  if (queryAt >= 0) rest = rest.slice(0, queryAt);
  const scrubSegments = (text: string) => {
    const parts = text.split("/");
    return parts
      .map((part, i) => {
        if (part === "") return part;
        if (i > 0 && TOKEN_AFTER.has(parts[i - 1]!)) return "[token]";
        return keepSegment(part) ? part : "[id]";
      })
      .join("/");
  };
  const scrubbed = scrubSegments(rest) + query + (hashAt >= 0 ? `#${scrubSegments(hash.split("?")[0]!)}` : "");
  return scrubbed.slice(0, ERROR_PATH_MAX);
}

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>()]+/g;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
/** 이름=값 꼴의 비밀값. */
const SECRET_PAIR = /\b(token|password|passwd|pw|secret|cookie|sid|session|key|auth)(\s*[=:]\s*)("?)[^\s"&,;]+/gi;
/** 토큰처럼 보이는 긴 문자열(영문 대소문자·숫자가 섞인 20자 이상). 파일 이름의 짧은 해시(8자 안팎)는 남는다. */
const LONG_TOKEN = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g;

/** 자유 글(메시지·스택)을 가리고 자른다. */
export function scrubText(text: string, max: number): string {
  const scrubbed = text
    .replace(URL_PATTERN, (url) => {
      const match = /^(https?:\/\/[^/?#]+)(.*)$/.exec(url);
      if (!match) return "[주소]";
      // 스택의 "파일:줄:칸" 꼬리는 남긴다.
      const tail = /(:\d+){1,2}$/.exec(match[2]!)?.[0] ?? "";
      const path = tail ? match[2]!.slice(0, -tail.length) : match[2]!;
      return `${match[1]}${scrubPath(path)}${tail}`;
    })
    .replace(UUID_PATTERN, "[id]")
    .replace(EMAIL_PATTERN, "[email]")
    .replace(SECRET_PAIR, (_all, name: string, sep: string, quote: string) => `${name}${sep}${quote}[가림]`)
    .replace(LONG_TOKEN, "[token]");
  return scrubbed.length > max ? `${scrubbed.slice(0, max - 1)}…` : scrubbed;
}

/** User-Agent에서 브라우저 종류만 뽑는다(버전·기기 정보는 남기지 않는다). */
export function browserKind(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const ua = userAgent;
  const name = /SamsungBrowser\//.test(ua)
    ? "Samsung"
    : /KAKAOTALK/i.test(ua)
      ? "KakaoTalk"
      : /NAVER\(inapp/i.test(ua)
        ? "Naver"
        : /Edg\//.test(ua)
          ? "Edge"
          : /Firefox\//.test(ua)
            ? "Firefox"
            : /Chrome\/|CriOS\//.test(ua)
              ? "Chrome"
              : /Safari\//.test(ua)
                ? "Safari"
                : "기타";
  return /Mobile|Android|iPhone|iPad/.test(ua) ? `${name} 모바일` : name;
}

/**
 * 고칠 수 없는 잡음은 보내지 않는다(기록 한도를 차지하고 진짜 오류를 가린다).
 * - "Script error.": 다른 출처 스크립트(브라우저 확장·광고 등)의 오류. 브라우저가 내용을 숨겨 알 수 있는 것이 없다.
 * - ResizeObserver 경고: 브라우저가 한 프레임에 크기 변화를 다 전하지 못했다는 알림으로, 화면 동작에는 영향이 없다.
 */
export function isNoise(message: string, stack: string | null): boolean {
  if (/^Script error\.?$/i.test(message.trim()) && !stack) return true;
  return /ResizeObserver loop (limit exceeded|completed with undelivered notifications)/.test(message);
}
