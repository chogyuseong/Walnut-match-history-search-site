/**
 * 참가자 본인 연결 · 멤버 기능 · 요청(migrations/0019). 원칙: "참가자는 자기 것만 건드리고, 기록은 운영자만 고친다".
 *
 * 연결:
 * - 운영자(대표·공동)가 참가자별 1회용 연결 링크를 만든다: 24시간, 토큰은 해시만 저장, 다시 만들면 쓰지 않은 이전 링크는 지운다
 *   (공동 운영자 초대와 같은 방식). 로그인한 계정이 수락하면 계정 ↔ 참가자가 묶인다.
 * - 한 참가자에는 계정 하나, 한 계정은 한 모임에서 참가자 하나. 연결은 계정당 모임 한도(대표 + 공동 5)에 세지 않고
 *   따로 MAX_LINKS_PER_ACCOUNT개까지.
 * - 확인과 저장은 한 batch + 보호 문장: 같은 링크를 두 계정이 동시에 쓰면 하나만 성공한다.
 * - 운영자도, 멤버 본인도 끊을 수 있다. 끊으면 그 계정의 본인 확인 신청 표시도 지운다.
 *
 * 멤버(연결한 계정)가 할 수 있는 것: 읽기(조회 링크와 같은 응답 + 내 것), 내 기피 라인, 요청 남기기, 연결 끊기.
 * 권한 확인은 auth.ts requireMember(운영자 검사와 따로)가 요청마다 연결 표를 다시 읽어 한다.
 *
 * 익명 처리(운영자): 이름을 "탈퇴한 참가자 N"으로, 보관, 연결·연결 링크·기피 라인·티어·요청·신청을 지운다. 경기 기록은 남긴다.
 */
import { memoLength, normalizeMemo } from "../shared/memo";
import { nameKey } from "../shared/names";
import type { MemberRequestKind, Snapshot } from "../shared/types";
import { decodeAvoid } from "../shared/avoid";
import { newViewToken, type MemberContext } from "./auth";
import type { Env } from "./env";
import { parseAvoidField } from "./groups";
import { ApiError, assertOnlyKeys, newId, nowIso, requireOneOf, requireString } from "./http";
import { maintenanceError, maintenanceGuard, runMutation, sha256Hex } from "./mutation";
import { buildSnapshot, loadEtagHead, loadMemberRequests, snapshotEtag, type EtagHead } from "./snapshot";

/** 한 계정이 연결할 수 있는 참가자 수(모임마다 하나이므로 곧 참가 중인 모임 수). */
export const MAX_LINKS_PER_ACCOUNT = 20;
const CLAIM_HOURS = 24;
/** 요청 글·운영자 답의 최대 글자 수(코드 포인트). */
export const REQUEST_TEXT_MAX = 200;
/** 한 참가자가 동시에 열어 둘 수 있는 요청 수. */
export const MAX_OPEN_REQUESTS = 5;
/** 익명 처리 확인 문구. */
export const ANONYMIZE_CONFIRM_TEXT = "익명";
/** 익명 처리한 이름의 앞부분. 뒤에 모임 안에서 겹치지 않는 번호를 붙인다. */
export const ANON_NAME_PREFIX = "탈퇴한 참가자";
export const ANON_NAME_PATTERN = /^탈퇴한 참가자 \d+$/;

type Body = Record<string, unknown>;

const CLAIM_INVALID_MESSAGE = "이 연결 링크는 이미 썼거나 만료됐어요. 운영자에게 새 링크를 요청해 주세요.";

function claimInvalid(): ApiError {
  return new ApiError(404, "CLAIM_INVALID", CLAIM_INVALID_MESSAGE);
}

async function assertWritable(env: Env, groupId: string): Promise<void> {
  const group = await env.DB.prepare("SELECT maintenance FROM groups WHERE id = ?1")
    .bind(groupId)
    .first<{ maintenance: number }>();
  if (!group) throw new ApiError(404, "NOT_FOUND", "모임을 찾을 수 없습니다.");
  if (group.maintenance === 1) throw maintenanceError();
}

/**
 * batch 실패 메시지가 어떤 보호 문장에 걸렸는지. 점검 보호(guard_maintenance)는 여기서 바로 maintenanceError로 던진다:
 * assertWritable은 batch 밖의 읽기라 확인 뒤 batch 전에 복원·모임 삭제가 점검을 켤 수 있어, 각 batch 맨 앞에
 * maintenanceGuard를 넣어 batch 안에서 다시 확인한다(runMutation과 같은 방식, 2026-11-08 정합성 점검).
 */
function guardError(message: string): "state" | "version" | null {
  if (message.includes("guard_maintenance")) throw maintenanceError();
  if (message.includes("guard_state_conflict")) return "state";
  if (message.includes("guard_version_conflict")) return "version";
  return null;
}

interface PersonRow {
  id: string;
  name: string;
  name_key: string;
  status: string;
  merged_into: string | null;
}

async function loadPerson(env: Env, groupId: string, participantId: string): Promise<PersonRow> {
  const row = await env.DB.prepare(
    `SELECT p.id, p.name, p.name_key, p.status, m.target_id AS merged_into
     FROM participants p LEFT JOIN participant_merges m ON m.source_id = p.id AND m.undone_at IS NULL
     WHERE p.id = ?1 AND p.group_id = ?2`,
  )
    .bind(participantId, groupId)
    .first<PersonRow>();
  if (!row) throw new ApiError(404, "NOT_FOUND", "참가자를 찾을 수 없습니다.");
  return row;
}

function mergedError(): ApiError {
  return new ApiError(
    409,
    "MERGED_PARTICIPANT",
    "다른 사람에게 합쳐진 이름이에요. 남은 사람(합친 쪽)으로 해 주세요.",
  );
}

/* ------------------------------------------------------------------ */
/* 연결 링크(운영자)                                                     */
/* ------------------------------------------------------------------ */

/** 참가자 연결 링크를 만든다. 운영자 확인은 앞단(index.ts requireOperator)에서 끝났다. 토큰 원문은 이 응답에서 한 번만. */
export async function createClaimLink(
  env: Env,
  groupId: string,
  participantId: string,
): Promise<{ token: string; expiresAt: string }> {
  await assertWritable(env, groupId);
  const person = await loadPerson(env, groupId, participantId);
  if (person.merged_into) throw mergedError();
  const linked = await env.DB.prepare(
    "SELECT 1 AS ok FROM participant_links WHERE group_id = ?1 AND participant_id = ?2",
  )
    .bind(groupId, participantId)
    .first<{ ok: number }>();
  if (linked) {
    throw new ApiError(409, "ALREADY_LINKED", "이미 계정과 연결된 참가자예요. 다시 연결하려면 먼저 연결을 끊어 주세요.");
  }
  const token = newViewToken();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + CLAIM_HOURS * 3600_000).toISOString();
  const tokenHash = await sha256Hex(token);
  try {
    await env.DB.batch([
      maintenanceGuard(env, groupId),
      env.DB.prepare(
        "DELETE FROM participant_claims WHERE group_id = ?1 AND participant_id = ?2 AND used_at IS NULL",
      ).bind(groupId, participantId),
      env.DB.prepare(
        `INSERT INTO participant_claims (token_hash, group_id, participant_id, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      ).bind(tokenHash, groupId, participantId, now, expiresAt),
    ]);
  } catch (error) {
    guardError(error instanceof Error ? error.message : String(error));
    throw error;
  }
  return { token, expiresAt };
}

interface ClaimRow {
  token_hash: string;
  group_id: string;
  participant_id: string;
  expires_at: string;
  group_name: string;
  participant_name: string;
}

async function findClaim(env: Env, token: string): Promise<ClaimRow> {
  // 토큰 모양이 아니면 DB를 보지 않고 같은 답을 준다.
  if (typeof token !== "string" || token.length < 8 || token.length > 64) throw claimInvalid();
  const row = await env.DB.prepare(
    `SELECT c.token_hash, c.group_id, c.participant_id, c.expires_at, g.name AS group_name, p.name AS participant_name
     FROM participant_claims c
     JOIN groups g ON g.id = c.group_id
     JOIN participants p ON p.id = c.participant_id AND p.group_id = c.group_id
     WHERE c.token_hash = ?1 AND c.used_at IS NULL AND c.expires_at > ?2`,
  )
    .bind(await sha256Hex(token), nowIso())
    .first<ClaimRow>();
  // 없는 링크, 이미 쓴 링크, 만료된 링크, 참가자가 없어진 링크에 같은 답을 준다.
  if (!row) throw claimInvalid();
  return row;
}

/** 연결 링크 정보(로그인 없이도 본다: 모임 이름과 그 참가자 이름만). */
export async function claimInfo(
  env: Env,
  token: string,
): Promise<{ groupName: string; participantName: string; expiresAt: string }> {
  const row = await findClaim(env, token);
  return { groupName: row.group_name, participantName: row.participant_name, expiresAt: row.expires_at };
}

/**
 * 연결 링크를 수락한다. 확인(링크 유효, 참가자 미연결, 이 계정의 그 모임 연결 없음, 계정의 연결 수)과 저장을
 * 한 batch로 실행한다: 같은 링크를 두 계정이 동시에 써도 하나만 성공한다.
 */
export async function acceptClaim(
  env: Env,
  accountId: string,
  token: string,
): Promise<{ groupId: string; participantId: string }> {
  const row = await findClaim(env, token);
  await assertWritable(env, row.group_id);
  const person = await loadPerson(env, row.group_id, row.participant_id);
  if (person.merged_into) throw claimInvalid();
  const existing = await env.DB.prepare(
    "SELECT participant_id, account_id FROM participant_links WHERE group_id = ?1 AND (participant_id = ?2 OR account_id = ?3)",
  )
    .bind(row.group_id, row.participant_id, accountId)
    .all<{ participant_id: string; account_id: string }>();
  for (const link of existing.results) {
    if (link.participant_id === row.participant_id && link.account_id === accountId) {
      throw new ApiError(409, "ALREADY_LINKED", "이미 내 계정과 연결된 참가자예요.");
    }
    if (link.participant_id === row.participant_id) {
      throw new ApiError(409, "ALREADY_LINKED", "이 참가자는 이미 다른 계정과 연결돼 있어요. 운영자에게 확인해 주세요.");
    }
    throw new ApiError(
      409,
      "ALREADY_MEMBER",
      "이 계정은 이 모임에서 이미 다른 참가자 이름과 연결돼 있어요. 한 모임에서는 한 이름만 연결할 수 있어요.",
    );
  }
  if ((await linkCount(env, accountId)) >= MAX_LINKS_PER_ACCOUNT) throw tooManyLinks();

  const now = nowIso();
  try {
    await env.DB.batch([
      maintenanceGuard(env, row.group_id),
      // 확인과 저장 사이에 같은 링크가 쓰였거나 만료·무효가 됐으면 막는다.
      env.DB.prepare(
        `INSERT INTO guard (state_conflict)
         SELECT 1 WHERE NOT EXISTS (
           SELECT 1 FROM participant_claims WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2
         )`,
      ).bind(row.token_hash, now),
      // 그 사이 참가자가 연결됐거나, 이 계정이 이 모임에서 연결됐거나, 연결 수가 한도에 닿았으면 막는다.
      env.DB.prepare(
        `INSERT INTO guard (version_conflict)
         SELECT 1 WHERE EXISTS (
             SELECT 1 FROM participant_links WHERE group_id = ?1 AND (participant_id = ?2 OR account_id = ?3))
           OR (SELECT COUNT(*) FROM participant_links WHERE account_id = ?3) >= ?4
           OR EXISTS (SELECT 1 FROM participant_merges WHERE source_id = ?2 AND undone_at IS NULL)`,
      ).bind(row.group_id, row.participant_id, accountId, MAX_LINKS_PER_ACCOUNT),
      env.DB.prepare(
        "INSERT INTO participant_links (group_id, participant_id, account_id, created_at) VALUES (?1, ?2, ?3, ?4)",
      ).bind(row.group_id, row.participant_id, accountId, now),
      env.DB.prepare("UPDATE participant_claims SET used_at = ?1 WHERE token_hash = ?2").bind(now, row.token_hash),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const kind = guardError(message);
    if (kind === "state") throw claimInvalid();
    if (kind === "version" || message.includes("UNIQUE") || message.includes("participant_links")) {
      if ((await linkCount(env, accountId)) >= MAX_LINKS_PER_ACCOUNT) throw tooManyLinks();
      throw new ApiError(409, "ALREADY_LINKED", "그 사이 이 참가자나 이 계정이 다른 연결을 맺었어요. 화면을 새로 고쳐 주세요.");
    }
    throw error;
  }
  return { groupId: row.group_id, participantId: row.participant_id };
}

async function linkCount(env: Env, accountId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM participant_links WHERE account_id = ?1")
    .bind(accountId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function tooManyLinks(): ApiError {
  return new ApiError(
    409,
    "TOO_MANY_LINKS",
    `한 계정은 모임 ${MAX_LINKS_PER_ACCOUNT}곳까지 참가자로 연결할 수 있어요. 쓰지 않는 연결을 끊은 뒤 다시 해 주세요.`,
  );
}

/** 연결을 지우는 문장들: 연결 행, 그 계정의 이 모임 본인 확인 신청 표시. */
function unlinkStatements(env: Env, groupId: string, accountId: string, participantId: string): D1PreparedStatement[] {
  return [
    env.DB.prepare(
      "DELETE FROM participant_links WHERE group_id = ?1 AND participant_id = ?2 AND account_id = ?3",
    ).bind(groupId, participantId, accountId),
    env.DB.prepare("UPDATE join_requests SET account_id = NULL WHERE group_id = ?1 AND account_id = ?2").bind(
      groupId,
      accountId,
    ),
  ];
}

/**
 * 운영자가 참가자의 연결을 끊는다. 쓰지 않은 연결 링크도 함께 지운다. 이미 없으면 404.
 * 공통 경로(runMutation, 2026-11-08): 본문 { requestId }(필수). 같은 요청 ID로 다시 보내면 처음 결과를 그대로 준다
 * (처음에 끊었으면 다시 보내도 200, 처음에 연결이 없었으면 다시 보내도 404).
 */
export async function unlinkByOperator(
  env: Env,
  groupId: string,
  participantId: string,
  body: Body,
): Promise<void> {
  assertOnlyKeys(body, ["requestId"]);
  const { stored } = await runMutation(env, {
    groupId,
    requestId: requireString(body.requestId, "requestId", 8, 64),
    op: "unlink-participant",
    payload: { participantId },
    build: async () => {
      const link = await env.DB.prepare(
        "SELECT account_id FROM participant_links WHERE group_id = ?1 AND participant_id = ?2",
      )
        .bind(groupId, participantId)
        .first<{ account_id: string }>();
      return {
        // 연결이 없어도 쓰지 않은 연결 링크는 지운다(예전과 같다). 결과(404)는 요청 기록에 남겨 재전송에도 같게 답한다.
        stored: { linked: link !== null },
        statements: [
          env.DB.prepare(
            "DELETE FROM participant_claims WHERE group_id = ?1 AND participant_id = ?2 AND used_at IS NULL",
          ).bind(groupId, participantId),
          ...(link ? unlinkStatements(env, groupId, link.account_id, participantId) : []),
        ],
      };
    },
  });
  if (stored.linked !== true) throw new ApiError(404, "NOT_FOUND", "연결된 계정이 없어요. 이미 끊겼을 수 있어요.");
}

/** 멤버 본인이 연결을 끊는다. */
export async function unlinkSelf(env: Env, ctx: MemberContext): Promise<void> {
  await env.DB.batch(unlinkStatements(env, ctx.groupId, ctx.accountId, ctx.participantId));
}

/* ------------------------------------------------------------------ */
/* 계정의 참가 중인 모임(/api/me)                                         */
/* ------------------------------------------------------------------ */

export interface MembershipView {
  id: string;
  name: string;
  participantId: string;
  participantName: string;
  role: "member";
}

export async function listMemberships(env: Env, accountId: string): Promise<MembershipView[]> {
  const rows = await env.DB.prepare(
    `SELECT g.id, g.name, l.participant_id, p.name AS participant_name
     FROM participant_links l
     JOIN groups g ON g.id = l.group_id
     JOIN participants p ON p.id = l.participant_id AND p.group_id = l.group_id
     WHERE l.account_id = ?1 ORDER BY l.created_at, g.id`,
  )
    .bind(accountId)
    .all<{ id: string; name: string; participant_id: string; participant_name: string }>();
  return rows.results.map((r) => ({
    id: r.id,
    name: r.name,
    participantId: r.participant_id,
    participantName: r.participant_name,
    role: "member" as const,
  }));
}

/* ------------------------------------------------------------------ */
/* 멤버 읽기 · 내 기피 라인 · 요청                                        */
/* ------------------------------------------------------------------ */

/**
 * 멤버 읽기 응답: 조회 링크 응답(buildSnapshot "viewer", 같은 직렬화 함수)에 내 것만 더한다.
 * 티어(비공개 모임)·다른 사람의 기피 라인·서포터 보정값·토큰은 조회 응답처럼 나가지 않는다.
 */
export async function memberSnapshot(env: Env, ctx: MemberContext): Promise<Snapshot> {
  const snapshot = await buildSnapshot(env, ctx.groupId, "viewer");
  const own = await env.DB.prepare(
    `SELECT p.avoid_positions, l.avoid_self_at FROM participants p
     JOIN participant_links l ON l.group_id = p.group_id AND l.participant_id = p.id
     WHERE p.id = ?1 AND p.group_id = ?2`,
  )
    .bind(ctx.participantId, ctx.groupId)
    .first<{ avoid_positions: string | null; avoid_self_at: string | null }>();
  snapshot.me = {
    participantId: ctx.participantId,
    avoidPositions: decodeAvoid(own?.avoid_positions),
    avoidBySelf: own?.avoid_self_at != null,
    requests: await loadMemberRequests(env, ctx.groupId, ctx.participantId),
  };
  return snapshot;
}

/**
 * 멤버 스냅숏의 ETag(조건부 요청, 2026-11-09). 조회 응답의 재료(snapshotEtag "viewer")에 "member"·계정·참가자를 더한다.
 * - 멤버 응답에만 있는 값(me)의 출처: participants.avoid_positions, participant_links.avoid_self_at,
 *   participant_requests(그 사람의 요청과 처리 상태). 세 표 모두 data_version 트리거가 있어(migrations/0021)
 *   요청을 남기거나 운영자가 처리·지우면 data_version이 올라 ETag가 바뀐다. 그래서 이 표들을 따로 읽지 않는다
 *   (모임 행 1행만 읽는다). 시각에 따라 달라지는 값은 없다.
 * - 참가자 ID: me.participantId가 본문에 들어가고, 연결이 끊긴 뒤 다른 참가자로 다시 연결해도 예전 본문을 되살리지 않게.
 * - 계정 ID: 같은 브라우저에서 다른 계정으로 바꿔 로그인했을 때 예전 계정의 본문을 304로 되살리지 않게.
 * 모임이 없으면 null.
 */
export async function memberSnapshotEtag(
  env: Env,
  ctx: MemberContext,
): Promise<{ etag: string; head: EtagHead } | null> {
  const head = await loadEtagHead(env, ctx.groupId, false);
  if (!head) return null;
  return { etag: await snapshotEtag(env, head, "viewer", ["member", ctx.accountId, ctx.participantId]), head };
}

/** 이 연결이 그대로인지 batch 안에서 다시 확인하는 보호 문장(끊긴 직후의 요청을 막는다). */
function linkGuard(env: Env, ctx: MemberContext): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO guard (state_conflict)
     SELECT 1 WHERE NOT EXISTS (
       SELECT 1 FROM participant_links WHERE group_id = ?1 AND participant_id = ?2 AND account_id = ?3
     )`,
  ).bind(ctx.groupId, ctx.participantId, ctx.accountId);
}

function linkGoneError(): ApiError {
  return new ApiError(404, "NOT_FOUND", "모임을 찾을 수 없습니다.");
}

/** 내 기피 라인을 정한다(본인 것만). 본문: { avoidPositions: 포지션 배열 | null }. 검증은 운영자 수정과 같다. */
export async function setOwnAvoid(env: Env, ctx: MemberContext, body: Body): Promise<void> {
  assertOnlyKeys(body, ["avoidPositions"]);
  if (body.avoidPositions === undefined) {
    throw new ApiError(400, "INVALID_FIELD", "avoidPositions 값이 올바르지 않습니다.");
  }
  const value = parseAvoidField(body.avoidPositions);
  await assertWritable(env, ctx.groupId);
  try {
    await env.DB.batch([
      maintenanceGuard(env, ctx.groupId),
      linkGuard(env, ctx),
      env.DB.prepare("UPDATE participants SET avoid_positions = ?1, version = version + 1 WHERE id = ?2 AND group_id = ?3").bind(
        value,
        ctx.participantId,
        ctx.groupId,
      ),
      env.DB.prepare(
        "UPDATE participant_links SET avoid_self_at = ?1 WHERE group_id = ?2 AND participant_id = ?3",
      ).bind(nowIso(), ctx.groupId, ctx.participantId),
    ]);
  } catch (error) {
    if (guardError(error instanceof Error ? error.message : String(error)) === "state") throw linkGoneError();
    throw error;
  }
}

/** 요청 글 정리: 메모와 같은 규칙(줄바꿈 허용, 제어 문자는 공백, 앞뒤 공백 제거). 200자 넘으면 거절. */
function parseText(value: unknown, field: string, required: boolean): string {
  if (value === undefined || value === null) {
    if (required) throw new ApiError(400, "INVALID_FIELD", "내용을 적어 주세요.");
    return "";
  }
  if (typeof value !== "string") throw new ApiError(400, "INVALID_FIELD", `${field} 값이 올바르지 않습니다.`);
  const text = normalizeMemo(value) ?? "";
  if (required && text === "") throw new ApiError(400, "INVALID_FIELD", "내용을 적어 주세요.");
  if (memoLength(text) > REQUEST_TEXT_MAX) {
    throw new ApiError(400, "TEXT_TOO_LONG", `${REQUEST_TEXT_MAX}자까지 적을 수 있어요.`);
  }
  return text;
}

/**
 * 요청을 남긴다(기록은 바뀌지 않는다). 본문: { kind: "correction", matchId, text } 또는 { kind: "erase", text? }.
 * 정정 요청은 자기가 뛴 경기만. 열린 요청은 한 사람에 MAX_OPEN_REQUESTS개까지.
 */
export async function createMemberRequest(env: Env, ctx: MemberContext, body: Body): Promise<{ id: string }> {
  assertOnlyKeys(body, ["kind", "matchId", "text"]);
  const kind = requireOneOf<MemberRequestKind>(body.kind, ["correction", "erase"], "kind");
  let matchId: string | null = null;
  if (kind === "correction") {
    matchId = requireString(body.matchId, "matchId", 1, 64);
  } else if (body.matchId !== undefined) {
    throw new ApiError(400, "INVALID_FIELD", "matchId 값이 올바르지 않습니다.");
  }
  const text = parseText(body.text, "text", kind === "correction");
  await assertWritable(env, ctx.groupId);
  if (matchId !== null) {
    // 자기가 뛴 경기만(명단에 내 참가자가 있는 경기). 다른 모임의 경기·없는 경기·안 뛴 경기는 같은 답.
    const played = await env.DB.prepare(
      `SELECT 1 AS ok FROM match_roster r JOIN matches m ON m.id = r.match_id AND m.group_id = r.group_id
       WHERE r.group_id = ?1 AND r.match_id = ?2 AND r.participant_id = ?3 AND m.deleted_at IS NULL`,
    )
      .bind(ctx.groupId, matchId, ctx.participantId)
      .first<{ ok: number }>();
    if (!played) {
      throw new ApiError(404, "NOT_FOUND", "내가 뛴 경기에만 정정을 요청할 수 있어요.");
    }
  }
  const open = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM participant_requests WHERE group_id = ?1 AND participant_id = ?2 AND status = 'open'",
  )
    .bind(ctx.groupId, ctx.participantId)
    .first<{ n: number }>();
  if ((open?.n ?? 0) >= MAX_OPEN_REQUESTS) throw tooManyRequests();
  const id = newId();
  try {
    await env.DB.batch([
      maintenanceGuard(env, ctx.groupId),
      linkGuard(env, ctx),
      env.DB.prepare(
        `INSERT INTO guard (version_conflict)
         SELECT 1 WHERE (SELECT COUNT(*) FROM participant_requests
                         WHERE group_id = ?1 AND participant_id = ?2 AND status = 'open') >= ?3`,
      ).bind(ctx.groupId, ctx.participantId, MAX_OPEN_REQUESTS),
      env.DB.prepare(
        `INSERT INTO participant_requests (id, group_id, participant_id, kind, match_id, body, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      ).bind(id, ctx.groupId, ctx.participantId, kind, matchId, text, nowIso()),
    ]);
  } catch (error) {
    const found = guardError(error instanceof Error ? error.message : String(error));
    if (found === "state") throw linkGoneError();
    if (found === "version") throw tooManyRequests();
    throw error;
  }
  return { id };
}

function tooManyRequests(): ApiError {
  return new ApiError(
    409,
    "TOO_MANY_REQUESTS",
    `처리를 기다리는 요청이 ${MAX_OPEN_REQUESTS}개예요. 운영자가 처리한 뒤 다시 남겨 주세요.`,
  );
}

/**
 * 운영자가 요청을 처리한다. 본문: { requestId, status: "done" | "declined", reply? }. 이미 처리한 요청은 409.
 * 공통 경로(runMutation, 2026-11-08): 같은 요청 ID로 다시 보내면(응답을 못 받은 재시도) 409가 아니라 처음 결과(200)를 준다.
 */
export async function resolveMemberRequest(env: Env, groupId: string, id: string, body: Body): Promise<void> {
  assertOnlyKeys(body, ["requestId", "status", "reply"]);
  const requestId = requireString(body.requestId, "requestId", 8, 64);
  const status = requireOneOf(body.status, ["done", "declined"] as const, "status");
  const reply = parseText(body.reply, "reply", false);
  const alreadyResolved = () => new ApiError(409, "ALREADY_RESOLVED", "이미 처리한 요청이에요.");
  try {
    await runMutation(env, {
      groupId,
      requestId,
      op: "resolve-member-request",
      payload: { id, status, reply },
      build: async () => {
        const row = await env.DB.prepare("SELECT status FROM participant_requests WHERE id = ?1 AND group_id = ?2")
          .bind(id, groupId)
          .first<{ status: string }>();
        if (!row) throw new ApiError(404, "NOT_FOUND", "요청을 찾을 수 없어요.");
        if (row.status !== "open") throw alreadyResolved();
        return {
          stored: {},
          statements: [
            // 읽은 뒤 그 사이 다른 운영자가 먼저 처리했으면(또는 익명 처리로 지워졌으면) batch 전체를 되돌린다.
            stateGuard(
              env,
              "NOT EXISTS (SELECT 1 FROM participant_requests WHERE id = ?1 AND group_id = ?2 AND status = 'open')",
              id,
              groupId,
            ),
            env.DB.prepare(
              `UPDATE participant_requests SET status = ?1, reply = ?2, resolved_at = ?3
               WHERE id = ?4 AND group_id = ?5 AND status = 'open'`,
            ).bind(status, reply === "" ? null : reply, nowIso(), id, groupId),
          ],
        };
      },
    });
  } catch (error) {
    // 보호 문장(guard_state_conflict)은 공통 경로가 VERSION_CONFLICT로 바꾼다. 여기서는 "먼저 처리됨"이라는 뜻이다.
    if (error instanceof ApiError && error.code === "VERSION_CONFLICT") throw alreadyResolved();
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* 익명 처리(운영자)                                                      */
/* ------------------------------------------------------------------ */

const stateGuard = (env: Env, sql: string, ...values: unknown[]) =>
  env.DB.prepare(`INSERT INTO guard (state_conflict) SELECT 1 WHERE ${sql}`).bind(...values);

export interface AnonymizeResult {
  /** 새 이름(합쳐진 이름도 함께 바꿨으면 남은 사람의 것). */
  name: string;
  /** 함께 익명으로 바꾼 사람 수(이 사람에게 합쳐진 이름 포함). */
  count: number;
  /** 옛 이름이 그대로 들어 있는 경기 메모의 경기 번호. 메모는 자동으로 고치지 않는다(운영자가 확인). */
  memoMatchNos: number[];
}

/**
 * 참가자를 익명으로 바꾼다(되돌릴 수 없다). 확인 문구 "익명".
 * - 이름 → "탈퇴한 참가자 N"(모임 안에서 겹치지 않는 가장 작은 N), 보관, 기피 라인·티어 지움.
 * - 계정 연결·연결 링크·이 사람의 요청·참가 신청(옛 이름의 새 이름 신청 포함)을 지운다.
 * - 이 사람에게 합쳐진 이름(되돌리지 않은 합치기)도 각각 익명으로 바꾼다(옛 이름이 보관 목록에 남지 않게).
 * - 경기 기록(명단·승패·라인)·서포터 기록·변경 내역은 그대로다(다른 사람의 전적이 깨지지 않게). 변경 내역은 참가자 ID만 담는다.
 */
export async function anonymizeParticipant(
  env: Env,
  groupId: string,
  participantId: string,
  body: Body,
): Promise<AnonymizeResult> {
  assertOnlyKeys(body, ["requestId", "confirm"]);
  const requestId = requireString(body.requestId, "requestId", 8, 64);
  if (body.confirm !== ANONYMIZE_CONFIRM_TEXT) {
    throw new ApiError(400, "CONFIRM_REQUIRED", `확인 문구 '${ANONYMIZE_CONFIRM_TEXT}'를 입력해 주세요.`);
  }
  const { stored } = await runMutation(env, {
    groupId,
    requestId,
    op: "anonymize-participant",
    payload: { participantId },
    build: async () => {
      const person = await loadPerson(env, groupId, participantId);
      if (person.merged_into) throw mergedError();
      if (ANON_NAME_PATTERN.test(person.name)) {
        throw new ApiError(409, "ALREADY_ANONYMIZED", "이미 익명으로 바꾼 참가자예요.");
      }
      const all = await env.DB.prepare(
        `SELECT p.id, p.name, p.name_key, m.target_id AS merged_into
         FROM participants p LEFT JOIN participant_merges m ON m.source_id = p.id AND m.undone_at IS NULL
         WHERE p.group_id = ?1`,
      )
        .bind(groupId)
        .all<{ id: string; name: string; name_key: string; merged_into: string | null }>();
      // 이 사람과, 이 사람에게(이어서) 합쳐진 이름들.
      const targets = [person.id];
      for (let i = 0; i < targets.length; i++) {
        for (const p of all.results) if (p.merged_into === targets[i] && !targets.includes(p.id)) targets.push(p.id);
      }
      const byId = new Map(all.results.map((p) => [p.id, p]));
      const usedKeys = new Set(all.results.map((p) => p.name_key));
      const renames: { id: string; name: string; key: string; oldName: string; oldKey: string }[] = [];
      let n = 1;
      for (const id of targets) {
        let name = `${ANON_NAME_PREFIX} ${n}`;
        while (usedKeys.has(nameKey(name))) {
          n += 1;
          name = `${ANON_NAME_PREFIX} ${n}`;
        }
        usedKeys.add(nameKey(name));
        const old = byId.get(id)!;
        renames.push({ id, name, key: nameKey(name), oldName: old.name, oldKey: old.name_key });
      }
      // 옛 이름이 그대로 들어 있는 메모(운영자에게 알려만 준다).
      const memos = await env.DB.prepare(
        "SELECT match_no, memo FROM matches WHERE group_id = ?1 AND memo IS NOT NULL ORDER BY match_no",
      )
        .bind(groupId)
        .all<{ match_no: number; memo: string }>();
      const memoMatchNos = memos.results
        .filter((m) => renames.some((r) => m.memo.toLowerCase().includes(r.oldName.toLowerCase())))
        .map((m) => m.match_no);
      const ids = JSON.stringify(targets);
      const newKeys = JSON.stringify(renames.map((r) => r.key));
      const oldKeys = JSON.stringify(renames.map((r) => r.oldKey));
      const statements: D1PreparedStatement[] = [
        // 그 사이 합쳐졌거나 고른 이름이 생겼으면 막는다.
        stateGuard(
          env,
          "EXISTS (SELECT 1 FROM participant_merges WHERE source_id = ?1 AND undone_at IS NULL)",
          participantId,
        ),
        stateGuard(
          env,
          "EXISTS (SELECT 1 FROM participants WHERE group_id = ?1 AND name_key IN (SELECT value FROM json_each(?2)))",
          groupId,
          newKeys,
        ),
        ...renames.map((r) =>
          env.DB.prepare(
            `UPDATE participants SET name = ?1, name_key = ?2, status = 'archived', avoid_positions = NULL, skill_group = NULL, version = version + 1
             WHERE id = ?3 AND group_id = ?4`,
          ).bind(r.name, r.key, r.id, groupId),
        ),
        env.DB.prepare(
          "DELETE FROM participant_links WHERE group_id = ?1 AND participant_id IN (SELECT value FROM json_each(?2))",
        ).bind(groupId, ids),
        env.DB.prepare(
          "DELETE FROM participant_claims WHERE group_id = ?1 AND participant_id IN (SELECT value FROM json_each(?2))",
        ).bind(groupId, ids),
        env.DB.prepare(
          "DELETE FROM participant_requests WHERE group_id = ?1 AND participant_id IN (SELECT value FROM json_each(?2))",
        ).bind(groupId, ids),
        env.DB.prepare(
          `DELETE FROM join_requests WHERE group_id = ?1
             AND (participant_id IN (SELECT value FROM json_each(?2)) OR name_key IN (SELECT value FROM json_each(?3)))`,
        ).bind(groupId, ids, oldKeys),
      ];
      return {
        stored: { name: renames[0]!.name, count: renames.length, memoMatchNos },
        statements,
      };
    },
  });
  return stored as unknown as AnonymizeResult;
}
