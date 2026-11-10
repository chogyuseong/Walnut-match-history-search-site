import { Help } from "../../screenKit";
import type { ReactNode } from "react";
import type { RotationContext } from "../../../shared/rotation";
import { TEAMS } from "../../../shared/types";
import { go } from "../../useApp";
import type { PrepEditing } from "./usePrepEditing";

/**
 * 버튼 설명. 버튼의 title 풍선은 터치 화면에서 뜨지 않아 같은 글을 섞기 구역 맨 아래 접힌 "버튼 설명"에 모아 둔다
 * (2026-11-10, 버튼마다 글을 늘리면 폰에서 섞기 버튼이 편성 판에서 멀어진다). 한 곳에서 고치면 둘 다 바뀐다.
 */
const TIP = {
  teamShuffle: "10명을 두 팀으로 새로 나누고 라인도 섞어요. 같은 티어끼리는 양 팀에 고르게 나뉘어요.",
  recommend: "티어 합이 비슷한 편성 3개를 보여 줘요. 골라서 적용해요.",
  lineShuffle: "팀원은 그대로 두고 팀 안에서 라인만 섞어요.",
  fairShuffle: "라인을 섞은 뒤, 팀마다 서포터를 아직 안 간 사람으로 정해요.",
  draw: "팀마다 서포터를 아직 안 간 사람과 맞바꿔요. 나머지 8명은 그대로예요.",
  swapSides: "블루팀 5명과 레드팀 5명을 통째로 맞바꿔요. 라인·고정·서포터는 사람을 따라가요.",
  priority: "사람마다 1~5티어를 정해요. 팀·라인 모두 섞기와 균형 팀 추천이 티어를 봐요.",
  avoid: "사람마다 못 가는 라인을 정해요. 라인을 섞을 때 그 라인을 되도록 피해요.",
  supportCount: "이번 주기에 서포터로 간 횟수. 서폿 돌아가며·서포터만 바꾸기가 이 횟수를 봐요. 누르면 바로 아래에 펼쳐져요.",
  needsReset: "한 팀이 모두 서포터를 배정받았어요. 펼쳐서 초기화할 수 있어요.",
  randomSide: "반반 확률로 블루팀과 레드팀을 맞바꿔요.",
} as const;

/** 섞기 구역: 팀을 새로 짜기(팀·라인 모두 섞기, 균형 팀 추천)와 팀은 그대로(라인·서포터 섞기, 진영 바꾸기). */
export function ShuffleSection(props: {
  ctx: RotationContext;
  edit: PrepEditing;
  /** 서포터 횟수 버튼과 그 아래 펼쳐지는 판(서포터 돌아가며가 꺼져 있으면 없음). */
  support?: { label: string; open: boolean; needsReset: boolean; onToggle: () => void; panel: ReactNode };
}) {
  const { ctx, edit, support } = props;
  const hasAvoid = Object.keys(edit.avoidMap).length > 0;
  return (
    <section className="prep-tools" aria-label="섞기">
      <h2>섞기</h2>
      <p className="row-label">팀을 새로 짜기</p>
      <div className="button-row">
        <button
          type="button"
          className="secondary"
          title={TIP.teamShuffle}
          onClick={edit.runTeamShuffle}
        >
          팀·라인 모두 섞기
        </button>
        <button
          type="button"
          className="secondary"
          title={TIP.recommend}
          onClick={edit.showRecommendations}
        >
          균형 팀 추천
        </button>
      </div>
      <p className="row-label">팀은 그대로</p>
      <div className="button-row">
        <button
          type="button"
          className="secondary"
          title={TIP.lineShuffle}
          onClick={() => edit.runShuffle(false)}
        >
          라인만 섞기
        </button>
        {ctx.enabled && (
          <button
            type="button"
            className="secondary"
            title={TIP.fairShuffle}
            onClick={() => edit.runShuffle(true)}
          >
            라인 섞기 + 서폿 돌아가며
          </button>
        )}
        {ctx.enabled && (
          <button
            type="button"
            className="secondary"
            title={TIP.draw}
            onClick={() => edit.runDraw(TEAMS)}
          >
            서포터만 바꾸기
          </button>
        )}
        <button
          type="button"
          className="secondary"
          title={TIP.swapSides}
          onClick={edit.swapTeamSides}
        >
          진영 바꾸기
        </button>
      </div>
      {edit.avoidNote && (
        <p className="note" role="status">
          {edit.avoidNote}
        </p>
      )}
      {edit.noPriorityNote && (
        <p className="note" role="status">
          티어를 정한 사람이 없어 무작위로 나눴어요.{" "}
          <button type="button" className="link" onClick={() => go("/priority")}>
            티어 배정하기
          </button>
        </p>
      )}
      {/* 안내문은 줄마다 짧은 꼬리표(.row-label)만 남기고 설명은 맨 아래 도움말 하나에 모았다(2026-11-08 위계 정리).
          순서(2026-11-08 화면 점검): 자주 누르는 섞기 줄을 위에, 가끔 바꾸는 "섞기 기준" 줄을 그 아래에 둔다.
          "섞기 기준" 버튼은 다른 섞기 버튼과 같은 크기다. 이름은 그대로라 브라우저 테스트의 선택자가 바뀌지 않는다. */}
      <p className="row-label">섞기 기준</p>
      <div className="button-row">
        <button
          type="button"
          className="secondary"
          title={TIP.priority}
          onClick={() => go("/priority")}
        >
          티어 배정
        </button>
        <button
          type="button"
          className="secondary"
          title={TIP.avoid}
          onClick={() => go("/priority/avoid")}
        >
          기피 라인
        </button>
        {support && (
          <button
            type="button"
            className="secondary"
            aria-expanded={support.open}
            aria-controls="support-count-panel"
            title={TIP.supportCount}
            onClick={support.onToggle}
          >
            {support.label}
            {support.needsReset && (
              <span className="badge warn-badge" title={TIP.needsReset}>
                초기화 필요
              </span>
            )}
          </button>
        )}
      </div>
      {support?.panel}
      {hasAvoid && (
        <p className="hint">
          기피 라인을 정한 사람은 라인을 섞을 때 그 라인을 되도록 피해요. 서폿 돌아가며·서포터만 바꾸기는 서포터 횟수 규칙이
          먼저예요.
        </p>
      )}
      <Help>
        <p>고정한 포지션은 어떤 섞기에서도 지켜요. 잘못 눌렀으면 "직전 편성으로"로 최근 5단계까지 되돌릴 수 있어요.</p>
        <p>섞기 기준: 티어·기피 라인·서포터 횟수를 정해 두면 섞기가 그에 맞춰요.</p>
        <p>팀을 새로 짜기: 같은 티어끼리는 양 팀에 나뉘어요. 팀은 그대로: 팀원은 바뀌지 않아요.</p>
        {ctx.enabled && <p>'서폿 돌아가며'와 '서포터만 바꾸기'는 팀마다 서포터를 아직 안 간 사람으로 정해요.</p>}
      </Help>
      {/* "이름 — 설명" 꼴: 버튼 이름 바로 뒤에 쌍점을 쓰면 "서포터 횟수: 2명 기록" 같은 버튼 글과 겹쳐 읽힌다. */}
      <Help label="버튼 설명">
        <p>팀·라인 모두 섞기 — {TIP.teamShuffle}</p>
        <p>균형 팀 추천 — {TIP.recommend}</p>
        <p>라인만 섞기 — {TIP.lineShuffle}</p>
        {ctx.enabled && <p>라인 섞기 + 서폿 돌아가며 — {TIP.fairShuffle}</p>}
        {ctx.enabled && <p>서포터만 바꾸기 — {TIP.draw}</p>}
        <p>진영 바꾸기 — {TIP.swapSides}</p>
        <p>티어 배정 — {TIP.priority}</p>
        <p>기피 라인 — {TIP.avoid}</p>
        {support && <p>서포터 횟수 — {TIP.supportCount}</p>}
        {support?.needsReset && <p>초기화 필요 — {TIP.needsReset}</p>}
        <p>진영 랜덤 — {TIP.randomSide}</p>
      </Help>
    </section>
  );
}

/** 진영 구역: 진영 랜덤(반반으로 두 팀을 맞바꿈). */
export function SideSection(props: { edit: PrepEditing }) {
  return (
    <section className="prep-tools" aria-label="진영">
      <h2>진영</h2>
      
      <div className="button-row">
        <button
          type="button"
          className="secondary"
          title={TIP.randomSide}
          onClick={props.edit.randomSide}
        >
          진영 랜덤
        </button>
      </div>
      <Help>
        왼쪽이 블루팀, 오른쪽이 레드팀이에요. 결과를 입력할 때 이 진영으로 미리 골라 두고, 실제와 다르면 그때 바꿀 수
        있어요.
      </Help>
    </section>
  );
}
