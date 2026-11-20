// 변경 내역 줄의 글: 종류 이름, 경기 삭제·되살리기 줄 알아보기, 바뀐 항목 이름.
// 기록 화면 변경 내역(Records.tsx)과 경기 상세 변경 내역(MatchDetail.tsx)이 같은 글을 쓴다. 서버 kind를 새로 만들면 REVISION_LABEL에 더한다.
import type { MatchView, RevisionView } from "../../shared/types";
import { teamName } from "../format";

export const REVISION_LABEL: Record<string, string> = {
  start: "경기 시작",
  end: "경기 종료(결과 미입력)",
  result: "결과 확정",
  correction: "정정",
  exclude: "전적 제외",
  restore: "복구",
  cancel: "미진행 취소",
  backfill: "지난 경기 입력",
};

/**
 * 경기 삭제·되살리기 줄(src/server/matchRemoval.ts deleteMatch가 kind "correction"에 changes.deleted로 남긴다)이면
 * 지운 줄은 true, 되살린 줄은 false. 그 밖의 줄은 null.
 */
export function deletionOf(r: RevisionView): boolean | null {
  const change = r.changes.deleted;
  return change ? change.to === true : null;
}

/** 삭제·되살리기 줄의 changes.by(누가 했는지). 계정은 남기지 않고 역할만 남는다. */
export const DELETED_BY_LABEL: Record<string, string> = { owner: "대표 운영자", co: "공동 운영자" };

export function changeText(key: string, nameOf: (id: string) => string, match: MatchView | undefined): string {
  if (key === "winnerTeam") return "승리 팀";
  if (key === "teamASide") return "진영";
  if (key === "playedAt") return "경기 시각";
  if (key === "participant") return "참가자";
  if (key === "state") return "상태";
  if (key.startsWith("position:")) return `${nameOf(key.slice(9))}의 포지션`;
  if (key.startsWith("rotation:")) {
    const team = key.slice(9);
    const name = team === "A" || team === "B" ? teamName(team, match?.teamASide) : `팀 ${team}`;
    return `${name} 서포터 횟수 기록`;
  }
  return key;
}
