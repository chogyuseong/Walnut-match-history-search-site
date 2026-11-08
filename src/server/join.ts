/**
 * 참가 신청 링크(migrations/0014_join_requests.sql).
 *
 * - 모임당 링크 1개. 토큰은 해시만 저장한다. 다시 만들면 이전 링크는 바로 열리지 않는다(신청 목록은 그대로).
 * - 링크를 가진 사람은 로그인 없이 신청·취소한다. 익명 신청은 본인 확인이 없으므로 누구의 신청이든 넣고 뺄 수 있다.
 * - 본인 확인된 신청(migrations/0019): 자기 참가자와 연결한 계정(멤버)이 로그인한 채 자기 이름으로 신청하면 그 계정을 함께
 *   저장한다. 그 신청은 본인과 운영자만 뺄 수 있다(다른 사람은 403 JOIN_VERIFIED). 연결된 이름으로 다른 사람이
 *   익명 신청하는 것은 예전처럼 받는다(본인 확인 표시 없음). 그 뒤 본인이 신청하면 본인 확인 신청으로 바뀐다.
 * - 공개 응답에는 모임 이름, 열림 여부, 신청자 이름, 활성 참가자 이름만 넣는다.
 *   티어(skillGroup)·기피 라인·서포터 횟수·전적은 넣지 않는다(test/join.test.ts가 고정한다).
 * - 신청 최대 MAX_JOIN_ENTRIES명. 닫혀 있으면 신청·취소를 거절한다. 같은 사람은 한 번만.
 * - 새 이름 신청은 참가자를 만들지 않는다. 같은 이름(nameKey)의 활성 참가자가 있으면 그 사람으로 본다.
 * - 합쳐진 사람의 신청은 행을 옮기지 않고 보여줄 때 남은 사람 것으로 본다(중복이면 먼저 신청한 시각 하나로).
 * - 신청 목록은 경기를 시작해도 지우지 않는다(같은 날 여러 판). 운영자가 "신청 비우기"로 지운다.
 */
import { resolveMerged } from "../shared/merge";
import { nameKey } from "../shared/names";
import { memberParticipantId, newViewToken, operatorRole } from "./auth";
import type { Env } from "./env";
import { parseName } from "./groups";
import { ApiError, assertOnlyKeys, newId, nowIso, requireString } from "./http";
import { maintenanceError, runMutation, sha256Hex } from "./mutation";
import { etagMatches } from "./snapshot";

/** 한 모임의 신청 상한. */
export const MAX_JOIN_ENTRIES = 30;
/** 한 판 인원. 공개 화면의 "7 / 10명"과 고르기 화면의 "대기" 표시에 쓴다. */
export const JOIN_TARGET = 10;

type Body = Record<string, unknown>;

const JOIN_INVALID_MESSAGE = "이 신청 링크는 더 이상 열리지 않아요. 운영자에게 새 링크를 받아 주세요.";

function invalidLink(): ApiError {
  return new ApiError(404, "JOIN_INVALID", JOIN_INVALID_MESSAGE);
}

function closedError(): ApiError {
  return new ApiError(409, "JOIN_CLOSED", "지금은 신청을 받지 않아요. 운영자에게 확인해 주세요.");
}

function fullError(): ApiError {
  return new ApiError(409, "JOIN_FULL", `신청은 ${MAX_JOIN_ENTRIES}명까지예요. 운영자에게 확인해 주세요.`);
}

/** 신청 한 사람(합쳐진 이름·같은 이름은 하나로 묶은 뒤). */
export interface JoinEntry {
  /** p:참가자ID 또는 n:이름키. 취소·지우기에 쓴다. */
  key: string;
  name: string;
  /** 명단에 있는 사람이면 참가자 ID, 새 이름이면 null. */
  participantId: string | null;
  /** 처음 신청한 시각(묶인 행 중 가장 이른 것). */
  createdAt: string;
  /** 본인 확인된 신청이면 true(멤버가 로그인한 채 자기 이름으로 신청). 익명 신청에는 없다. */
  verified?: true;
}

interface PersonRow {
  id: string;
  name: string;
  name_key: string;
  status: string;
  merged_into: string | null;
}

function peopleStatement(env: Env, groupId: string): D1PreparedStatement {
  return env.DB.prepare(
    `SELECT p.id, p.name, p.name_key, p.status, m.target_id AS merged_into
     FROM participants p
     LEFT JOIN participant_merges m ON m.source_id = p.id AND m.undone_at IS NULL
     WHERE p.group_id = ?1 ORDER BY p.created_at, p.id`,
  ).bind(groupId);
}

function entryRowsStatement(env: Env, groupId: string): D1PreparedStatement {
  return env.DB.prepare(
    `SELECT id, participant_id, new_name, name_key, created_at, account_id FROM join_requests
     WHERE group_id = ?1 ORDER BY created_at, id`,
  ).bind(groupId);
}

interface EntryRow {
  id: string;
  participant_id: string | null;
  new_name: string | null;
  name_key: string | null;
  created_at: string;
  account_id: string | null;
}

async function loadPeople(env: Env, groupId: string): Promise<PersonRow[]> {
  return (await peopleStatement(env, groupId).all<PersonRow>()).results;
}

/** 신청할 수 있는 사람: 활성이고 다른 사람에게 합쳐지지 않은 참가자. */
function activePeople(people: readonly PersonRow[]): PersonRow[] {
  return people.filter((p) => p.status === "active" && !p.merged_into);
}

interface Grouped extends JoinEntry {
  rowIds: string[];
  /** 본인 확인한 계정(묶인 행 중 값이 있는 것). 비어 있으면 익명 신청. */
  accounts: string[];
}

/** 신청 행을 사람 단위로 묶는다(합쳐진 사람 → 남은 사람, 같은 이름의 새 이름 → 그 참가자). 신청 순. */
async function loadEntries(env: Env, groupId: string, people?: PersonRow[]): Promise<Grouped[]> {
  const list = people ?? (await loadPeople(env, groupId));
  const rows = await entryRowsStatement(env, groupId).all<EntryRow>();
  return groupEntries(rows.results, list);
}

/** 이미 읽은 신청 행을 사람 단위로 묶는다(loadEntries와 공개 응답의 batch가 함께 쓴다). */
function groupEntries(rows: readonly EntryRow[], list: readonly PersonRow[]): Grouped[] {
  const merged = list.map((p) => ({ id: p.id, mergedInto: p.merged_into ?? undefined }));
  const byId = new Map(list.map((p) => [p.id, p]));
  const activeByKey = new Map(activePeople(list).map((p) => [p.name_key, p]));
  const groups = new Map<string, Grouped>();
  for (const r of rows) {
    let participantId: string | null = null;
    let name: string;
    if (r.participant_id) {
      participantId = resolveMerged(merged, r.participant_id);
      name = byId.get(participantId)?.name ?? "";
    } else {
      const same = activeByKey.get(r.name_key!);
      if (same) {
        participantId = same.id;
        name = same.name;
      } else {
        name = r.new_name!;
      }
    }
    const key = participantId ? `p:${participantId}` : `n:${r.name_key}`;
    const found = groups.get(key);
    if (found) {
      found.rowIds.push(r.id);
      if (r.account_id && !found.accounts.includes(r.account_id)) found.accounts.push(r.account_id);
    } else {
      groups.set(key, {
        key,
        name,
        participantId,
        createdAt: r.created_at,
        rowIds: [r.id],
        accounts: r.account_id ? [r.account_id] : [],
      });
    }
  }
  // 행은 시각 순으로 읽었으므로 각 묶음의 첫 행이 가장 이르다. Map은 넣은 순서를 지킨다.
  return [...groups.values()];
}

function publicEntries(entries: readonly Grouped[]): JoinEntry[] {
  return entries.map(({ key, name, participantId, createdAt, accounts }) => ({
    key,
    name,
    participantId,
    createdAt,
    // 본인 확인된 신청일 때만 붙인다(익명 신청의 응답 모양은 예전과 같다).
    ...(accounts.length > 0 ? { verified: true as const } : {}),
  }));
}

/* ------------------------------------------------------------------ */
/* 운영자(대표·공동 운영자). 권한 확인은 앞단(index.ts requireOperator)에서 끝났다.  */
/* ------------------------------------------------------------------ */

export interface JoinAdminView {
  /**
   * 링크가 없으면 null. token은 링크 원문(migrations/0015)이라 운영자·공동 운영자가 어느 기기에서든 다시 복사할 수 있다.
   * 0015 이전에 만든 링크는 token이 null이다(다시 만들어야 주소를 볼 수 있다).
   */
  link: { open: boolean; createdAt: string; token: string | null } | null;
  entries: JoinEntry[];
  max: number;
  target: number;
}

export async function joinAdminView(env: Env, groupId: string): Promise<JoinAdminView> {
  const link = await env.DB.prepare("SELECT is_open, created_at, token FROM join_links WHERE group_id = ?1")
    .bind(groupId)
    .first<{ is_open: number; created_at: string; token: string | null }>();
  return {
    link: link ? { open: link.is_open === 1, createdAt: link.created_at, token: link.token } : null,
    entries: publicEntries(await loadEntries(env, groupId)),
    max: MAX_JOIN_ENTRIES,
    target: JOIN_TARGET,
  };
}

/**
 * 링크를 만들거나 다시 만든다(이전 링크 무효). 받는 상태로 연다. 신청 목록은 그대로다.
 * 공동 운영자 초대처럼 요청 ID 중복 방지를 쓰지 않는다: 응답(토큰 원문)을 요청 기록에 남기지 않기 위해서다.
 */
export async function createJoinLink(env: Env, groupId: string): Promise<{ token: string }> {
  const group = await env.DB.prepare("SELECT maintenance FROM groups WHERE id = ?1")
    .bind(groupId)
    .first<{ maintenance: number }>();
  if (!group) throw new ApiError(404, "NOT_FOUND", "모임을 찾을 수 없습니다.");
  if (group.maintenance === 1) throw maintenanceError();
  const token = newViewToken();
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO join_links (group_id, token_hash, is_open, created_at, updated_at, token) VALUES (?1, ?2, 1, ?3, ?3, ?4)
     ON CONFLICT (group_id) DO UPDATE SET token_hash = excluded.token_hash, token = excluded.token, is_open = 1,
       created_at = excluded.created_at, updated_at = excluded.updated_at`,
  )
    .bind(groupId, await sha256Hex(token), now, token)
    .run();
  return { token };
}

/** 신청 받기 열기·닫기. */
export async function setJoinOpen(env: Env, groupId: string, body: Body): Promise<void> {
  assertOnlyKeys(body, ["requestId", "open"]);
  const requestId = requireString(body.requestId, "requestId", 8, 64);
  if (typeof body.open !== "boolean") throw new ApiError(400, "INVALID_FIELD", "open 값이 올바르지 않습니다.");
  const open = body.open;
  await runMutation(env, {
    groupId,
    requestId,
    op: "join-open",
    payload: { open },
    build: async () => {
      const link = await env.DB.prepare("SELECT 1 AS ok FROM join_links WHERE group_id = ?1")
        .bind(groupId)
        .first<{ ok: number }>();
      if (!link) throw new ApiError(404, "NOT_FOUND", "신청 링크가 없어요. 먼저 링크를 만들어 주세요.");
      return {
        stored: { open },
        statements: [
          env.DB.prepare("UPDATE join_links SET is_open = ?2, updated_at = ?3 WHERE group_id = ?1").bind(
            groupId,
            open ? 1 : 0,
            nowIso(),
          ),
        ],
      };
    },
  });
}

/** 신청 목록 비우기. */
export async function clearJoinEntries(env: Env, groupId: string, body: Body): Promise<void> {
  assertOnlyKeys(body, ["requestId"]);
  const requestId = requireString(body.requestId, "requestId", 8, 64);
  await runMutation(env, {
    groupId,
    requestId,
    op: "join-clear",
    payload: {},
    build: async () => ({
      stored: {},
      statements: [env.DB.prepare("DELETE FROM join_requests WHERE group_id = ?1").bind(groupId)],
    }),
  });
}

/** 한 사람의 신청을 지운다(운영자). 이미 없으면 그대로 성공. */
export async function removeJoinEntry(env: Env, groupId: string, body: Body): Promise<void> {
  assertOnlyKeys(body, ["requestId", "key"]);
  const requestId = requireString(body.requestId, "requestId", 8, 64);
  const key = requireString(body.key, "key", 3, 100);
  await runMutation(env, {
    groupId,
    requestId,
    op: "join-remove",
    payload: { key },
    build: async () => {
      const entry = (await loadEntries(env, groupId)).find((e) => e.key === key);
      return { stored: {}, statements: entry ? deleteRows(env, groupId, entry.rowIds) : [] };
    },
  });
}

function deleteRows(env: Env, groupId: string, rowIds: readonly string[]): D1PreparedStatement[] {
  return rowIds.map((id) =>
    env.DB.prepare("DELETE FROM join_requests WHERE id = ?1 AND group_id = ?2").bind(id, groupId),
  );
}

/* ------------------------------------------------------------------ */
/* 공개(로그인 없음). 토큰이 곧 권한이다. 로그에는 남기지 않는다(http.ts pathForLog). */
/* ------------------------------------------------------------------ */

/** 공개 응답. 이름과 신청 여부만. */
export interface JoinPublicView {
  groupName: string;
  open: boolean;
  max: number;
  target: number;
  /**
   * 신청 순. verified: 본인 확인된 신청(본인·운영자만 뺄 수 있음). mine: 요청한 계정이 본인 확인한 신청.
   * 둘 다 값이 있을 때만 붙는다(로그인하지 않은 사람의 익명 신청 응답 모양은 예전과 같다).
   */
  entries: { key: string; name: string; verified?: true; mine?: true }[];
  /** 신청할 수 있는 명단(활성 참가자). 신청 여부는 entries의 key(p:ID)로 안다. */
  people: { id: string; name: string }[];
  /** 로그인한 멤버가 이 모임의 참가자와 연결돼 있으면 그 참가자 ID(화면이 내 이름을 미리 고른다). 그 밖에는 없다. */
  me?: { participantId: string };
}

interface LinkRow {
  group_id: string;
  token_hash: string;
  is_open: number;
  name: string;
  maintenance: number;
  /** 모임 화면 자료 버전(migrations/0021 트리거). 신청·명단이 바뀌면 오른다. 공개 응답의 ETag에 쓴다. */
  data_version: number;
}

async function findLink(env: Env, token: string): Promise<LinkRow> {
  // 토큰 모양이 아니면 DB를 보지 않고 같은 답을 준다.
  if (typeof token !== "string" || token.length < 8 || token.length > 64) throw invalidLink();
  const row = await env.DB.prepare(
    `SELECT l.group_id, l.token_hash, l.is_open, g.name, g.maintenance, g.data_version
     FROM join_links l JOIN groups g ON g.id = l.group_id WHERE l.token_hash = ?1`,
  )
    .bind(await sha256Hex(token))
    .first<LinkRow>();
  if (!row) throw invalidLink();
  return row;
}

/**
 * 공개 응답. 명단·신청·내 연결을 D1 batch 한 번(왕복 1회, 같은 시점)으로 읽는다(2026-11-07).
 */
async function publicView(env: Env, link: LinkRow, accountId: string | null): Promise<JoinPublicView> {
  const [peopleResult, entryResult, mineResult] = await env.DB.batch([
    peopleStatement(env, link.group_id),
    entryRowsStatement(env, link.group_id),
    env.DB.prepare("SELECT participant_id FROM participant_links WHERE group_id = ?1 AND account_id = ?2").bind(
      link.group_id,
      accountId ?? "",
    ),
  ]);
  const people = (peopleResult?.results ?? []) as unknown as PersonRow[];
  const entries = groupEntries((entryResult?.results ?? []) as unknown as EntryRow[], people);
  const active = activePeople(people);
  const view: JoinPublicView = {
    groupName: link.name,
    open: link.is_open === 1,
    max: MAX_JOIN_ENTRIES,
    target: JOIN_TARGET,
    entries: entries.map((e) => ({
      key: e.key,
      name: e.name,
      ...(e.accounts.length > 0 ? { verified: true as const } : {}),
      ...(accountId && e.accounts.includes(accountId) ? { mine: true as const } : {}),
    })),
    people: active.map((p) => ({ id: p.id, name: p.name })),
  };
  const mine = accountId
    ? (((mineResult?.results ?? [])[0] as { participant_id?: string } | undefined)?.participant_id ?? null)
    : null;
  if (mine && active.some((p) => p.id === mine)) view.me = { participantId: mine };
  return view;
}

/** 공개 정보. accountId는 로그인한 사람의 계정(없으면 null): 멤버면 내 이름·내 신청 표시가 붙는다. */
export async function joinInfo(env: Env, token: string, accountId: string | null = null): Promise<JoinPublicView> {
  return publicView(env, await findLink(env, token), accountId);
}

/**
 * 조건부 공개 조회(GET /api/join/:token). 링크 행 하나만 읽어 ETag를 만들고, 화면이 가진 것과 같으면
 * 명단·신청을 읽지 않고 notModified로 돌려준다. ETag에는 계정도 넣는다(로그인한 멤버의 "내 신청" 표시가 다르다).
 */
export async function joinInfoConditional(
  env: Env,
  token: string,
  accountId: string | null,
  ifNoneMatch: string | null,
): Promise<{ etag: string; notModified: true } | { etag: string; notModified: false; view: JoinPublicView }> {
  const link = await findLink(env, token);
  const parts = [
    "j1",
    env.CF_VERSION_METADATA?.id ?? "",
    link.group_id,
    link.token_hash,
    link.data_version,
    link.is_open,
    link.name,
    link.maintenance,
    accountId ?? "",
  ];
  const etag = `W/"${(await sha256Hex(JSON.stringify(parts))).slice(0, 24)}"`;
  if (etagMatches(ifNoneMatch, etag)) return { etag, notModified: true };
  return { etag, notModified: false, view: await publicView(env, link, accountId) };
}

/** 링크가 그대로이고 열려 있는지 batch 안에서 다시 확인하는 보호 문장(확인과 저장 사이의 닫기·다시 만들기). */
function linkGuard(env: Env, link: LinkRow): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO guard (state_conflict)
     SELECT 1 WHERE NOT EXISTS (
       SELECT 1 FROM join_links WHERE group_id = ?1 AND token_hash = ?2 AND is_open = 1
     )`,
  ).bind(link.group_id, link.token_hash);
}

async function writable(env: Env, token: string): Promise<LinkRow> {
  const link = await findLink(env, token);
  if (link.maintenance === 1) throw maintenanceError();
  if (link.is_open !== 1) throw closedError();
  return link;
}

async function runGuarded(env: Env, link: LinkRow, statements: D1PreparedStatement[]): Promise<void> {
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("guard_state_conflict")) {
      // 그 사이 링크가 닫혔거나 다시 만들어졌다.
      const now = await env.DB.prepare("SELECT token_hash, is_open FROM join_links WHERE group_id = ?1")
        .bind(link.group_id)
        .first<{ token_hash: string; is_open: number }>();
      if (!now || now.token_hash !== link.token_hash) throw invalidLink();
      if (now.is_open !== 1) throw closedError();
      // 링크는 그대로: 본인 확인 신청의 연결이 끊겼거나 신청이 그 사이 본인 확인 신청으로 바뀌었다(migrations/0019).
      throw new ApiError(409, "VERSION_CONFLICT", "그 사이 신청 내용이 바뀌었어요. 화면을 새로 고친 뒤 다시 해 주세요.");
    }
    if (message.includes("guard_version_conflict")) throw fullError();
    throw error;
  }
}

/**
 * 신청한다. 본문: { participantId } 또는 { name }(명단에 없는 새 이름). 둘 중 하나만.
 * 같은 사람이 이미 신청했으면 아무것도 바꾸지 않고 지금 상태를 돌려준다.
 * accountId(로그인한 계정)가 그 참가자와 연결된 멤버면 본인 확인 신청으로 저장한다(이미 익명 신청이 있으면 본인 것으로 바꾼다).
 */
export async function joinAdd(
  env: Env,
  token: string,
  body: Body,
  accountId: string | null = null,
): Promise<JoinPublicView> {
  assertOnlyKeys(body, ["participantId", "name"]);
  if ((body.participantId === undefined) === (body.name === undefined)) {
    throw new ApiError(400, "INVALID_FIELD", "participantId와 name 중 하나만 보내 주세요.");
  }
  const link = await writable(env, token);
  const people = await loadPeople(env, link.group_id);
  const active = activePeople(people);
  let participantId: string | null = null;
  let newName: string | null = null;
  if (body.participantId !== undefined) {
    const id = requireString(body.participantId, "participantId", 1, 64);
    // 다른 모임의 참가자, 보관·합쳐진 참가자는 없는 것과 같은 답을 준다.
    if (!active.some((p) => p.id === id)) {
      throw new ApiError(404, "NOT_FOUND", "명단에서 그 사람을 찾을 수 없어요. 화면을 새로 고쳐 주세요.");
    }
    participantId = id;
  } else {
    const name = parseName(body.name);
    const same = active.find((p) => p.name_key === nameKey(name));
    if (same) participantId = same.id;
    else newName = name;
  }
  const key = participantId ? `p:${participantId}` : `n:${nameKey(newName!)}`;
  const entries = await loadEntries(env, link.group_id, people);
  // 본인 확인: 로그인한 계정이 이 참가자와 연결돼 있을 때만.
  const verifiedBy =
    accountId && participantId && (await memberParticipantId(env, link.group_id, accountId)) === participantId
      ? accountId
      : null;
  const existing = entries.find((e) => e.key === key);
  if (existing && verifiedBy && !existing.accounts.includes(verifiedBy)) {
    // 익명으로 들어 있던 내 이름의 신청을 본인 확인 신청으로 바꾼다. 연결이 그 사이 끊겼으면 바꾸지 않는다.
    await runGuarded(env, link, [
      linkGuard(env, link),
      memberGuard(env, link.group_id, participantId!, verifiedBy),
      ...existing.rowIds.map((id) =>
        env.DB.prepare("UPDATE join_requests SET account_id = ?1 WHERE id = ?2 AND group_id = ?3").bind(
          verifiedBy,
          id,
          link.group_id,
        ),
      ),
    ]);
  }
  if (!existing) {
    if (entries.length >= MAX_JOIN_ENTRIES) throw fullError();
    await runGuarded(env, link, [
      linkGuard(env, link),
      // 그 사이 다른 신청으로 상한에 닿았으면 막는다(행 수로 센다: 묶인 행이 있으면 조금 일찍 막힐 수 있다).
      env.DB.prepare(
        `INSERT INTO guard (version_conflict)
         SELECT 1 WHERE (SELECT COUNT(*) FROM join_requests WHERE group_id = ?1) >= ?2`,
      ).bind(link.group_id, MAX_JOIN_ENTRIES),
      // 같은 사람·같은 새 이름이 동시에 들어오면 하나만 남는다(고유 색인).
      ...(verifiedBy ? [memberGuard(env, link.group_id, participantId!, verifiedBy)] : []),
      env.DB.prepare(
        `INSERT OR IGNORE INTO join_requests (id, group_id, participant_id, new_name, name_key, created_at, account_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      ).bind(newId(), link.group_id, participantId, newName, newName ? nameKey(newName) : null, nowIso(), verifiedBy),
    ]);
  }
  return publicView(env, link, accountId);
}

/** 멤버 연결이 그대로인지 batch 안에서 다시 확인한다(끊긴 직후의 본인 확인 신청을 막는다). */
function memberGuard(env: Env, groupId: string, participantId: string, accountId: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO guard (state_conflict)
     SELECT 1 WHERE NOT EXISTS (
       SELECT 1 FROM participant_links WHERE group_id = ?1 AND participant_id = ?2 AND account_id = ?3
     )`,
  ).bind(groupId, participantId, accountId);
}

/**
 * 신청을 취소한다. 본문: { key }(공개 응답의 entries[].key). 이미 없으면 그대로 성공.
 * 익명 신청은 누구나 뺄 수 있다. 본인 확인된 신청은 그 계정(본인)과 이 모임의 운영자만 뺄 수 있다.
 */
export async function joinCancel(
  env: Env,
  token: string,
  body: Body,
  accountId: string | null = null,
): Promise<JoinPublicView> {
  assertOnlyKeys(body, ["key"]);
  const key = requireString(body.key, "key", 3, 100);
  const link = await writable(env, token);
  const entry = (await loadEntries(env, link.group_id)).find((e) => e.key === key);
  if (entry) {
    if (entry.accounts.length > 0) {
      const allowed =
        accountId !== null &&
        (entry.accounts.includes(accountId) || (await operatorRole(env, link.group_id, accountId)) !== null);
      if (!allowed) {
        throw new ApiError(403, "JOIN_VERIFIED", "본인이 확인한 신청이라 본인이나 운영자만 뺄 수 있어요.");
      }
    }
    await runGuarded(env, link, [
      linkGuard(env, link),
      // 확인한 뒤 그 사이 본인 확인 신청으로 바뀌었으면(행의 계정이 달라짐) 막는다.
      env.DB.prepare(
        `INSERT INTO guard (state_conflict)
         SELECT 1 WHERE EXISTS (
           SELECT 1 FROM join_requests WHERE group_id = ?1 AND id IN (SELECT value FROM json_each(?2))
             AND account_id IS NOT NULL AND account_id NOT IN (SELECT value FROM json_each(?3))
         )`,
      ).bind(link.group_id, JSON.stringify(entry.rowIds), JSON.stringify(entry.accounts)),
      ...deleteRows(env, link.group_id, entry.rowIds),
    ]);
  }
  return publicView(env, link, accountId);
}
