import { useCallback, useEffect, useState } from "react";
import { call } from "../api";
import { formatDate, formatTime } from "../format";
import { ErrorNote } from "../ui";

/** GET /api/admin/overview 응답(src/server/siteAdmin.ts의 Overview). 모임 안의 자료(이름·경기 내용)는 없다. */
interface Overview {
  generatedAt: string;
  totals: { accounts: number; groups: number; matches: number; confirmedMatches: number; participants: number };
  recent: { days: number; activeGroups: number; newAccounts: number; newGroups: number }[];
  errors: {
    total: number;
    byKind: { source: string; kind: string; count: number }[];
    groups: {
      source: string;
      kind: string;
      message: string;
      path: string | null;
      count: number;
      firstAt: string;
      lastAt: string;
      stack: string | null;
      appVersion: string | null;
      browser: string | null;
    }[];
  };
  rateLimited: { bucket: string; last7: number; last30: number }[];
  /** 자동 백업(src/server/backupCron.ts). 예전 서버 응답에는 없을 수 있다. */
  backup?: { enabled: boolean; lastBackupAt: string | null; backedUpToday: number; pendingToday: number };
}

const KIND_LABEL: Record<string, string> = {
  error: "화면 오류",
  rejection: "처리 안 된 요청 실패",
  boundary: "화면 그리기 오류",
  server: "서버 오류",
};

function when(iso: string): string {
  // 다른 화면과 같은 날짜·시각 표기("11월 7일 오후 6:00").
  return `${formatDate(iso)} ${formatTime(iso)}`;
}

/**
 * 사이트 운영자(이 서비스의 주인) 현황(#/admin). 전체 수치와 오류 기록만 보여 준다.
 * 사이트 운영자가 아니면 App이 이 화면을 그리지 않는다(서버도 404).
 */
export function SiteAdmin() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await call<Overview>("GET", "/api/admin/overview"));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function clear() {
    setBusy(true);
    try {
      await call("POST", "/api/admin/errors/clear", {});
      setConfirming(false);
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen site-admin">
      <header className="screen-head">
        <h1>사이트 현황</h1>
        <button type="button" className="secondary" onClick={() => void load()}>
          새로 고침
        </button>
      </header>
      <p className="hint">활동 모임은 그 기간에 경기가 기록된 모임이에요. 서비스 전체 수치와 오류 기록만 보여요. 모임 이름·참가자·경기 내용은 여기 나오지 않아요.</p>
      <ErrorNote error={error} />
      {!data ? (
        <p className="site-admin-loading">{error ? "" : "불러오는 중…"}</p>
      ) : (
        <>
          <section aria-label="전체 수치">
            <h2>전체</h2>
            <p className="kpi">
              <span>
                계정<strong>{data.totals.accounts}</strong>
              </span>
              <span>
                모임<strong>{data.totals.groups}</strong>
              </span>
              <span>
                경기<strong>{data.totals.matches}</strong>
              </span>
              <span>
                결과 확정<strong>{data.totals.confirmedMatches}</strong>
              </span>
              <span>
                참가자<strong>{data.totals.participants}</strong>
              </span>
            </p>
          </section>

          <section aria-label="최근 활동">
            <h2>최근 활동</h2>
            <div className="table-scroll">
              <table className="privacy-table">
                <thead>
                  <tr>
                    <th>기간</th>
                    <th>활동 모임</th>
                    <th>새 계정</th>
                    <th>새 모임</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((r) => (
                    <tr key={r.days}>
                      <td>최근 {r.days}일</td>
                      <td>{r.activeGroups}</td>
                      <td>{r.newAccounts}</td>
                      <td>{r.newGroups}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {data.backup && (
            <section aria-label="자동 백업">
              <h2>자동 백업</h2>
              {data.backup.enabled ? (
                <>
                  <p className="kpi">
                    <span>
                      오늘 끝남<strong>{data.backup.backedUpToday}</strong>
                    </span>
                    <span>
                      오늘 남음<strong>{data.backup.pendingToday}</strong>
                    </span>
                  </p>
                  <p className="hint">
                    마지막 백업: {data.backup.lastBackupAt ? when(data.backup.lastBackupAt) : "아직 없어요"}. 매일 새벽(한국 시각 오전 3:00~5:55)에
                    모임마다 하나씩 백업해요. 오늘 남은 모임은 다음 실행이 이어서 해요.
                  </p>
                </>
              ) : (
                <p className="hint">자동 백업이 꺼져 있어요(백업 저장소가 연결되지 않음). 모임 백업은 운영자가 직접 내려받아야 해요.</p>
              )}
            </section>
          )}

          <section aria-label="요청 수 제한">
            <h2>요청 수 제한에 걸린 횟수</h2>
            {data.rateLimited.length === 0 ? (
              <p className="hint">최근 30일 동안 없어요.</p>
            ) : (
              <div className="table-scroll">
                <table className="privacy-table">
                  <thead>
                    <tr>
                      <th>종류</th>
                      <th>최근 7일</th>
                      <th>최근 30일</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rateLimited.map((r) => (
                      <tr key={r.bucket}>
                        <td>{r.bucket}</td>
                        <td>{r.last7}</td>
                        <td>{r.last30}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section aria-label="오류 기록">
            <div className="section-head">
              <h2>오류 기록 {data.errors.total}건</h2>
              {data.errors.total > 0 && !confirming && (
                <button type="button" className="secondary" onClick={() => setConfirming(true)}>
                  오류 기록 비우기
                </button>
              )}
            </div>
            {confirming && (
              <p className="note warn" role="alert">
                오류 기록 {data.errors.total}건을 모두 지울까요? 되돌릴 수 없어요.{" "}
                <button type="button" className="primary" disabled={busy} onClick={() => void clear()}>
                  모두 지우기
                </button>{" "}
                <button type="button" className="link" onClick={() => setConfirming(false)}>
                  취소
                </button>
              </p>
            )}
            {data.errors.byKind.length > 0 && (
              <p className="kpi" aria-label="종류별 건수">
                {data.errors.byKind.map((k) => (
                  <span key={`${k.source}-${k.kind}`}>
                    {KIND_LABEL[k.kind] ?? k.kind}
                    <strong>{k.count}</strong>
                  </span>
                ))}
              </p>
            )}
            {data.errors.groups.length === 0 ? (
              <p className="hint">기록된 오류가 없어요. 화면·서버 오류는 최근 1000건, 30일까지 남아요.</p>
            ) : (
              <ul className="list error-log">
                {data.errors.groups.map((g, i) => (
                  <li key={i}>
                    <details>
                      <summary>
                        <span className="error-summary">
                          <span className="badge">{KIND_LABEL[g.kind] ?? g.kind}</span> <strong>{g.message}</strong>
                          <span className="hint">
                            {g.path ?? "경로 없음"} · {g.count}건 · 마지막 {when(g.lastAt)}
                          </span>
                        </span>
                      </summary>
                      <p className="hint">
                        처음 {when(g.firstAt)} · 버전 {g.appVersion ?? "-"} · {g.browser ?? "브라우저 정보 없음"}
                      </p>
                      <pre className="error-stack">{g.stack ?? "스택 없음"}</pre>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <p className="hint">{when(data.generatedAt)} 기준</p>
        </>
      )}
    </div>
  );
}
