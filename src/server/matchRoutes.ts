// 경기 API: 시작·지난 경기 입력·가져오기(구글 시트·기존 사이트 읽기, 지문, 묶음 제외), 경기 동작(결과·정정·메모·삭제 등),
// 날짜 일괄 정정, 진행 중 사람 교체, 시리즈 묶음. 원래 index.ts에서 두 군데로 떨어져 있던 것을 모았다.
// 경로끼리 겹치는 것이 없어(matches/:mid/:action은 두 칸, start·import 등은 한 칸) 등록 순서를 바꿔도 같은 경로로 간다.
import { fakeLoginEnabled, requireAccountId, requireOperator } from "./auth";
import { ApiError, readJsonBody } from "./http";
import { correctMatch, shiftMatchDates, SHIFT_DATES_BODY_BYTES } from "./matchCorrection";
import { MAX_IMPORT_BODY_BYTES, backfillMatch, importMatches, setImportBatchExcluded } from "./matchImport";
import { deleteMatch, excludeMatch, restoreMatch, undeleteMatch } from "./matchRemoval";
import { cancelMatch, confirmResult, endLater, replaceLiveParticipant, saveChampions, saveMemo, startMatch } from "./matches";
import { addToSeries, createSeries, removeFromSeries, updateSeries } from "./series";
import { clientIp } from "./ratelimit";
import { fixturesEnabled, listImportFingerprints, readSheet, registerFixture } from "./sheets";
import { readLegacy, registerLegacyFixture } from "./legacy";
import { spendHeavyRead } from "./routeKit";
import type { App } from "./routeKit";

export function registerMatchRoutes(app: App): void {
  app.post("/api/groups/:gid/matches/start", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    return c.json({ match: await startMatch(c.env, gid, await readJsonBody(c.req.raw)) });
  });

  app.post("/api/groups/:gid/matches/backfill", async (c) => {
    const gid = c.req.param("gid");
    const accountId = await requireOperator(c.env, c.req.raw, gid);
    const actor = { accountId, ip: clientIp(c.req.raw) };
    return c.json({ match: await backfillMatch(c.env, gid, await readJsonBody(c.req.raw), actor) });
  });

  app.post("/api/groups/:gid/matches/import", async (c) => {
    const gid = c.req.param("gid");
    const accountId = await requireOperator(c.env, c.req.raw, gid);
    const actor = { accountId, ip: clientIp(c.req.raw) };
    return c.json(
      await importMatches(c.env, gid, await readJsonBody(c.req.raw, MAX_IMPORT_BODY_BYTES), actor),
    );
  });

  // 구글 시트 읽기(내용은 저장하지 않고 돌려주기만 한다). src/server/sheets.ts
  app.post("/api/groups/:gid/sheets/read", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    return c.json(await readSheet(c.env, c.req.raw, await readJsonBody(c.req.raw)));
  });

  // 기존 사이트(v1) 기록 읽기(읽기만, 저장하지 않는다). src/server/legacy.ts
  app.post("/api/groups/:gid/legacy/read", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    return c.json(await readLegacy(c.env, c.req.raw, gid, await readJsonBody(c.req.raw)));
  });

  // 다시 가져오기에서 이미 들어간 경기를 가려내기 위한 지문 목록.
  app.get("/api/groups/:gid/imports/fingerprints", async (c) => {
    const gid = c.req.param("gid");
    const accountId = await requireOperator(c.env, c.req.raw, gid);
    await spendHeavyRead(c.env, c.req.raw, accountId, gid);
    return c.json(await listImportFingerprints(c.env, gid));
  });

  // 로컬 브라우저 테스트 전용 시트 내용 등록. AUTH_MODE=fake(운영 표시 없음)가 아니면 404.
  app.post("/api/test/sheet-fixture", async (c) => {
    // 환경(AUTH_MODE=fake, DEPLOY_ENV=local)과 요청 주소(로컬) 둘 다 맞아야 열린다(src/server/auth.ts).
    if (!fixturesEnabled(c.env) || !fakeLoginEnabled(c.env, c.req.raw)) {
      throw new ApiError(404, "NOT_FOUND", "찾을 수 없습니다.");
    }
    await requireAccountId(c.env, c.req.raw);
    return c.json(await registerFixture(c.env, await readJsonBody(c.req.raw, 600 * 1024)));
  });

  // 로컬 브라우저 테스트 전용 기존 사이트 응답 등록. 시트 내용 등록과 같은 조건이 아니면 404.
  app.post("/api/test/legacy-fixture", async (c) => {
    if (!fixturesEnabled(c.env) || !fakeLoginEnabled(c.env, c.req.raw)) {
      throw new ApiError(404, "NOT_FOUND", "찾을 수 없습니다.");
    }
    await requireAccountId(c.env, c.req.raw);
    return c.json(registerLegacyFixture(await readJsonBody(c.req.raw, 2.5 * 1024 * 1024)));
  });

  app.post("/api/groups/:gid/imports/:bid", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    return c.json(
      await setImportBatchExcluded(c.env, gid, c.req.param("bid"), await readJsonBody(c.req.raw)),
    );
  });

  const matchActions = {
    "end-later": endLater,
    result: confirmResult,
    cancel: cancelMatch,
    exclude: excludeMatch,
    restore: restoreMatch,
    correct: correctMatch,
    // 경기 메모(migrations/0016). 진행 중·결과 대기·확정 경기.
    memo: saveMemo,
    // 챔피언 기록(migrations/0025). 확정 경기만. 결과 입력 때 함께 고른 것은 result 요청의 champions로 온다.
    champions: saveChampions,
    // 경기 삭제·되살리기(migrations/0026). 정정·전적 제외와 같은 권한(대표·공동 운영자). 누가 했는지를 이력에 남기려고
    // 계정 ID를 받는다(다른 처리는 다섯째 인자를 쓰지 않는다).
    delete: deleteMatch,
    undelete: undeleteMatch,
  } as const;

  app.post("/api/groups/:gid/matches/:mid/:action", async (c) => {
    const gid = c.req.param("gid");
    const accountId = await requireOperator(c.env, c.req.raw, gid);
    const action = c.req.param("action");
    if (!Object.hasOwn(matchActions, action)) {
      throw new ApiError(404, "NOT_FOUND", "찾을 수 없습니다.");
    }
    const handler = matchActions[action as keyof typeof matchActions];
    return c.json({
      match: await handler(c.env, gid, c.req.param("mid"), await readJsonBody(c.req.raw), accountId),
    });
  });

  // 날짜 일괄 정정(2026-11-08, src/server/matchCorrection.ts shiftMatchDates). 운영자·공동 운영자. 화면 "날짜 점검".
  app.post("/api/groups/:gid/matches/shift-dates", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    // 경기 ID 500개(약 20KB)가 기본 상한 16KB를 넘으므로 이 경로만 넉넉히 받는다(2026-11-08 정합성 점검).
    return c.json(await shiftMatchDates(c.env, gid, await readJsonBody(c.req.raw, SHIFT_DATES_BODY_BYTES)));
  });

  // 진행 중 경기의 사람 교체(2026-11-07, src/server/matches.ts replaceLiveParticipant). 운영자·공동 운영자.
  app.patch("/api/groups/:gid/matches/:mid/roster", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    return c.json({
      match: await replaceLiveParticipant(c.env, gid, c.req.param("mid"), await readJsonBody(c.req.raw)),
    });
  });

  /* ---------------------------- 시리즈 묶음 ---------------------------- */
  // src/server/series.ts. 운영자·공동 운영자. 만들기는 확정 경기로, 시작 때 이어가기는 matches/start의 series 필드로.

  app.post("/api/groups/:gid/series", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    return c.json(await createSeries(c.env, gid, await readJsonBody(c.req.raw)));
  });

  const seriesActions = {
    add: addToSeries,
    remove: removeFromSeries,
    update: updateSeries,
  } as const;

  app.post("/api/groups/:gid/series/:sid/:action", async (c) => {
    const gid = c.req.param("gid");
    await requireOperator(c.env, c.req.raw, gid);
    const action = c.req.param("action");
    if (!Object.hasOwn(seriesActions, action)) {
      throw new ApiError(404, "NOT_FOUND", "찾을 수 없습니다.");
    }
    const handler = seriesActions[action as keyof typeof seriesActions];
    return c.json(await handler(c.env, gid, c.req.param("sid"), await readJsonBody(c.req.raw)));
  });
}
