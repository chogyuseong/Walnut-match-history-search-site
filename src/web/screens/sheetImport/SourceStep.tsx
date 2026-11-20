// 시트 가져오기 1단계 "링크" 화면: 시트 주소로 읽을지 표를 붙여 넣을지 고르고, 주소·탭 이름이나 붙여 넣은 표를 받는다.
// 상태와 서버 읽기는 부르는 쪽(screens/SheetImport.tsx)이 갖는다. 주소 검사 결과도 본체가 읽기 전에 다시 쓰므로 계산해서 넘겨받는다.
import { parseSheetUrl, SHEET_URL_MESSAGES } from "../../../shared/sheetUrl";
import { handOffLegacyUrl } from "../../sheetHandoff";
import { ErrorNote } from "../../ui";
import { go } from "../../useApp";

export type SourceMode = "sheet" | "paste";

export function SourceStep(props: {
  mode: SourceMode;
  url: string;
  /** 빈 주소와 기존 사이트 주소는 검사하지 않아 null이다. */
  urlCheck: ReturnType<typeof parseSheetUrl> | null;
  isLegacyUrl: boolean;
  tabName: string;
  /** 서버가 탭 이름을 못 찾았을 때 알려 준 이 시트의 탭 목록. */
  tabChoices: string[] | null;
  text: string;
  busy: boolean;
  error: unknown;
  onMode: (mode: SourceMode) => void;
  onUrl: (value: string) => void;
  onTabName: (value: string) => void;
  onPickTab: (name: string) => void;
  onText: (value: string) => void;
  onReadSheet: () => void;
  onReadPasted: () => void;
}) {
  const { mode, url, urlCheck, isLegacyUrl, tabChoices, busy, error } = props;
  return (
    <section className="card" aria-label="링크">
      <fieldset>
        <legend>어디서 읽을까요?</legend>
        <div className="choice-row">
          <label className={mode === "sheet" ? "choice chosen" : "choice"}>
            <input type="radio" name="sheet-mode" checked={mode === "sheet"} onChange={() => props.onMode("sheet")} />
            <span>시트 주소로 읽기</span>
          </label>
          <label className={mode === "paste" ? "choice chosen" : "choice"}>
            <input type="radio" name="sheet-mode" checked={mode === "paste"} onChange={() => props.onMode("paste")} />
            <span>표 붙여 넣기</span>
          </label>
        </div>
      </fieldset>
      {mode === "sheet" ? (
        <>
          <label>
            구글 시트 주소
            <input
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://docs.google.com/spreadsheets/d/…"
              value={url}
              onChange={(e) => props.onUrl(e.target.value)}
            />
          </label>
          {/* 주소 오류는 칸 바로 아래(설명 문단보다 위)에 둔다. */}
          {urlCheck && !urlCheck.ok && (
            <p className="note error" role="alert">
              {SHEET_URL_MESSAGES[urlCheck.problem]}
            </p>
          )}
          <p className="hint">
            가져올 탭을 연 상태에서 브라우저 주소창의 주소를 복사해 붙여 넣으세요. 시트의 공유 설정이
            '링크가 있는 모든 사용자(보기)'여야 읽을 수 있어요. 다른 탭을 가져오려면 그 탭을 열고 주소를
            다시 복사하세요.
          </p>
          {isLegacyUrl && (
            <div className="note" role="status">
              <p>
                <strong>기존 사이트의 연결 주소로 보여요.</strong> script.google.com/macros/s/…/exec 주소는 시트가
                아니라 기존 사이트가 기록을 읽던 주소예요. 기존 사이트 기록 가져오기로 읽을 수 있어요.
              </p>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  handOffLegacyUrl(url.trim());
                  go("/legacy-import");
                }}
              >
                기존 사이트 기록 가져오기로
              </button>
            </div>
          )}
          {urlCheck?.ok && urlCheck.ref.gid === null && (
            <>
              <p className="hint">
                주소에 탭 번호(gid)가 없어요. 비워 두면 첫 번째 탭을 읽어요. 다른 탭이면 시트 맨 아래에 보이는 탭
                이름을 적어 주세요.
              </p>
              {urlCheck.ref.kind === "doc" && (
                <label>
                  탭 이름(선택)
                  <input
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="예: RAW DATA기입"
                    value={props.tabName}
                    onChange={(e) => props.onTabName(e.target.value)}
                  />
                </label>
              )}
            </>
          )}
          {!isLegacyUrl && (
            <button type="button" className="primary wide" disabled={busy || !urlCheck?.ok} onClick={props.onReadSheet}>
              {busy ? "시트 읽는 중…" : "시트 읽기"}
            </button>
          )}
          {tabChoices && tabChoices.length > 0 && (
            <label>
              이 시트의 탭
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value !== "") props.onPickTab(e.target.value);
                }}
              >
                <option value="">탭을 골라 주세요</option>
                {tabChoices.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="hint">시트 내용은 서버에 저장하지 않아요. 확인을 마치고 가져올 때 경기만 저장해요.</p>
          <p className="hint">
            기존 사이트(구글 시트 + Apps Script)에서 옮겨 온다면 라인·날짜를 그대로 가져오는 쪽이 더
            정확해요.{" "}
            <button type="button" className="link" onClick={() => go("/legacy-import")}>
              기존 사이트에서 옮기기
            </button>
          </p>
        </>
      ) : (
        <>
          <label>
            붙여 넣을 표
            <textarea rows={8} value={props.text} spellCheck={false} onChange={(e) => props.onText(e.target.value)} />
          </label>
          <p className="hint">시트에서 머리글까지 범위를 복사해 붙여 넣으세요. 다음 단계에서 열을 맞춰요.</p>
          <button type="button" className="primary wide" disabled={props.text.trim() === ""} onClick={props.onReadPasted}>
            표 읽기
          </button>
        </>
      )}
      {error instanceof Error && error.message === "empty" ? (
        <p className="note error" role="alert">
          읽은 표가 비어 있어요. 가져올 탭의 주소가 맞는지 확인해 주세요.
        </p>
      ) : (
        <ErrorNote error={error} />
      )}
    </section>
  );
}
