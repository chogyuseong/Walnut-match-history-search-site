import { useState } from "react";
import { placementGamesOf } from "../../shared/stats";
import {
  bandRangeText,
  DEFAULT_TITLE_BANDS,
  MAX_TITLE_BANDS,
  MAX_TITLE_NAME_LENGTH,
  parseTitleBands,
  titleBandsOf,
  titleGrade,
} from "../../shared/titles";
import type { Settings, TitleBand } from "../../shared/types";
import { TitleBadge, TitleEmblem } from "../screenKit";
import { Dialog, ErrorNote } from "../ui";

interface Row {
  name: string;
  minRate: string;
}

function toRows(bands: readonly TitleBand[]): Row[] {
  return [...bands]
    .sort((a, b) => b.minRate - a.minRate)
    .map((b) => ({ name: b.name, minRate: String(b.minRate) }));
}

/**
 * 모임 탭의 칭호 설정. 저장하면 설정 전체를 새 설정 버전으로 남긴다(수정하지 않고 새 행).
 * 가장 낮은 구간은 항상 0%부터라 배치 완료자는 모두 칭호를 하나 받는다.
 * "칭호 쓰지 않기"는 빈 목록으로 저장하며 기본값으로 되돌아가지 않는다.
 */
export function TitleSettings(props: {
  settings: Settings;
  busy: boolean;
  /** 마지막 저장 오류. 창 안에서도 보여준다. */
  error: unknown;
  /** 성공하면 true. 실패하면 창과 입력을 그대로 둔다. */
  onSave: (next: Settings, done: string) => Promise<boolean>;
}) {
  const { settings } = props;
  const bands = titleBandsOf(settings);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function parsedRows(current: Row[]) {
    return parseTitleBands(
      current.map((row, i) => ({
        name: row.name,
        // 맨 아래 구간은 나머지 전부다.
        minRate: i === current.length - 1 ? 0 : Number(row.minRate === "" ? NaN : row.minRate),
      })),
    );
  }

  async function save(next: TitleBand[], done: string) {
    if (await props.onSave({ ...settings, titleBands: next }, done)) {
      setRows(null);
      setMessage(null);
    }
  }

  return (
    <section aria-label="칭호">
      <h2>칭호</h2>
      <p className="hint">
        배치를 마친 사람(누적 {placementGamesOf(settings)}경기 이상)에게 누적 승률 구간에 따라 붙습니다. 시즌·연도
        범위를 바꿔도 바뀌지 않습니다.
        {settings.titleBands === undefined && " 지금 이름은 임시 기본값입니다."}
      </p>
      {bands.length === 0 ? (
        <p>칭호를 쓰지 않습니다.</p>
      ) : (
        <ul className="list">
          {bands.map((band, i) => (
            <li key={band.minRate} className="list-row static">
              <TitleBadge name={band.name} grade={titleGrade(i, bands.length)} />
              <span className="hint">{bandRangeText(bands, i)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="button-row">
        <button
          type="button"
          className="secondary"
          disabled={props.busy}
          onClick={() => {
            setRows(toRows(bands.length > 0 ? bands : DEFAULT_TITLE_BANDS));
            setMessage(null);
          }}
        >
          칭호 바꾸기
        </button>
        {bands.length > 0 && (
          <button
            type="button"
            className="link"
            disabled={props.busy}
            onClick={() => void save([], "칭호를 쓰지 않기로 했어요.")}
          >
            칭호 쓰지 않기
          </button>
        )}
      </div>

      {rows && (
        <Dialog title="칭호 바꾸기" onClose={() => setRows(null)}>
          <p className="hint">
            위에서부터 높은 구간입니다. 경계는 "이상"이라 정확히 65%면 65% 이상 구간입니다. 이름은{" "}
            {MAX_TITLE_NAME_LENGTH}자까지 쓸 수 있습니다. 색과 엠블럼은 구간 순서에 따라 정해집니다.
          </p>
          <ul className="list">
            {rows.map((row, i) => {
              const last = i === rows.length - 1;
              const grade = titleGrade(i, rows.length);
              return (
                <li key={i} className="title-row">
                  {/* 색·엠블럼은 구간 순서로 정해진다(고를 수 없다). 미리보기만 보여준다. */}
                  {grade && (
                    <span className={`title-preview grade-${grade}`}>
                      <TitleEmblem grade={grade} />
                    </span>
                  )}
                  <input
                    aria-label={`${i + 1}번째 칭호 이름`}
                    value={row.name}
                    maxLength={MAX_TITLE_NAME_LENGTH + 4}
                    onChange={(e) =>
                      setRows(rows.map((r, k) => (k === i ? { ...r, name: e.target.value } : r)))
                    }
                  />
                  {last ? (
                    <span className="hint title-rest">나머지</span>
                  ) : (
                    <label className="title-min">
                      <input
                        aria-label={`${i + 1}번째 칭호 경계(% 이상)`}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={100}
                        step={1}
                        value={row.minRate}
                        onChange={(e) =>
                          setRows(rows.map((r, k) => (k === i ? { ...r, minRate: e.target.value } : r)))
                        }
                      />
                      <span>% 이상</span>
                    </label>
                  )}
                  {rows.length > 1 && (
                    <button
                      type="button"
                      className="link"
                      aria-label={`${i + 1}번째 칭호 빼기`}
                      onClick={() => setRows(rows.filter((_, k) => k !== i))}
                    >
                      빼기
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="button-row">
            {rows.length < MAX_TITLE_BANDS && (
              <button
                type="button"
                className="secondary"
                onClick={() => setRows([{ name: "", minRate: "" }, ...rows])}
              >
                맨 위에 구간 더하기
              </button>
            )}
            <button
              type="button"
              className="link"
              onClick={() => setRows(toRows(DEFAULT_TITLE_BANDS))}
            >
              기본값으로 채우기
            </button>
          </div>
          {message && (
            <p className="note warn" role="alert">
              {message}
            </p>
          )}
          <ErrorNote error={props.error} />
          <button
            type="button"
            className="primary wide"
            disabled={props.busy}
            onClick={() => {
              const parsed = parsedRows(rows);
              if (!parsed.ok) {
                setMessage(parsed.message);
                return;
              }
              void save(parsed.bands, "칭호를 바꿨어요. 모든 화면에 바로 적용됩니다.");
            }}
          >
            {props.busy ? "저장 중" : "저장"}
          </button>
        </Dialog>
      )}
    </section>
  );
}
