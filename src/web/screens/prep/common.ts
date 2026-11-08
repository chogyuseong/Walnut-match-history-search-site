// 준비 화면(src/web/screens/Prep.tsx)의 구역들이 함께 쓰는 작은 도우미. 다른 prep 파일을 import하지 않는다(순환 방지).
import type { Team } from "../../../shared/types";
import { josa, teamName } from "../../format";

/** 준비 화면의 팀 이름. 팀 A(왼쪽)는 항상 블루팀, 팀 B(오른쪽)는 레드팀이다(src/shared/draft.ts teamASide). */
export const prepTeamName = (team: Team): string => teamName(team, "blue");

/** "레드팀은 모두 서포터를 배정받았어요." · 두 팀이면 한 문장으로. 다음 행동(초기화)을 함께 안내한다. */
export function allAssignedText(teams: readonly Team[]): string {
  const name = prepTeamName(teams[0]!);
  const who = teams.length >= 2 ? "두 팀 모두" : `${name}${josa(name, ["은", "는"])} 모두`;
  return `${who} 서포터를 배정받았어요. 서포터 횟수 초기화를 누르면 다시 처음부터 돌아가요.`;
}
