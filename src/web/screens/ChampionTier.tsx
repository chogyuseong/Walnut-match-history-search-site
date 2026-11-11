import { useMemo, useState } from "react";
import {
  championTiers,
  latestMatchWithoutChampions,
  sortChampionRows,
  TIER_CUTS,
  TIER_MIN_GAMES,
  TIER_PICK_WEIGHT,
  TIER_PRIOR_GAMES,
  TIER_TOP_MIN_GAMES,
  type ChampionSortKey,
  type ChampionTierRow,
  type LaneFilter,
  type Tier,
} from "../../shared/championTier";
import { championInitial, championName, INITIAL_GROUPS, searchChampions } from "../../shared/champions";
import { fractionPercent, ratePercent, roundRatio, type Scope } from "../../shared/stats";
import { POSITIONS, type Snapshot } from "../../shared/types";
import { ChampionPortrait } from "../championPortrait";
import { formatDate, nameMap, POSITION_LABEL, rateText, rateTier } from "../format";
import { DataTable, type TableColumn } from "../dataTable";
import {
  FilterBar,
  Help,
  Meter,
  PosLabel,
  ScopePicker,
  ScreenHead,
  StatCard,
  useMediaQuery,
  type SortState,
} from "../screenKit";
import { useSearchJump } from "../ui";
import { go } from "../useApp";

/**
 * 챔피언 티어(#/champions, 조회 링크·예시 모임은 …/champions). 계산은 src/shared/championTier.ts.
 * 전적 사이트의 챔피언 티어 화면 구조(왼쪽 초성별 챔피언 격자 + 오른쪽 정렬 표)를 따르되, 이 모임은 운영자가 손으로 넣은
 * 기록만 있으므로 머리에 입력률("챔피언 기록 34 / 111경기")을 늘 보여 주고 운영자에게는 빠진 경기로 가는 길을 둔다.
 * 틀: 화면 머리 → 필터 줄(범위·라인·검색) → 요약 카드 → [왼쪽 격자 | 오른쪽 표 + 기록 부족 표].
 * 1200px 미만은 한 단이고 격자는 접어 둔다(검색 칸이 같은 일을 한다). 두 단 기준은 styles.css .ct-body와 같이 바꾼다.
 */

const LANES: readonly { value: LaneFilter; label: string }[] = [
  { value: "all", label: "전체" },
  ...POSITIONS.map((position) => ({ value: position, label: POSITION_LABEL[position] })),
];

const DEFAULT_SORT: SortState<ChampionSortKey> = { key: "tier", dir: "desc" };
const percent = (rate: number) => `${fractionPercent(rate)}%`;

export function ChampionTier(props: {
  snapshot: Snapshot;
  openMatch: (id: string) => void;
  openPerson: (id: string) => void;
  /**
   * 운영자 화면이면 챔피언이 빠진 최근 경기로 가는 버튼(경기 상세에서 "챔피언 기록")과, 확정 경기가 없을 때 팀 짜기 버튼을 둔다.
   * 조회 링크·예시 모임은 입력률 숫자만 보여 준다.
   */
  operator?: boolean;
}) {
  const { snapshot } = props;
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [lane, setLane] = useState<LaneFilter>("all");
  const [query, setQuery] = useState("");
  const tableJump = useSearchJump<HTMLElement>();
  const [initial, setInitial] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState<ChampionSortKey>>(DEFAULT_SORT);
  // 펼친 줄. 격자에서 누른 챔피언도 여기로 온다. 한 번에 하나만 펼친다.
  const [open, setOpen] = useState<string | null>(null);
  const narrow = useMediaQuery("(max-width: 1199px)");
  const nameOf = useMemo(() => nameMap(snapshot), [snapshot]);
  const result = useMemo(() => championTiers(snapshot, { scope, lane }), [snapshot, scope, lane]);
  const missing = useMemo(
    () => (props.operator ? latestMatchWithoutChampions(snapshot.matches) : null),
    [snapshot, props.operator],
  );
  const matchById = useMemo(() => new Map(snapshot.matches.map((m) => [m.id, m])), [snapshot]);
  // 검색은 고르기 창과 같은 규칙(초성·영문·별칭, src/shared/champions.ts).
  const found = useMemo(
    () => (query.trim() === "" ? null : new Set(searchChampions(query).map((o) => o.champion.key))),
    [query],
  );
  const shown = (row: ChampionTierRow) => !found || found.has(row.key);
  const rows = useMemo(
    () => sortChampionRows(result.rows, sort.key, sort.dir).filter((row) => !found || found.has(row.key)),
    [result, sort, found],
  );
  // 기록 부족 표도 같은 정렬 상태를 쓰므로 같은 순서로 세운다(안 그러면 이 표의 머리를 눌러도 위 표만 바뀐다).
  const few = useMemo(
    () => sortChampionRows(result.few, sort.key, sort.dir).filter((row) => !found || found.has(row.key)),
    [result, sort, found],
  );

  const coverage = (
    <div className="champ-coverage">
      <p>
        챔피언 기록 <strong>{result.recordedMatches}</strong> / {result.countedMatches}경기
      </p>
      {missing && (
        <button type="button" className="secondary" onClick={() => props.openMatch(missing.id)}>
          빠진 경기 채우기 · {missing.matchNo}경기
        </button>
      )}
    </div>
  );
  const head = (
    <ScreenHead
      title="챔피언 티어"
      desc="우리 모임 경기에서 나온 성적이에요. 챔피언 자체의 성능과는 다를 수 있어요. 챔피언을 기록한 확정 경기만 세고, 판 수가 적으면 승률을 50% 쪽으로 당겨 티어를 매겨요."
      actions={coverage}
    />
  );

  if (result.recordedMatches === 0 && scope.kind === "all") {
    return (
      <div className="screen page-wide champ-tier">
        {head}
        <div className="empty-state">
          {result.countedMatches === 0 ? (
            <p>확정 경기가 쌓이고 경기마다 챔피언을 기록하면 챔피언별 승률과 티어가 여기 생겨요.</p>
          ) : (
            <p>
              아직 챔피언이 기록된 경기가 없어요. 결과를 입력할 때 "챔피언도 기록하기"를 펼치거나, 경기 상세에서 챔피언을
              기록하면 채워집니다.
            </p>
          )}
          {missing ? (
            <button type="button" className="primary" onClick={() => props.openMatch(missing.id)}>
              {missing.matchNo}경기 챔피언 기록하기
            </button>
          ) : (
            props.operator &&
            result.countedMatches === 0 && (
              <button type="button" className="primary" onClick={() => go("/pick")}>
                이름 넣고 팀 짜기
              </button>
            )
          )}
        </div>
      </div>
    );
  }

  function toggle(key: string) {
    setOpen((now) => (now === key ? null : key));
  }

  /** 격자에서 고른 챔피언: 표에서 펼치고 그 줄로 내려간다. */
  function reveal(key: string) {
    setOpen(key);
    requestAnimationFrame(() => {
      document.querySelector(`.ct-row-${key}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  const columns: TableColumn<ChampionTierRow>[] = [
    {
      key: "rank",
      label: "#",
      num: true,
      className: "ct-rank",
      cell: (row) => row.rank ?? <span className="hint">–</span>,
    },
    {
      key: "champion",
      label: "챔피언",
      className: "ct-champ",
      cell: (row) => (
        <button
          type="button"
          className="ct-name"
          aria-expanded={open === row.key}
          onClick={(e) => {
            e.stopPropagation();
            toggle(row.key);
          }}
        >
          <ChampionPortrait championKey={row.key} size={32} />
          <span>{championName(row.key)}</span>
        </button>
      ),
    },
    { key: "tier", label: "티어", sortable: true, className: "ct-tier", cell: (row) => <TierMark tier={row.tier} /> },
    {
      key: "rate",
      label: "승률",
      num: true,
      sortable: true,
      cell: (row) => <span className={rateTier(row.wins, row.games)}>{rateText(row.wins, row.games)}</span>,
    },
    { key: "pick", label: "픽률", num: true, sortable: true, cell: (row) => percent(row.pickRate) },
    { key: "games", label: "판", num: true, sortable: true, cell: (row) => row.games },
    {
      key: "players",
      label: "주로 쓴 사람",
      wideOnly: true,
      className: "ct-players",
      cell: (row) => (
        <span className="ct-player-list">
          {row.players.slice(0, 3).map((p) => (
            <span key={p.participantId} className="ct-player">
              {nameOf(p.participantId)} <span className="hint">{p.games}판</span>
            </span>
          ))}
        </span>
      ),
    },
  ];

  const table = (caption: string, list: readonly ChampionTierRow[]) => (
    <DataTable
      caption={caption}
      className="ct-table"
      columns={columns}
      rows={list}
      rowKey={(row) => row.key}
      sort={sort}
      onSort={(key) =>
        setSort((now) =>
          now.key === key ? { key, dir: now.dir === "desc" ? "asc" : "desc" } : { key: key as ChampionSortKey, dir: "desc" },
        )
      }
      onRowClick={(row) => toggle(row.key)}
      rowClass={(row) => `ct-row-${row.key}${open === row.key ? " is-open" : ""}`}
      expanded={(row) =>
        open === row.key && (
          <ChampionDetail
            row={row}
            nameOf={nameOf}
            matchById={matchById}
            timeZone={snapshot.group.timezone}
            openMatch={props.openMatch}
            openPerson={props.openPerson}
          />
        )
      }
    />
  );

  const board = (
    <ChampionBoard
      keys={[...result.rows, ...result.few].filter(shown).map((row) => row.key)}
      initial={initial}
      chooseInitial={setInitial}
      open={open}
      reveal={reveal}
    />
  );
  const top = result.rows[0];
  const most = [...result.rows, ...result.few].sort((a, b) => b.games - a.games || b.score - a.score)[0];
  const tierCounts = ([1, 2, 3, 4, 5] as const).map((tier) => result.rows.filter((r) => r.tier === tier).length);

  return (
    <div className="screen page-wide champ-tier">
      {head}

      <FilterBar label="챔피언 티어 거르기" meta={`${result.rows.length + result.few.length}개 챔피언`}>
        <ScopePicker snapshot={snapshot} scope={scope} onChange={setScope} />
        <div className="segmented ct-lanes" role="group" aria-label="라인">
          {LANES.map((item) => (
            <button key={item.value} type="button" aria-pressed={lane === item.value} onClick={() => setLane(item.value)}>
              {item.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="filter-search"
          aria-label="챔피언 검색"
          placeholder="챔피언 검색(가렌, ㄱㄹ)"
          enterKeyHint="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={tableJump.onSearchKey}
        />
      </FilterBar>

      <section aria-label="챔피언 요약">
        <h2 className="sr-only">요약</h2>
        <div className="stat-cards">
          <StatCard
            title="점수 1위"
            lead={top ? <ChampLabel championKey={top.key} /> : undefined}
            value={top ? rateText(top.wins, top.games) : "—"}
            rows={top ? [["판 · 픽률", `${top.games}판 · ${percent(top.pickRate)}`]] : [["기준", `${TIER_MIN_GAMES}판부터 티어`]]}
          />
          <StatCard
            title="가장 많이 쓴 챔피언"
            lead={most ? <ChampLabel championKey={most.key} /> : undefined}
            value={most ? `${most.games}판` : "—"}
            rows={most ? [["승률", rateText(most.wins, most.games)]] : []}
          />
          <StatCard title="티어 분포" value={`${result.rows.length}개`}>
            <p className="ct-tier-counts">
              {tierCounts.map((count, i) => (
                <span key={i}>
                  <TierMark tier={(i + 1) as Tier} /> {count}
                </span>
              ))}
            </p>
          </StatCard>
        </div>
        {/* 입력률은 표의 믿을 만한 정도를 알리는 보조 정보라 요약 카드(최대 셋)에서 이 줄로 내렸다. */}
        <p className="hint">
          챔피언 입력률 {result.countedMatches === 0 ? 0 : roundRatio(result.recordedMatches, result.countedMatches)}% · 기록된 경기{" "}
          {result.recordedMatches} / {result.countedMatches}
        </p>
      </section>

      <div className="ct-body">
        {narrow ? (
          <details className="ct-board-fold">
            <summary>챔피언 모아 보기</summary>
            {board}
          </details>
        ) : (
          <aside className="ct-board-side" aria-label="챔피언 모아 보기">
            {board}
          </aside>
        )}
        <section ref={tableJump.results} tabIndex={-1} className="ct-main search-results" aria-label="챔피언 티어 표">
          <h2 className="sr-only">챔피언 티어 표</h2>
          {result.recordedMatches === 0 ? (
            <p className="hint">이 범위에는 챔피언이 기록된 경기가 없어요.</p>
          ) : rows.length === 0 && few.length === 0 ? (
            <p className="hint">{found ? "맞는 챔피언이 없어요." : "이 라인에 기록된 챔피언이 없어요."}</p>
          ) : (
            <>
              {rows.length > 0 ? (
                table("챔피언 티어", rows)
              ) : (
                <p className="hint">아직 {TIER_MIN_GAMES}판을 채운 챔피언이 없어요.</p>
              )}
              {few.length > 0 && (
                <section className="ct-few" aria-label="기록 부족">
                  <h3>
                    기록 부족 <span className="hint">· {TIER_MIN_GAMES}판 미만이라 티어를 매기지 않아요</span>
                  </h3>
                  {table("기록 부족 챔피언", few)}
                </section>
              )}
            </>
          )}
          <Help label="티어 매기는 법">
            챔피언을 기록한 확정 경기만 셉니다. 픽률은 그 챔피언이 나온 경기 수를 챔피언이 하나라도 기록된 경기 수로 나눈
            값이에요(라인을 고르면 그 라인에 기록된 경기 수로 나눕니다). 티어 점수는 승률에 50% 승률의 가상 경기{" "}
            {TIER_PRIOR_GAMES}판을 더한 보정 승률에 픽률 × {TIER_PICK_WEIGHT}를 더한 값이에요. 그래서 2판 2승이 20판 13승보다
            위에 오지 않습니다. 점수 {TIER_CUTS.map((cut) => `${fractionPercent(cut)}%`).join(" · ")} 이상이 1~4티어이고 그
            아래는 5티어예요. 1티어는 {TIER_TOP_MIN_GAMES}판 이상만 받고, 그보다 적으면 점수가 높아도 2티어예요.{" "}
            {TIER_MIN_GAMES}판 미만은 티어 없이 "기록 부족"에 둡니다. 밴과 상대 챔피언은 기록하지 않아서
            보여 주지 않아요.
          </Help>
        </section>
      </div>
    </div>
  );
}

/** 티어 칸: 숫자가 든 작은 각진 칸. 1티어만 포인트 색으로 채우고 아래로 갈수록 옅어진다. */
function TierMark(props: { tier: Tier | null }) {
  if (props.tier === null) return <span className="hint">–</span>;
  return (
    <span className={`ct-tier-mark t${props.tier}`}>
      <span className="sr-only">티어 </span>
      {props.tier}
    </span>
  );
}

function ChampLabel(props: { championKey: string }) {
  return (
    <span className="ct-label">
      <ChampionPortrait championKey={props.championKey} size={24} />
      {championName(props.championKey)}
    </span>
  );
}

/** 왼쪽 격자: 기록이 있는 챔피언을 초성별로 묶는다. 누르면 표에서 그 줄을 펼친다. */
function ChampionBoard(props: {
  keys: readonly string[];
  initial: string | null;
  chooseInitial: (initial: string | null) => void;
  open: string | null;
  reveal: (key: string) => void;
}) {
  const groups = new Map<string, string[]>();
  for (const key of [...props.keys].sort((a, b) => championName(a).localeCompare(championName(b), "ko"))) {
    const initial = championInitial(championName(key)) ?? "#";
    groups.set(initial, [...(groups.get(initial) ?? []), key]);
  }
  const shownGroups = [...groups].filter(([initial]) => props.initial === null || props.initial === initial);
  return (
    <div className="ct-board">
      <div className="ct-initials" role="group" aria-label="초성">
        <button type="button" aria-pressed={props.initial === null} onClick={() => props.chooseInitial(null)}>
          전체
        </button>
        {INITIAL_GROUPS.map((initial) => (
          <button
            key={initial}
            type="button"
            aria-pressed={props.initial === initial}
            disabled={!groups.has(initial)}
            onClick={() => props.chooseInitial(props.initial === initial ? null : initial)}
          >
            {initial}
          </button>
        ))}
      </div>
      {shownGroups.length === 0 ? (
        <p className="hint">기록된 챔피언이 없어요.</p>
      ) : (
        shownGroups.map(([initial, keys]) => (
          <div key={initial} className="ct-group">
            <span className="ct-group-head" aria-hidden="true">
              {initial}
            </span>
            <ul className="ct-grid">
              {keys.map((key) => (
                <li key={key}>
                  <button
                    type="button"
                    className="ct-cell"
                    aria-pressed={props.open === key}
                    onClick={() => props.reveal(key)}
                  >
                    <ChampionPortrait championKey={key} size={44} />
                    <span>{championName(key)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}

/** 펼친 줄: 사람별 전적, 라인 분포, 최근 경기. */
function ChampionDetail(props: {
  row: ChampionTierRow;
  nameOf: (id: string) => string;
  matchById: ReadonlyMap<string, Snapshot["matches"][number]>;
  timeZone: string;
  openMatch: (id: string) => void;
  openPerson: (id: string) => void;
}) {
  const { row } = props;
  const laneTotal = row.lanes.reduce((sum, l) => sum + l.games, 0) + row.noLane;
  return (
    <div className="ct-detail" onClick={(e) => e.stopPropagation()}>
      <section>
        <h4>사람별</h4>
        <ul className="ct-detail-list">
          {row.players.slice(0, 8).map((p) => (
            <li key={p.participantId}>
              <button type="button" className="link" onClick={() => props.openPerson(p.participantId)}>
                {props.nameOf(p.participantId)}
              </button>
              <span className="num">
                {p.games}판 · <span className={rateTier(p.wins, p.games)}>{ratePercent(p.wins, p.games)}%</span>
              </span>
            </li>
          ))}
          {row.players.length > 8 && <li className="hint">외 {row.players.length - 8}명</li>}
        </ul>
      </section>
      <section>
        <h4>라인</h4>
        <ul className="ct-detail-list">
          {row.lanes.map((l) => (
            <li key={l.position}>
              <PosLabel position={l.position} />
              <Meter value={l.games / laneTotal} tone="share" small />
              <span className="num">{l.games}판</span>
            </li>
          ))}
          {row.noLane > 0 && (
            <li>
              <PosLabel position={null} />
              <Meter value={row.noLane / laneTotal} tone="share" small />
              <span className="num">{row.noLane}판</span>
            </li>
          )}
        </ul>
        <p className="hint">보정 승률 {fractionPercent(row.adjustedRate)}%</p>
      </section>
      <section>
        <h4>최근 경기</h4>
        <ul className="ct-detail-list">
          {row.recentMatchIds.map((id, i) => {
            const match = props.matchById.get(id);
            if (!match) return null;
            const result = row.recentResults[i];
            return (
              <li key={id}>
                <button type="button" className="link" onClick={() => props.openMatch(id)}>
                  {match.matchNo}경기
                </button>
                <span className="hint">{formatDate(match.playedAt, props.timeZone)}</span>
                <span className={result === "win" ? "ct-result win" : result === "loss" ? "ct-result loss" : "ct-result"}>
                  {result === "win" ? "승" : result === "loss" ? "패" : "양 팀"}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
