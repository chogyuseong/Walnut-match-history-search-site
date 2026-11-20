import { useState } from "react";
import type { Settings } from "../../../shared/types";
import { RATING_EDITABLE_KEYS, RATING_SETTING_RANGES, ratingOptionsOf, type RatingSettingKey } from "../../../shared/rating";

/**
 * MMR 설정: 배치 경기 수·시작 점수(rating.ts RATING_EDITABLE_KEYS). Elo 시절의 K 두 칸은 계산에 쓰지 않아 뺐다.
 * 배치·칭호·MMR은 저장하지 않고 매번 계산하므로 저장하면 지난 경기까지 새 값으로 다시 센다.
 */
export function RatingSettings(props: {
  settings: Settings;
  busy: boolean;
  onSave: (next: Settings, done: string) => Promise<boolean>;
}) {
  const options = ratingOptionsOf(props.settings);
  const current: Partial<Record<RatingSettingKey, number>> = {
    placementGames: options.placementGames,
    ratingStart: options.start,
  };
  const [drafts, setDrafts] = useState<Partial<Record<RatingSettingKey, string>>>({});
  const valueOf = (key: RatingSettingKey) => drafts[key] ?? String(current[key]);
  const invalid = RATING_EDITABLE_KEYS.filter((key) => {
    const n = Number(valueOf(key));
    const { min, max } = RATING_SETTING_RANGES[key];
    return valueOf(key) === "" || !Number.isInteger(n) || n < min || n > max;
  });
  const changed = RATING_EDITABLE_KEYS.some((key) => Number(valueOf(key)) !== current[key]);

  async function save() {
    const next: Settings = { ...props.settings };
    for (const key of RATING_EDITABLE_KEYS) next[key] = Number(valueOf(key));
    if (await props.onSave(next, "MMR 설정을 저장했어요. 지난 경기까지 다시 계산했어요.")) setDrafts({});
  }

  return (
    <section aria-label="MMR 설정">
      <h2>MMR 설정</h2>
      <p className="hint">
        배치 경기 수만큼 확정 경기를 치르면 배치가 끝나 MMR·티어·칭호가 보여요. 바꾸면 지난 경기까지 전부 다시
        계산돼요. 시작 점수는 모든 점수를 같이 옮길 뿐이라 순위는 그대로예요.
      </p>
      <form
        className="rating-settings"
        onSubmit={(e) => {
          e.preventDefault();
          if (invalid.length === 0 && changed) void save();
        }}
      >
        {RATING_EDITABLE_KEYS.map((key) => {
          const { label, min, max } = RATING_SETTING_RANGES[key];
          // 범위 오류는 그 칸 바로 아래에 둔다(7절). 저장 버튼은 오류가 하나라도 있으면 막힌다.
          return (
            <div key={key} className="field">
              <label className="inline-label">
                {label}
                <input
                  type="number"
                  inputMode="numeric"
                  min={min}
                  max={max}
                  step={1}
                  value={valueOf(key)}
                  disabled={props.busy}
                  onChange={(e) => setDrafts({ ...drafts, [key]: e.target.value })}
                />
              </label>
              {invalid.includes(key) && (
                <p className="field-problem" role="alert">
                  {label}는 {min}~{max} 사이 정수로 적어 주세요.
                </p>
              )}
            </div>
          );
        })}
        <button type="submit" className="secondary" disabled={props.busy || invalid.length > 0 || !changed}>
          저장
        </button>
      </form>
    </section>
  );
}
