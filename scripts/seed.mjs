// 로컬 서버에 합성 데이터를 넣는다(docs/P4 P4-2).
// 가짜 이름 30명과 경기 120개를 만든다. 실제 이름·전적은 쓰지 않는다.
// 사용법: 다른 창에서 `npm run dev`를 띄운 뒤 `npm run seed`
// 로컬 주소만 허용한다. 운영 주소에는 절대 쓰지 않는다.

const BASE = process.env.SEED_BASE ?? "http://127.0.0.1:8787";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(BASE)) {
  console.error(`로컬 주소가 아닙니다: ${BASE}`);
  process.exit(1);
}

const POSITIONS = ["top", "jungle", "mid", "adc", "support"];
const MATCHES = 120;
const PEOPLE = 30;

// 시드 고정 난수: 실행할 때마다 같은 데이터가 나온다.
let state = 20261105;
function random() {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

let cookie = "";
async function request(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status} ${JSON.stringify(json)}`);
  }
  return json;
}

const stamp = Date.now().toString(36);
await request("POST", "/api/auth/fake-login", { subject: "seed" });
const group = await request("POST", "/api/groups", { requestId: crypto.randomUUID(), name: `합성 모임 ${stamp.slice(-4)}` });
const names = Array.from({ length: PEOPLE }, (_, i) => `가상선수${String(i + 1).padStart(2, "0")}`);
const { participants } = await request("POST", `/api/groups/${group.id}/participants`, { requestId: crypto.randomUUID(), names });

// 실력 그룹: 앞에서부터 1~4를 고르게, 마지막 4명은 미지정.
for (const [index, person] of participants.entries()) {
  if (index >= PEOPLE - 4) continue;
  await request("PATCH", `/api/groups/${group.id}/participants/${person.id}`, {
    requestId: crypto.randomUUID(),
    skillGroup: (index % 4) + 1,
  });
}

// 경기: 앞쪽 사람일수록 자주 나오게 해서 배치 완료자와 배치 중인 사람이 섞이게 한다.
// 마지막 경기가 어제가 되도록 시작일을 잡는다(미래 날짜 경기가 생기지 않게). 시각은 한국 20시.
const DAY = 24 * 3600_000;
const start =
  Math.floor((Date.now() - DAY - (MATCHES - 1) * 26 * 3600_000) / DAY) * DAY + 11 * 3600_000;
const matches = Array.from({ length: MATCHES }, (_, index) => {
  const pool = index % 6 === 0 ? participants : participants.slice(0, 16);
  const ten = shuffle(pool).slice(0, 10);
  const winnerTeam = random() < 0.5 ? "A" : "B";
  const sideRoll = random();
  // 진영: 40% 블루, 40% 레드, 20% 미상.
  const winnerSide = sideRoll < 0.4 ? "blue" : sideRoll < 0.8 ? "red" : "unknown";
  return {
    playedAt: new Date(start + index * 26 * 3600_000).toISOString(),
    roster: ten.map((person, i) => ({
      participantId: person.id,
      team: i < 5 ? "A" : "B",
      // 20경기에 한 번은 포지션 기록이 없는 경기.
      position: index % 20 === 19 ? null : POSITIONS[i % 5],
    })),
    winnerTeam,
    winnerSide,
  };
});
const batchId = `seed-${stamp}-batch`;
for (let i = 0; i < matches.length; i += 50) {
  await request("POST", `/api/groups/${group.id}/matches/import`, {
    requestId: `seed-${stamp}-${i}`,
    batchId,
    matches: matches.slice(i, i + 50),
  });
}

await request("POST", `/api/groups/${group.id}/seasons`, {
  requestId: crypto.randomUUID(),
  name: "여름 시즌",
  startsOn: "2026-07-01",
  endsOn: "2026-08-31",
});
await request("POST", `/api/groups/${group.id}/seasons`, {
  requestId: crypto.randomUUID(),
  name: "가을 시즌",
  startsOn: "2026-09-01",
  endsOn: "2026-11-30",
});

const snapshot = await request("GET", `/api/groups/${group.id}/snapshot`);
console.log(`모임: ${snapshot.group.name}`);
console.log(`참가자 ${snapshot.participants.length}명, 경기 ${snapshot.matches.length}개, 시즌 ${snapshot.seasons.length}개`);
console.log(`운영자 화면: ${BASE}/  (개발용 로그인 계정 이름: seed)`);
console.log(`조회 링크: ${BASE}/#/v/${snapshot.group.viewToken}/records`);
