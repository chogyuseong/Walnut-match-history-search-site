// 지난 경기 일괄 저장의 공통 절차와 화면 조각. 표 일괄 입력(Import)·구글 시트 가져오기(SheetImport)·
// 기존 사이트 가져오기(LegacyImport)가 같이 쓴다. 한 곳을 고치면 세 화면이 함께 바뀐다.
// busy·error·saved·done 상태는 화면이 갖는다: 각 화면이 불러오기·확인 같은 다른 요청과 그 상태를 함께 쓰기 때문이다.
import type { ReactNode } from "react";
import { similarWithinTable, type NameLink } from "../shared/importLink";
import { nameKey } from "../shared/names";
import { mutate, newRequestId } from "./api";
import { ErrorNote } from "./ui";
import { go } from "./useApp";

/** 한 요청에 넣는 경기 수. 서버 상한(matches.ts MAX_IMPORT_MATCHES)보다 작아야 하고, 실패하면 이 묶음부터 다시 보낸다. */
const MATCH_CHUNK = 50;
/** 참가자를 한 번에 만드는 이름 수. 서버 participants 요청의 이름 수 상한 이하로 둔다. */
const NAME_CHUNK = 30;

/**
 * 저장 계획. 요청 ID를 미리 정해 두므로, 중간에 실패한 뒤 "이어서 넣기"로 같은 계획을 다시 보내면
 * 이미 들어간 묶음은 서버가 같은 요청으로 보고 건너뛴다. 진영 같은 입력을 바꾸면 화면이 계획을 버려야 한다.
 */
export interface ImportPlan<T> {
  /** 이번 일괄 입력 전체를 가리키는 ID. 모임 탭에서 한 번에 되돌릴 때 쓴다. */
  batchId: string;
  chunks: { requestId: string; matches: T[] }[];
  total: number;
}

/** 이름 연결 결과를 이미 정해진 참가자(이름 키 → ID)와 새로 만들 이름으로 나눈다. 비슷한 이름에서 "새로 만들기"를 고르면 새로 만든다. */
export function splitNameLinks(
  links: readonly NameLink[],
  choices: Readonly<Record<string, string>>,
): { known: Map<string, string>; create: string[] } {
  const known = new Map<string, string>();
  const create: string[] = [];
  for (const link of links) {
    const choice = link.kind === "similar" ? choices[link.name] : undefined;
    if (link.participantId) known.set(nameKey(link.name), link.participantId);
    else if (choice && choice !== "new") known.set(nameKey(link.name), choice);
    else create.push(link.name);
  }
  return { known, create };
}

/**
 * 새 이름을 참가자로 만들고(같은 이름이면 서버가 같은 참가자를 돌려준다), 경기를 묶음으로 나눈 계획을 만든다.
 * toPayload는 이름 → 참가자 ID 함수를 받아 서버로 보낼 경기 목록을 만든다.
 */
export async function prepareImport<T>(
  gid: string,
  names: { known: ReadonlyMap<string, string>; create: readonly string[] },
  toPayload: (idOf: (name: string) => string) => T[],
): Promise<ImportPlan<T>> {
  const idOf = new Map(names.known);
  for (let i = 0; i < names.create.length; i += NAME_CHUNK) {
    const batch = names.create.slice(i, i + NAME_CHUNK);
    const ensured = await mutate<{ participants: { id: string }[] }>(`/api/groups/${gid}/participants`, {
      requestId: newRequestId(),
      names: batch,
    });
    batch.forEach((name, k) => idOf.set(nameKey(name), ensured.participants[k]!.id));
  }
  const matches = toPayload((name) => idOf.get(nameKey(name))!);
  const chunks: ImportPlan<T>["chunks"] = [];
  for (let i = 0; i < matches.length; i += MATCH_CHUNK) {
    chunks.push({ requestId: newRequestId(), matches: matches.slice(i, i + MATCH_CHUNK) });
  }
  return { batchId: newRequestId(), chunks, total: matches.length };
}

/** 계획의 묶음을 차례로 보낸다. onSaved에는 지금까지 저장된 경기 수가 온다. source는 모임 탭 일괄 입력 기록에 남는 출처다. */
export async function sendImport<T>(
  gid: string,
  plan: ImportPlan<T>,
  source: unknown,
  onSaved: (count: number) => void,
): Promise<void> {
  let count = 0;
  for (const chunk of plan.chunks) {
    await mutate(`/api/groups/${gid}/matches/import`, {
      requestId: chunk.requestId,
      batchId: plan.batchId,
      source,
      matches: chunk.matches,
    });
    count += chunk.matches.length;
    onSaved(count);
  }
}

/** 시트·기존 사이트 가져오기의 마지막 단계: 저장 진행, 실패 뒤 이어서 넣기, 끝난 뒤 안내. */
export function ImportProgress(props: {
  busy: boolean;
  done: boolean;
  saved: number;
  total: number;
  error: unknown;
  onRun: () => void;
  /** 끝난 뒤 굵게 보이는 진영 설명(예: "진영 미상"). */
  sideText: string;
  /** 되돌리는 곳 안내. 출처마다 기록 이름이 달라 화면이 넘긴다. */
  undoHint: ReactNode;
}) {
  const { busy, done, saved, total } = props;
  return (
    <section className="card" aria-label="가져오기">
      {!done && (
        <p role="status">{busy ? `저장 중 · ${saved}/${total}경기` : `${total}경기 중 ${saved}경기까지 저장됐습니다.`}</p>
      )}
      <ErrorNote error={props.error} onCheck={props.onRun} />
      {!done && !busy && (
        <>
          <p className="hint">이어서 넣으면 이미 들어간 묶음은 다시 들어가지 않습니다.</p>
          <button type="button" className="primary wide" onClick={props.onRun}>
            이어서 넣기
          </button>
        </>
      )}
      {done && (
        <>
          <p className="saved" role="status">
            <strong>
              {saved}경기 저장됨 · {props.sideText}
            </strong>
          </p>
          <p className="hint">{props.undoHint}</p>
          <div className="button-row">
            <button type="button" className="primary" onClick={() => go("/records")}>
              기록 보기
            </button>
            <button type="button" className="secondary" onClick={() => go("/group")}>
              모임으로
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** 표의 이름을 기존 참가자와 잇는 확인 칸. 비슷한 이름은 같은 사람인지 고르게 한다(고르기 전에는 저장 버튼이 잠긴다). */
export function NameLinks(props: {
  links: NameLink[];
  names: string[];
  choices: Record<string, string>;
  onChoose: (name: string, value: string) => void;
}) {
  const exact = props.links.filter((l) => l.kind === "exact");
  const merged = props.links.filter((l) => l.kind === "merged");
  const similar = props.links.filter((l) => l.kind === "similar");
  const fresh = props.links.filter((l) => l.kind === "new");
  const within = similarWithinTable(props.names);
  if (props.links.length === 0) return null;
  return (
    <div className="sheet-names">
      <h3>참가자 연결</h3>
      <p className="hint">
        {exact.length + merged.length > 0 ? `이름이 같은 기존 참가자 ${exact.length + merged.length}명은 자동으로 이어요. ` : ""}
        새로 만들 참가자 {fresh.length}명.
      </p>
      {merged.length > 0 && (
        <details>
          <summary>합쳐진 참가자 {merged.length}명은 남은 사람으로 이어요</summary>
          <ul>
            {merged.map((l) => (
              <li key={l.name}>
                {l.name} → 합친 뒤 남은 참가자
              </li>
            ))}
          </ul>
        </details>
      )}
      {similar.length > 0 && (
        <div className="note warn">
          <p>
            <strong>비슷한 이름 {similar.length}개</strong> — 띄어쓰기·대소문자·전각 문자만 다른 기존 참가자가 있어요. 같은
            사람인지 골라 주세요.
          </p>
          <ul className="sheet-links">
            {similar.map((l) => (
              <li key={l.name}>
                <label>
                  <span>표의 '{l.name}'</span>
                  <select value={props.choices[l.name] ?? ""} onChange={(e) => props.onChoose(l.name, e.target.value)}>
                    <option value="">골라 주세요</option>
                    {l.candidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        기존 '{c.name}'와 같은 사람
                      </option>
                    ))}
                    <option value="new">다른 사람(새로 만들기)</option>
                  </select>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
      {fresh.length > 0 && (
        <details>
          <summary>새로 만들 참가자 {fresh.length}명</summary>
          <p>{fresh.map((l) => l.name + (l.archivedSameName ? "(같은 이름의 보관된 참가자 있음)" : "")).join(", ")}</p>
        </details>
      )}
      {within.length > 0 && (
        <p className="hint">
          표 안에 같은 사람일 수 있는 이름이 있어요: {within.map((g) => g.join(" / ")).join(", ")}. 다른 사람이 맞으면
          그대로 두고, 같은 사람이면 시트에서 이름을 맞추거나 가져온 뒤 참가자 합치기를 쓰세요.
        </p>
      )}
    </div>
  );
}
