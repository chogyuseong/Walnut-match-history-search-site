// 조회 링크(로그인 없음) API. 읽기만 하고, 304면 요청 수를 세지 않는다.
import { ApiError } from "./http";
import { clientIp, hit, spendSnapshotRows } from "./ratelimit";
import { etagMatches, loadEtagHeadByViewToken, snapshotBody, snapshotEtag } from "./snapshot";
import { REVALIDATE } from "./routeKit";
import type { App } from "./routeKit";

export function registerViewRoutes(app: App): void {
  // 조회 토큰은 읽기만 허용한다. 수정 경로는 모두 운영자 확인을 거친다.
  // 조건부 요청: 토큰으로 모임 행 1행을 읽어 ETag를 만들고, 같으면 304(경기·명단을 읽지 않는다).
  // 조회 토큰을 다시 만들면 예전 토큰은 행을 찾지 못해 404다(ETag가 같아도 304를 주지 않는다).
  // 요청 수 제한(view-ip)은 304가 아닐 때만 센다: 없는 토큰(404, 토큰 맞히기 방지)과 본문을 만드는 200.
  app.get("/api/view/:token", async (c) => {
    const count = () => hit(c.env, "view-ip", clientIp(c.req.raw));
    const head = await loadEtagHeadByViewToken(c.env, c.req.param("token"));
    if (!head) {
      await count();
      throw new ApiError(404, "NOT_FOUND", "모임을 찾을 수 없습니다.");
    }
    const etag = await snapshotEtag(c.env, head, "viewer");
    const notModified = etagMatches(c.req.header("If-None-Match"), etag);
    // 세기(429일 수 있음)를 ETag 헤더보다 먼저 한다: 429 응답에 ETag·private가 붙어 브라우저가 저장하면
    // 다음 304가 그 429 본문을 되살릴 수 있다.
    if (!notModified) {
      await count();
      await spendSnapshotRows(c.env, { ip: clientIp(c.req.raw), viewGroupId: head.id }, head.next_match_no - 1);
    }
    c.header("ETag", etag);
    c.header("Cache-Control", REVALIDATE);
    if (notModified) return c.body(null, 304);
    // 칭호 구간·점검 여부는 buildSnapshot의 조회용 허용 목록에서 붙는다(snapshot.ts의 viewerSettings).
    return c.json(await snapshotBody(c.env, head.id, "viewer", etag));
  });
}
