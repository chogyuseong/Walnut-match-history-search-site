// 사람을 모임에 잇는 API: 운영자 넘기기, 공동 운영자 초대·나가기, 참가 신청 링크(공개 경로 포함), 참가자 본인 연결과 멤버 경로.
import { readSession, requireAccountId, requireMember, requireOperator, requireOwner } from "./auth";
import { acceptCoInvite, coInviteInfo, createCoInvite, listCoOperators, removeCoOperator } from "./coOperators";
import { acceptTransfer, createTransfer, transferInfo } from "./operatorTransfer";
import { ApiError, assertOnlyKeys, readJsonBody, readOptionalJsonBody } from "./http";
import { clearJoinEntries, createJoinLink, joinAdd, joinAdminView, joinCancel, joinInfoConditional, removeJoinEntry, setJoinOpen } from "./join";
import { acceptClaim, anonymizeParticipant, claimInfo, createClaimLink, createMemberRequest, memberSnapshot, memberSnapshotEtag, resolveMemberRequest, setOwnAvoid, unlinkByOperator, unlinkSelf } from "./members";
import { clientIp, hit } from "./ratelimit";
import { etagMatches } from "./snapshot";
import { REVALIDATE, countSnapshot, confirmIdentity } from "./routeKit";
import type { App } from "./routeKit";

export function registerMemberRoutes(app: App): void {
  /* ---------------------------- 운영자 교체 ---------------------------- */

  app.post("/api/groups/:gid/transfer", async (c) => {
    const gid = c.req.param("gid");
    await requireOwner(c.env, c.req.raw, gid);
    // 본문: { password }(자체 계정만 필요). 본문 없이 보내던 예전 요청은 비밀번호 없는 계정에서 그대로 된다.
    const body = await readOptionalJsonBody(c.req.raw);
    assertOnlyKeys(body, ["password"]);
    await confirmIdentity(c.env, c.req.raw, body.password);
    return c.json(await createTransfer(c.env, gid));
  });

  app.get("/api/transfer/:token", async (c) => c.json(await transferInfo(c.env, c.req.param("token"))));

  app.post("/api/transfer/:token/accept", async (c) => {
    const accountId = await requireAccountId(c.env, c.req.raw);
    return c.json(await acceptTransfer(c.env, accountId, c.req.param("token")));
  });

  /* ---------------------------- 공동 운영자 ---------------------------- */
  // src/server/coOperators.ts. 초대·목록·내보내기는 대표 운영자만, 나가기는 공동 운영자 본인.

  app.get("/api/groups/:gid/co-operators", async (c) => {
    const gid = c.req.param("gid");
    await requireOwner(c.env, c.req.raw, gid);
    return c.json(await listCoOperators(c.env, gid));
  });

  app.post("/api/groups/:gid/co-operators/invite", async (c) => {
    const gid = c.req.param("gid");
    await requireOwner(c.env, c.req.raw, gid);
    return c.json(await createCoInvite(c.env, gid));
  });

  // 공동 운영자가 스스로 나간다. 대표 운영자는 나갈 수 없다(넘기거나 삭제).
  app.post("/api/groups/:gid/co-operators/leave", async (c) => {
    const gid = c.req.param("gid");
    const accountId = await requireOperator(c.env, c.req.raw, gid);
    await removeCoOperator(c.env, gid, accountId);
    return c.json({ ok: true });
  });

  app.delete("/api/groups/:gid/co-operators/:aid", async (c) => {
    const gid = c.req.param("gid");
    await requireOwner(c.env, c.req.raw, gid);
    await removeCoOperator(c.env, gid, c.req.param("aid"));
    return c.json({ ok: true });
  });

  app.get("/api/co-invite/:token", async (c) => c.json(await coInviteInfo(c.env, c.req.param("token"))));

  app.post("/api/co-invite/:token/accept", async (c) => {
    const accountId = await requireAccountId(c.env, c.req.raw);
    return c.json(await acceptCoInvite(c.env, accountId, c.req.param("token")));
  });

  /* ---------------------------- 참가 신청 링크 ---------------------------- */
  // src/server/join.ts. 운영 경로는 대표·공동 운영자, 공개 경로(/api/join/:token)는 로그인 없음.

  app.get("/api/groups/:gid/join", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    return c.json(await joinAdminView(c.env, gid));
  });

  // 만들기·다시 만들기(이전 링크 무효). 토큰 원문은 이 응답에서 한 번만 준다.
  app.post("/api/groups/:gid/join/link", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    return c.json(await createJoinLink(c.env, gid));
  });

  app.post("/api/groups/:gid/join/open", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    await setJoinOpen(c.env, gid, await readJsonBody(c.req.raw));
    return c.json(await joinAdminView(c.env, gid));
  });

  app.post("/api/groups/:gid/join/clear", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    await clearJoinEntries(c.env, gid, await readJsonBody(c.req.raw));
    return c.json(await joinAdminView(c.env, gid));
  });

  app.post("/api/groups/:gid/join/remove", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    await removeJoinEntry(c.env, gid, await readJsonBody(c.req.raw));
    return c.json(await joinAdminView(c.env, gid));
  });

  // 로그인 없이도 쓴다. 로그인한 멤버면 계정을 넘겨 본인 확인 신청·내 이름 표시에 쓴다(src/server/join.ts).
  // 조건부 요청: 링크 행 1행으로 ETag를 만들고, 같으면 304(명단·신청을 읽지 않는다).
  app.get("/api/join/:token", async (c) => {
    const accountId = (await readSession(c.env, c.req.raw))?.id ?? null;
    // 요청 수 제한(view-ip)은 304가 아닐 때만 센다(joinInfoConditional의 count, 조회 링크와 같은 방식).
    const result = await joinInfoConditional(
      c.env,
      c.req.param("token"),
      accountId,
      c.req.header("If-None-Match") ?? null,
      () => hit(c.env, "view-ip", clientIp(c.req.raw)),
    );
    c.header("ETag", result.etag);
    c.header("Cache-Control", REVALIDATE);
    // 로그인 여부에 따라 본문이 다르다(ETag에 계정을 넣었다). 중간 캐시가 섞지 않게 알린다.
    c.header("Vary", "Cookie");
    if (result.notModified) return c.body(null, 304);
    return c.json(result.view);
  });

  app.post("/api/join/:token", async (c) =>
    c.json(
      await joinAdd(
        c.env,
        c.req.param("token"),
        await readJsonBody(c.req.raw),
        (await readSession(c.env, c.req.raw))?.id ?? null,
      ),
    ),
  );

  app.post("/api/join/:token/cancel", async (c) =>
    c.json(
      await joinCancel(
        c.env,
        c.req.param("token"),
        await readJsonBody(c.req.raw),
        (await readSession(c.env, c.req.raw))?.id ?? null,
      ),
    ),
  );

  /* ---------------------------- 참가자 본인 연결 · 멤버 ---------------------------- */
  // src/server/members.ts. 연결 링크 만들기·끊기·요청 처리·익명 처리는 운영자(대표·공동, 공통 앞단 requireOperator).
  // 멤버 경로(/api/member/:gid/...)는 운영자 경로와 따로 requireMember로만 연다(운영자 경로는 멤버에게 열리지 않는다).

  app.post("/api/groups/:gid/participants/:pid/claim-link", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    return c.json(await createClaimLink(c.env, gid, c.req.param("pid")));
  });

  app.delete("/api/groups/:gid/participants/:pid/link", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    await unlinkByOperator(c.env, gid, c.req.param("pid"), await readOptionalJsonBody(c.req.raw));
    return c.json({ ok: true });
  });

  app.post("/api/groups/:gid/participants/:pid/anonymize", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    return c.json(await anonymizeParticipant(c.env, gid, c.req.param("pid"), await readJsonBody(c.req.raw)));
  });

  app.post("/api/groups/:gid/member-requests/:rid/resolve", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    await resolveMemberRequest(c.env, gid, c.req.param("rid"), await readJsonBody(c.req.raw));
    return c.json({ ok: true });
  });

  app.get("/api/claim/:token", async (c) => c.json(await claimInfo(c.env, c.req.param("token"))));

  app.post("/api/claim/:token/accept", async (c) => {
    const accountId = await requireAccountId(c.env, c.req.raw);
    return c.json(await acceptClaim(c.env, accountId, c.req.param("token")));
  });

  // 멤버 스냅숏. 운영자 스냅숏과 같은 조건부 요청(ETag는 members.ts memberSnapshotEtag: 조회 재료 + 계정·참가자)과
  // 요청 수 제한(200만 셈). 본문이 계정마다 다르므로 Vary: Cookie를 붙인다(참가 신청 공개 조회와 같다).
  app.get("/api/member/:gid/snapshot", async (c) => {
    const ctx = await requireMember(c.env, c.req.raw, c.req.param("gid"));
    const found = await memberSnapshotEtag(c.env, ctx);
    if (!found) throw new ApiError(404, "NOT_FOUND", "모임을 찾을 수 없습니다.");
    const { etag, head } = found;
    const notModified = etagMatches(c.req.header("If-None-Match"), etag);
    if (!notModified) await countSnapshot(c.env, c.req.raw, ctx.accountId, head);
    c.header("ETag", etag);
    c.header("Cache-Control", REVALIDATE);
    c.header("Vary", "Cookie");
    if (notModified) return c.body(null, 304);
    return c.json(await memberSnapshot(c.env, ctx));
  });

  app.put("/api/member/:gid/avoid", async (c) => {
    const ctx = await requireMember(c.env, c.req.raw, c.req.param("gid"));
    await setOwnAvoid(c.env, ctx, await readJsonBody(c.req.raw));
    return c.json({ ok: true });
  });

  app.post("/api/member/:gid/requests", async (c) => {
    const ctx = await requireMember(c.env, c.req.raw, c.req.param("gid"));
    return c.json(await createMemberRequest(c.env, ctx, await readJsonBody(c.req.raw)));
  });

  app.post("/api/member/:gid/unlink", async (c) => {
    const ctx = await requireMember(c.env, c.req.raw, c.req.param("gid"));
    await unlinkSelf(c.env, ctx);
    return c.json({ ok: true });
  });
}
