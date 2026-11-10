/**
 * 챔피언 목록과 이름 찾기(2026-11-10, migrations/0025). 서버의 저장 검사와 화면의 고르기·표시가 같은 목록을 쓴다.
 *
 * 새 챔피언이 나오면 CHAMPION_ROWS에 [키, 한글 이름] 한 줄을 더하면 끝이다(줄 순서는 상관없다. 화면은 한글 이름 순으로 보여 준다).
 * - 키는 Riot 데이터의 고정 식별자를 그대로 쓴다(예: "MonkeyKing"은 오공, "Nunu"는 누누와 윌럼프). DB에 이 키가 저장되므로
 *   한 번 넣은 키는 바꾸거나 지우지 않는다. 바꾸면 그 키로 저장된 예전 기록이 화면에 키 글자 그대로 보이고, 고쳐 저장할 때 거절된다.
 * - 셋째 칸부터는 검색용 별칭(줄임말·영어 이름)이다. 없으면 생략한다. 한글 이름 안에 이미 들어 있는 말(예: "문도")은 넣지 않아도 찾힌다.
 * 이미지는 쓰지 않는다(글자만). 외부 데이터(Data Dragon)도 받지 않는다.
 */

export interface Champion {
  key: string;
  name: string;
  aliases: readonly string[];
}

const CHAMPION_ROWS: readonly (readonly [string, string, ...string[]])[] = [
  ["Aatrox", "아트록스"],
  ["Ahri", "아리"],
  ["Akali", "아칼리"],
  ["Akshan", "아크샨"],
  ["Alistar", "알리스타"],
  ["Ambessa", "암베사"],
  ["Amumu", "아무무"],
  ["Anivia", "애니비아"],
  ["Annie", "애니"],
  ["Aphelios", "아펠리오스"],
  ["Ashe", "애쉬"],
  ["AurelionSol", "아우렐리온 솔", "아우솔"],
  ["Aurora", "오로라"],
  ["Azir", "아지르"],
  ["Bard", "바드"],
  ["Belveth", "벨베스"],
  ["Blitzcrank", "블리츠크랭크", "블츠"],
  ["Brand", "브랜드"],
  ["Braum", "브라움"],
  ["Briar", "브라이어"],
  ["Caitlyn", "케이틀린", "케틀"],
  ["Camille", "카밀"],
  ["Cassiopeia", "카시오페아"],
  ["Chogath", "초가스"],
  ["Corki", "코르키"],
  ["Darius", "다리우스"],
  ["Diana", "다이애나"],
  ["DrMundo", "문도 박사"],
  ["Draven", "드레이븐"],
  ["Ekko", "에코"],
  ["Elise", "엘리스"],
  ["Evelynn", "이블린"],
  ["Ezreal", "이즈리얼"],
  ["Fiddlesticks", "피들스틱"],
  ["Fiora", "피오라"],
  ["Fizz", "피즈"],
  ["Galio", "갈리오"],
  ["Gangplank", "갱플랭크"],
  ["Garen", "가렌"],
  ["Gnar", "나르"],
  ["Gragas", "그라가스"],
  ["Graves", "그레이브즈"],
  ["Gwen", "그웬"],
  ["Hecarim", "헤카림"],
  ["Heimerdinger", "하이머딩거", "하딩"],
  ["Hwei", "흐웨이"],
  ["Illaoi", "일라오이"],
  ["Irelia", "이렐리아"],
  ["Ivern", "아이번"],
  ["Janna", "잔나"],
  ["JarvanIV", "자르반 4세"],
  ["Jax", "잭스"],
  ["Jayce", "제이스"],
  ["Jhin", "진"],
  ["Jinx", "징크스"],
  ["KSante", "크산테"],
  ["Kaisa", "카이사"],
  ["Kalista", "칼리스타"],
  ["Karma", "카르마"],
  ["Karthus", "카서스"],
  ["Kassadin", "카사딘"],
  ["Katarina", "카타리나"],
  ["Kayle", "케일"],
  ["Kayn", "케인"],
  ["Kennen", "케넨"],
  ["Khazix", "카직스"],
  ["Kindred", "킨드레드"],
  ["Kled", "클레드"],
  ["KogMaw", "코그모"],
  ["Leblanc", "르블랑"],
  ["LeeSin", "리 신"],
  ["Leona", "레오나"],
  ["Lillia", "릴리아"],
  ["Lissandra", "리산드라"],
  ["Lucian", "루시안"],
  ["Lulu", "룰루"],
  ["Lux", "럭스"],
  ["Malphite", "말파이트"],
  ["Malzahar", "말자하"],
  ["Maokai", "마오카이"],
  ["MasterYi", "마스터 이", "마이"],
  ["Mel", "멜"],
  ["Milio", "밀리오"],
  ["MissFortune", "미스 포츈", "미포"],
  ["MonkeyKing", "오공", "wukong"],
  ["Mordekaiser", "모데카이저"],
  ["Morgana", "모르가나"],
  ["Naafiri", "나피리"],
  ["Nami", "나미"],
  ["Nasus", "나서스"],
  ["Nautilus", "노틸러스"],
  ["Neeko", "니코"],
  ["Nidalee", "니달리"],
  ["Nilah", "닐라"],
  ["Nocturne", "녹턴"],
  ["Nunu", "누누와 윌럼프"],
  ["Olaf", "올라프"],
  ["Orianna", "오리아나"],
  ["Ornn", "오른"],
  ["Pantheon", "판테온"],
  ["Poppy", "뽀삐"],
  ["Pyke", "파이크"],
  ["Qiyana", "키아나"],
  ["Quinn", "퀸"],
  ["Rakan", "라칸"],
  ["Rammus", "람머스"],
  ["RekSai", "렉사이"],
  ["Rell", "렐"],
  ["Renata", "레나타 글라스크"],
  ["Renekton", "레넥톤"],
  ["Rengar", "렝가"],
  ["Riven", "리븐"],
  ["Rumble", "럼블"],
  ["Ryze", "라이즈"],
  ["Samira", "사미라"],
  ["Sejuani", "세주아니"],
  ["Senna", "세나"],
  ["Seraphine", "세라핀"],
  ["Sett", "세트"],
  ["Shaco", "샤코"],
  ["Shen", "쉔"],
  ["Shyvana", "쉬바나"],
  ["Singed", "신지드"],
  ["Sion", "사이온"],
  ["Sivir", "시비르"],
  ["Skarner", "스카너"],
  ["Smolder", "스몰더"],
  ["Sona", "소나"],
  ["Soraka", "소라카"],
  ["Swain", "스웨인"],
  ["Sylas", "사일러스"],
  ["Syndra", "신드라"],
  ["TahmKench", "탐 켄치"],
  ["Taliyah", "탈리야"],
  ["Talon", "탈론"],
  ["Taric", "타릭"],
  ["Teemo", "티모"],
  ["Thresh", "쓰레쉬"],
  ["Tristana", "트리스타나"],
  ["Trundle", "트런들"],
  ["Tryndamere", "트린다미어"],
  ["TwistedFate", "트위스티드 페이트", "트페"],
  ["Twitch", "트위치"],
  ["Udyr", "우디르"],
  ["Urgot", "우르곳"],
  ["Varus", "바루스"],
  ["Vayne", "베인"],
  ["Veigar", "베이가"],
  ["Velkoz", "벨코즈"],
  ["Vex", "벡스"],
  ["Vi", "바이"],
  ["Viego", "비에고"],
  ["Viktor", "빅토르"],
  ["Vladimir", "블라디미르"],
  ["Volibear", "볼리베어"],
  ["Warwick", "워윅"],
  ["Xayah", "자야"],
  ["Xerath", "제라스"],
  ["XinZhao", "신 짜오"],
  ["Yasuo", "야스오"],
  ["Yone", "요네"],
  ["Yorick", "요릭"],
  ["Yunara", "유나라"],
  ["Yuumi", "유미"],
  ["Zac", "자크"],
  ["Zed", "제드"],
  ["Zeri", "제리"],
  ["Ziggs", "직스"],
  ["Zilean", "질리언"],
  ["Zoe", "조이"],
  ["Zyra", "자이라"],
];

/** 한글 이름 순(가나다). 고르기 목록의 기본 순서. */
export const CHAMPIONS: readonly Champion[] = CHAMPION_ROWS.map(([key, name, ...aliases]) => ({ key, name, aliases })).sort(
  (a, b) => a.name.localeCompare(b.name, "ko"),
);

const BY_KEY = new Map(CHAMPIONS.map((c) => [c.key, c]));

export function isChampionKey(value: unknown): value is string {
  return typeof value === "string" && BY_KEY.has(value);
}

/** 화면에 쓸 한글 이름. 목록에서 빠진 키는 키 글자 그대로 보여 준다. */
export function championName(key: string): string {
  return BY_KEY.get(key)?.name ?? key;
}

/* ------------------------------------------------------------------ */
/* 검색                                                                 */
/* ------------------------------------------------------------------ */

const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;
/** 첫소리 19개(호환 자모). 사용자가 "ㅇㄹ"처럼 자음만 치면 이 글자들이 들어온다. */
const INITIALS = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
/** 끝소리 28개(0번은 받침 없음). 겹받침(ㄳ 등)은 다음 글자의 첫소리로 넘길 수 없어 빈칸으로 둔다. */
const FINALS = ["", "ㄱ", "ㄲ", "", "ㄴ", "", "", "ㄷ", "ㄹ", "", "", "", "", "", "", "", "ㅁ", "ㅂ", "", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];

function isSyllable(code: number): boolean {
  return code >= HANGUL_FIRST && code <= HANGUL_LAST;
}

/** 검색어의 글자 하나가 이름의 글자 하나와 맞는지. 자음만 친 글자는 그 첫소리로 시작하는 모든 글자와 맞는다. */
function charMatches(q: string, c: string): boolean {
  if (q === c) return true;
  const code = c.charCodeAt(0);
  return INITIALS.includes(q) && isSyllable(code) && INITIALS[Math.floor((code - HANGUL_FIRST) / 588)] === q;
}

/** 검색어가 처음 맞는 자리(없으면 -1). */
function indexIn(text: string, query: string): number {
  for (let start = 0; start + query.length <= text.length; start++) {
    let i = 0;
    while (i < query.length && charMatches(query[i]!, text[start + i]!)) i++;
    if (i === query.length) return start;
  }
  return -1;
}

/** 찾기 비교용 꼴: 공백을 지우고 영문은 소문자로. */
function fold(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

/**
 * 한글 입력기는 "아리"를 치는 도중에 "알"을 보여 준다(ㄹ이 아직 받침 자리에 있다). 그 순간에 아리가 목록에서 사라졌다
 * 나타나지 않게, 마지막 글자의 받침을 떼어 다음 글자의 첫소리로 본 검색어("아ㄹ")도 함께 찾는다.
 */
function composingVariant(query: string): string | null {
  const last = query.charCodeAt(query.length - 1);
  if (!isSyllable(last)) return null;
  const finalIndex = (last - HANGUL_FIRST) % 28;
  const final = FINALS[finalIndex];
  if (!final) return null;
  return query.slice(0, -1) + String.fromCharCode(last - finalIndex) + final;
}

/** 0: 앞부분 일치, 1: 중간 일치, null: 안 맞음. 한글 이름·별칭·영문 키 중 가장 좋은 값. */
function matchRank(champion: Champion, queries: readonly string[]): 0 | 1 | null {
  let best: 0 | 1 | null = null;
  for (const text of [champion.name, ...champion.aliases, champion.key]) {
    const hay = fold(text);
    for (const q of queries) {
      const at = indexIn(hay, q);
      if (at === 0) return 0;
      if (at > 0) best = 1;
    }
  }
  return best;
}

export interface ChampionOption {
  champion: Champion;
  /** 같은 경기에서 다른 사람이 이미 고른 챔피언(막지는 않고 흐리게, 뒤로). */
  taken: boolean;
  /** 이 사람이 예전 경기에서 고른 횟수. */
  used: number;
}

/**
 * 고르기 목록. 순서: 다른 사람이 안 고른 것 먼저 → 앞부분 일치, 중간 일치 → 이 사람이 자주 쓴 순 → 가나다 순.
 * 검색어가 비면 전체 목록이고, 그 사람이 자주 쓴 챔피언이 맨 앞에 온다.
 */
export function searchChampions(
  query: string,
  options: { usage?: ReadonlyMap<string, number>; taken?: ReadonlySet<string> } = {},
): ChampionOption[] {
  const q = fold(query);
  const queries = q === "" ? [] : [q, composingVariant(q)].filter((v): v is string => v !== null);
  const found: { option: ChampionOption; rank: number; order: number }[] = [];
  CHAMPIONS.forEach((champion, order) => {
    const rank = q === "" ? 0 : matchRank(champion, queries);
    if (rank === null) return;
    const option = {
      champion,
      taken: options.taken?.has(champion.key) ?? false,
      used: options.usage?.get(champion.key) ?? 0,
    };
    found.push({ option, rank, order });
  });
  found.sort(
    (a, b) =>
      Number(a.option.taken) - Number(b.option.taken) ||
      a.rank - b.rank ||
      b.option.used - a.option.used ||
      a.order - b.order,
  );
  return found.map((f) => f.option);
}

/** 한 사람이 예전 확정 경기에서 고른 챔피언별 횟수. 고르기 목록의 "자주 쓴 순"에 쓴다. */
export function championUsage(
  matches: readonly { state: string; roster: readonly { participantId: string; champion?: string }[] }[],
  participantId: string,
): Map<string, number> {
  const usage = new Map<string, number>();
  for (const match of matches) {
    if (match.state !== "confirmed") continue;
    const key = match.roster.find((r) => r.participantId === participantId)?.champion;
    if (key) usage.set(key, (usage.get(key) ?? 0) + 1);
  }
  return usage;
}
