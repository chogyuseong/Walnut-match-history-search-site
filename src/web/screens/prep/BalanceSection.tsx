import { balanceText, type DraftBalance } from "../../../shared/prepTools";
import { priorityLabel } from "../../../shared/priority";
import { prepTeamName } from "./common";

/** 편성 균형(접힘): 두 팀 티어 점수 합과 티어별 인원. 티어는 운영자만 보는 정보다. */
export function BalanceSection(props: { balance: DraftBalance }) {
  const { balance } = props;
  return (
    <details>
      <summary>편성 균형</summary>
      <p>
        {prepTeamName("A")} 티어 점수 {balance.sumA} · {prepTeamName("B")} {balance.sumB} ·{" "}
        <strong>{balanceText(balance, [prepTeamName("A"), prepTeamName("B")])}</strong>
      </p>
      <ul className="list" aria-label="티어별 인원">
        {balance.counts.map((c) => (
          <li key={c.priority ?? "none"} className="list-row static">
            <span>{priorityLabel(c.priority)}</span>
            <span className="stat">
              블루 {c.a} · 레드 {c.b}
            </span>
          </li>
        ))}
      </ul>
      <p className="hint">
        {balance.assigned === 0
          ? "티어를 정한 사람이 없어 점수가 모두 0이에요."
          : "점수는 균형 팀 추천과 같은 방식이에요(티어 가중치, 미지정은 정한 사람들의 가운데 값)."}{" "}
        티어는 운영자에게만 보이고 편성 이미지에는 넣지 않아요.
      </p>
    </details>
  );
}
