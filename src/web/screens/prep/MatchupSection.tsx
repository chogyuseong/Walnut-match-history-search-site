import { matchupText, type LaneMatchup } from "../../../shared/prepTools";
import { PosLabel } from "../../ui";

/** 라인 맞대결: 지난 확정 경기에서 같은 라인의 두 사람이 서로 다른 팀으로 만난 전적(왼쪽 = 블루팀 사람 기준). */
export function MatchupSection(props: { matchups: LaneMatchup[]; nameOf: (key: string) => string }) {
  const { matchups, nameOf } = props;
  return (
    <section className="prep-tools" aria-label="라인 맞대결">
      <h2>라인 맞대결</h2>
      <p className="hint">지난 확정 경기에서 서로 다른 팀으로 만난 전적이에요(블루팀 사람 기준).</p>
      <ul className="list" aria-label="라인 맞대결 목록">
        {matchups.map((m) => (
          // 좁은 화면에서는 전적을 다음 줄로 내려 이름이 짧아도 잘리지 않게 한다(styles.css .matchup-row).
          <li key={m.position} className="list-row static matchup-row">
            <PosLabel position={m.position} />
            <span className="name">
              {m.leftKey ? nameOf(m.leftKey) : "(비어 있음)"} vs {m.rightKey ? nameOf(m.rightKey) : "(비어 있음)"}
            </span>
            <span className="stat">{matchupText(m)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
