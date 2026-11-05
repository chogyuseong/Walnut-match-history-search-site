/**
 * 자체 계정(아이디 + 비밀번호)의 조건. 서버와 화면이 같은 값을 쓴다. 조건을 바꾸려면 여기만 고친다.
 *
 * 아이디: 3~20자, 영문 소문자·숫자·밑줄(_). 대문자는 소문자로 바꿔 저장한다.
 *   - 입력은 먼저 유니코드 NFKC로 정규화한다. 전각 문자(ＡＢＣ, １２３)처럼 같은 글자로 보이는 다른 코드는
 *     보통 글자로 바뀌어 "보기에는 같은데 다른 아이디"가 생기지 않는다.
 *   - 한글 아이디는 받지 않는다. 한글은 NFKC를 해도 완성형 음절과 자모 조합(ㄱ+ㅏ), 호환 자모가 섞여 들어와
 *     같은 아이디를 두 가지로 만들 여지가 있고, 키릴·그리스 문자처럼 라틴과 똑같이 생긴 글자(혼동 문자)를
 *     막으려면 문자 종류 규칙을 더 둬야 한다. 아이디는 화면에 그리지 않고 로그인에만 쓰므로 영문·숫자로 충분하다.
 * 비밀번호: 8~128자(코드 포인트 수), 문자 종류 조합 규칙 없음. 아이디와 같은 비밀번호만 거절한다.
 *   - 앞뒤 공백도 비밀번호의 일부로 둔다. 운영체제마다 다른 한글 입력 방식(조합형·완성형)이 같은 값이 되도록
 *     NFC로 정규화한 뒤 해시한다.
 */
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
const USERNAME_PATTERN = /^[a-z0-9_]+$/;

/** 아이디를 저장·비교하는 모양으로 바꾼다(NFKC → 소문자). 조건 검사는 하지 않는다. */
export function normalizeUsername(raw: string): string {
  return raw.normalize("NFKC").toLowerCase();
}

/** 비밀번호를 해시하기 전 모양(NFC). */
export function normalizePassword(raw: string): string {
  return raw.normalize("NFC");
}

/** 아이디 조건을 어겼으면 이유(쉬운 말)를, 맞으면 null. 입력은 normalizeUsername을 거친 값. */
export function usernameProblem(username: string): string | null {
  if (username.length < USERNAME_MIN) return `아이디는 ${USERNAME_MIN}자 이상이어야 해요.`;
  if (username.length > USERNAME_MAX) return `아이디는 ${USERNAME_MAX}자까지예요.`;
  if (!USERNAME_PATTERN.test(username)) return "아이디에는 영문·숫자·밑줄(_)만 쓸 수 있어요.";
  return null;
}

/** 비밀번호 조건을 어겼으면 이유를, 맞으면 null. username은 정규화한 아이디. */
export function passwordProblem(password: string, username: string): string | null {
  const length = [...normalizePassword(password)].length;
  if (length < PASSWORD_MIN) return `비밀번호는 ${PASSWORD_MIN}자 이상이어야 해요.`;
  if (length > PASSWORD_MAX) return `비밀번호는 ${PASSWORD_MAX}자까지예요.`;
  if (username !== "" && normalizeUsername(password) === username) return "아이디와 같은 비밀번호는 쓸 수 없어요.";
  return null;
}

/** 칸 아래에 미리 보여주는 조건 한 줄. */
export const USERNAME_RULE = `${USERNAME_MIN}~${USERNAME_MAX}자, 영문·숫자·밑줄(_)`;
export const PASSWORD_RULE = `${PASSWORD_MIN}자 이상, 아이디와 다르게`;

/** 복구 코드: 20바이트(160비트) 무작위 값을 Crockford base32 32자로 적고 4자씩 끊어 보여준다. */
export const RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 사용자가 적은 복구 코드를 비교하는 모양으로 바꾼다(대문자, 공백·붙임표 제거, 헷갈리는 글자 통일). */
export function normalizeRecoveryCode(raw: string): string {
  return raw
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}
