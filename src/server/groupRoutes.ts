// 모임 API: 만들기·스냅숏·이름·참가자·설정·서포터 횟수·시즌·조회 토큰, 백업 복원, 모임·계정 삭제, 중복 참가자 합치기,
// 백업 내려받기, 편성 넘기기. 쓰기 경로는 index.ts 공통 앞단이 운영자·점검·모임 세대를 먼저 확인한다.
import { saveSupportCounts } from "./supportCounts";
import { clearDraftHandoff, putDraftHandoff, readDraftHandoff } from "./draftHandoff";
import { clearSessionCookie, readSession, requireAccountId, requireOperator, requireOwner } from "./auth";
import { closeSession, saveSettings, startNewCycle } from "./groupSettings";
import { createGroup, regenerateViewToken, renameGroup } from "./groups";
import { createSeason, deleteSeason } from "./seasons";
import { ensureParticipants, saveSkillGroups, SKILL_GROUPS_BODY_BYTES, updateParticipant } from "./participants";
import { exportBackup } from "./backupExport";
import { ApiError, readJsonBody, readOptionalJsonBody } from "./http";
import { deleteAccount, deleteGroup } from "./deletion";
import { mergeParticipants, previewMerge, undoMerge } from "./merge";
import { clientIp } from "./ratelimit";
import { applyRestore, importAsNewGroup, previewRestore } from "./restore";
import { etagMatches, loadEtagHead, snapshotBody, snapshotEtag } from "./snapshot";
import { REVALIDATE, CLEAR_CACHE, countSnapshot, spendHeavyRead, confirmIdentity } from "./routeKit";
import type { App } from "./routeKit";

export function registerGroupRoutes(app: App): void {
  app.post("/api/groups", async (c) => {
    const accountId = await requireAccountId(c.env, c.req.raw);
    return c.json(await createGroup(c.env, accountId, await readJsonBody(c.req.raw)));
  });

  // 운영자 스냅숏. ETag(모임 행 1행만 읽어 계산)가 화면이 가진 것과 같으면 304로 답해 나머지를 읽지 않는다.
  // 응답 본문은 예전과 같다(헤더만 더함). 브라우저 fetch는 304를 저장해 둔 본문으로 바꿔 주므로 화면 변경이 필요 없다.
  // 요청 수 제한(snapshot-account·snapshot-ip)은 304가 아닐 때만 센다(countSnapshot).
  app.get("/api/groups/:gid/snapshot", async (c) => {
    const gid = c.req.param("gid");
    const accountId = await requireOperator(c.env, c.req.raw, gid);
    const head = await loadEtagHead(c.env, gid);
    if (!head) throw new ApiError(404, "NOT_FOUND", "모임을 찾을 수 없습니다.");
    const etag = await snapshotEtag(c.env, head, "operator");
    const notModified = etagMatches(c.req.header("If-None-Match"), etag);
    if (!notModified) await countSnapshot(c.env, c.req.raw, accountId, head);
    c.header("ETag", etag);
    c.header("Cache-Control", REVALIDATE);
    if (notModified) return c.body(null, 304);
    return c.json(await snapshotBody(c.env, gid, "operator", etag));
  });

  app.patch("/api/groups/:gid", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    await renameGroup(c.env, gid, await readJsonBody(c.req.raw));
    return c.json({ ok: true });
  });

  app.post("/api/groups/:gid/participants", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    return c.json({
      participants: await ensureParticipants(c.env, gid, await readJsonBody(c.req.raw)),
    });
  });

  // 여러 사람의 티어를 한 번에(src/server/participants.ts saveSkillGroups). 화면 "티어 배정 → 기록으로 제안받기"의 적용.
  app.post("/api/groups/:gid/participants/skill-groups", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    await saveSkillGroups(c.env, gid, await readJsonBody(c.req.raw, SKILL_GROUPS_BODY_BYTES));
    return c.json({ ok: true });
  });

  app.patch("/api/groups/:gid/participants/:pid", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    await updateParticipant(c.env, gid, c.req.param("pid"), await readJsonBody(c.req.raw));
    return c.json({ ok: true });
  });

  app.put("/api/groups/:gid/settings", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    await saveSettings(c.env, gid, await readJsonBody(c.req.raw));
    return c.json({ ok: true });
  });

  app.post("/api/groups/:gid/rotation/new-cycle", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    await startNewCycle(c.env, gid, await readJsonBody(c.req.raw));
    return c.json({ ok: true });
  });

  // 서포터 횟수 직접 입력: 여러 사람의 횟수를 한 번에 정한다(운영자·공동 운영자).
  app.post("/api/groups/:gid/rotation/counts", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    await saveSupportCounts(c.env, gid, await readJsonBody(c.req.raw));
    return c.json({ ok: true });
  });

  app.post("/api/groups/:gid/session/close", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    await closeSession(c.env, gid, await readJsonBody(c.req.raw));
    return c.json({ ok: true });
  });

  app.post("/api/groups/:gid/seasons", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    return c.json(await createSeason(c.env, gid, await readJsonBody(c.req.raw)));
  });

  app.delete("/api/groups/:gid/seasons/:sid", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    await deleteSeason(c.env, gid, c.req.param("sid"), await readOptionalJsonBody(c.req.raw));
    return c.json({ ok: true });
  });

  app.post("/api/groups/:gid/view-token", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    return c.json({ viewToken: await regenerateViewToken(c.env, gid, await readOptionalJsonBody(c.req.raw)) });
  });

  /* ---------------------------- 백업 복원 ---------------------------- */

  // 검증과 요약만 한다(아무것도 쓰지 않음). 복원은 대표 운영자만 한다.
  app.post("/api/groups/:gid/restore/preview", async (c) => {
    const gid = c.req.param("gid");
    await requireOwner(c.env, c.req.raw, gid);
    return c.json(await previewRestore(c.env, gid, c.req.raw));
  });

  // 같은 모임 복구. 운영자·공동 운영자·조회 토큰은 바뀌지 않는다. 대표 운영자만.
  app.post("/api/groups/:gid/restore", async (c) => {
    const gid = c.req.param("gid");
    const accountId = await requireOwner(c.env, c.req.raw, gid);
    return c.json(
      await applyRestore(c.env, gid, c.req.raw, { accountId, ip: clientIp(c.req.raw) }, (password) =>
        confirmIdentity(c.env, c.req.raw, password),
      ),
    );
  });

  // 다른 모임(또는 빈 환경)의 백업을 새 모임으로 가져온다.
  app.post("/api/restore/new-group", async (c) => {
    const accountId = await requireAccountId(c.env, c.req.raw);
    return c.json(await importAsNewGroup(c.env, accountId, c.req.raw, clientIp(c.req.raw)));
  });

  /* ---------------------------- 모임·계정 삭제 ---------------------------- */

  // 모임 삭제(되돌릴 수 없음). 화면이 실행 직전에 백업을 내려받는다. 대표 운영자만.
  app.post("/api/groups/:gid/delete", async (c) => {
    const gid = c.req.param("gid");
    await requireOwner(c.env, c.req.raw, gid);
    const { password, ...body } = await readJsonBody(c.req.raw);
    await confirmIdentity(c.env, c.req.raw, password);
    return c.json(await deleteGroup(c.env, gid, body));
  });

  // 계정 삭제(탈퇴). 운영 중인 모임이 있으면 거절한다. 성공하면 세션 쿠키를 지운다.
  app.post("/api/account/delete", async (c) => {
    const session = await readSession(c.env, c.req.raw);
    if (!session) throw new ApiError(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
    const accountId = session.id;
    const body = await readJsonBody(c.req.raw);
    // 세션 쿠키만 훔친 사람이 계정을 지우지 못하게 본인을 한 번 더 확인한다(자체 계정은 비밀번호, 카카오·Google은 최근 로그인).
    await confirmIdentity(c.env, c.req.raw, body.password);
    delete body.password;
    await deleteAccount(c.env, accountId, body);
    c.header("Set-Cookie", clearSessionCookie(c.env));
    c.header("Clear-Site-Data", CLEAR_CACHE);
    return c.json({ ok: true });
  });

  /* ---------------------------- 중복 참가자 합치기 ---------------------------- */

  // 미리보기: 옮길 경기 수, 겹치는 경기, 합친 뒤 승패·배치·칭호. 아무것도 쓰지 않는다.
  app.get("/api/groups/:gid/merges/preview", async (c) => {
    const gid = c.req.param("gid");
    const accountId = await requireOperator(c.env, c.req.raw, gid);
    await spendHeavyRead(c.env, c.req.raw, accountId, gid);
    return c.json(
      await previewMerge(c.env, gid, { sourceId: c.req.query("source"), targetId: c.req.query("target") }),
    );
  });

  app.post("/api/groups/:gid/merges", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    return c.json(await mergeParticipants(c.env, gid, await readJsonBody(c.req.raw)));
  });

  app.post("/api/groups/:gid/merges/:mid/undo", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    return c.json(await undoMerge(c.env, gid, c.req.param("mid"), await readJsonBody(c.req.raw)));
  });

  app.get("/api/groups/:gid/export", async (c) => {
    const gid = c.req.param("gid");
    const accountId = await requireOperator(c.env, c.req.raw, gid);
    await spendHeavyRead(c.env, c.req.raw, accountId, gid);
    return c.json(await exportBackup(c.env, gid));
  });

  /* ---------------------------- 편성 넘기기 ---------------------------- */
  // 다른 기기·공동 운영자에게 편성 초안을 건넨다(src/server/draftHandoff.ts). 운영자만. 쓰기 둘은 공통 앞단이 운영자·세대를 확인한다.

  app.put("/api/groups/:gid/draft-handoff", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    return c.json(await putDraftHandoff(c.env, gid, c.req.raw));
  });

  app.get("/api/groups/:gid/draft-handoff", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    return c.json(await readDraftHandoff(c.env, gid));
  });

  app.delete("/api/groups/:gid/draft-handoff", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    await clearDraftHandoff(c.env, gid, c.req.query("id"));
    return c.json({ ok: true });
  });
}
