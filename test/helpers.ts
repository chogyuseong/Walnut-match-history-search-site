import { SELF } from "cloudflare:test";
import type { MatchView, ParticipantView, Position, RosterEntry, Snapshot } from "../src/shared/types";

export interface ApiResult<T = any> {
  status: number;
  body: T;
}

let counter = 0;
/** 테스트마다 겹치지 않는 값을 만든다. */
export function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export function requestId(): string {
  return unique("req");
}

export async function api<T = any>(
  cookie: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await SELF.fetch(`https://example.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

/** 가짜 로그인으로 세션 쿠키를 받는다. */
export async function login(subject = unique("user")): Promise<string> {
  const response = await SELF.fetch("https://example.test/api/auth/fake-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subject }),
  });
  const setCookie = response.headers.get("Set-Cookie") ?? "";
  return setCookie.split(";")[0]!;
}

export interface TestGroup {
  cookie: string;
  gid: string;
  people: ParticipantView[];
}

/** 운영자·모임·참가자(기본 12명)를 만든다. */
export async function setupGroup(count = 12): Promise<TestGroup> {
  const cookie = await login();
  const created = await api(cookie, "POST", "/api/groups", {});
  const gid = created.body.id as string;
  const names = Array.from({ length: count }, (_, i) => `참가자${i + 1}`);
  const ensured = await api(cookie, "POST", `/api/groups/${gid}/participants`, { names });
  return { cookie, gid, people: ensured.body.participants as ParticipantView[] };
}

const ORDER: Position[] = ["top", "jungle", "mid", "adc", "support"];

/** 앞 5명을 팀 A, 뒤 5명을 팀 B로 두고 탑~서포터 순으로 배정한다. */
export function rosterOf(people: ParticipantView[]): RosterEntry[] {
  return people.slice(0, 10).map((p, i) => ({
    participantId: p.id,
    team: i < 5 ? "A" : "B",
    position: ORDER[i % 5]!,
  }));
}

export async function snapshot(g: TestGroup): Promise<Snapshot> {
  return (await api<Snapshot>(g.cookie, "GET", `/api/groups/${g.gid}/snapshot`)).body;
}

export async function start(
  g: TestGroup,
  roster: RosterEntry[],
  extra: Record<string, unknown> = {},
): Promise<ApiResult<{ match: MatchView; error?: any }>> {
  const snap = await snapshot(g);
  return api(g.cookie, "POST", `/api/groups/${g.gid}/matches/start`, {
    requestId: requestId(),
    baseLiveVersion: snap.group.liveVersion,
    roster,
    ...extra,
  });
}

export async function matchAction(
  g: TestGroup,
  match: { id: string; version: number },
  action: string,
  extra: Record<string, unknown> = {},
): Promise<ApiResult<{ match: MatchView; error?: any }>> {
  return api(g.cookie, "POST", `/api/groups/${g.gid}/matches/${match.id}/${action}`, {
    requestId: requestId(),
    baseMatchVersion: match.version,
    ...extra,
  });
}

/** 시작하고 결과까지 확정한 경기를 만든다. */
export async function playConfirmed(
  g: TestGroup,
  roster: RosterEntry[],
  winnerTeam: "A" | "B" = "A",
  winnerSide: "blue" | "red" | "unknown" = "blue",
  extra: Record<string, unknown> = {},
): Promise<MatchView> {
  const started = await start(g, roster, extra);
  if (started.status !== 200) throw new Error(`시작 실패: ${JSON.stringify(started.body)}`);
  const confirmed = await matchAction(g, started.body.match, "result", { winnerTeam, winnerSide });
  if (confirmed.status !== 200) throw new Error(`확정 실패: ${JSON.stringify(confirmed.body)}`);
  return confirmed.body.match;
}

/** 저장 상태 전체를 비교하기 위한 요약. 실패한 요청이 아무것도 바꾸지 않았는지 볼 때 쓴다. */
export function fingerprint(snap: Snapshot): string {
  return JSON.stringify({
    liveVersion: snap.group.liveVersion,
    matches: snap.matches.map((m) => [m.id, m.version, m.state, m.winnerTeam, m.teamASide, m.roster]),
    rotation: snap.rotation,
    revisions: snap.revisions.length,
    participants: snap.participants,
  });
}
