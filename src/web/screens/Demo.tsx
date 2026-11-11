import { useEffect, useState } from "react";
import type { Snapshot } from "../../shared/types";
import { go } from "../useApp";
import { LineIcon } from "../ui";
import { VIEWER_TAB_ICON, viewerPage, type ViewerTab } from "./Viewer";

/**
 * 예시 모임(#/demo, #/demo/records, #/demo/ranking, #/demo/champions, #/demo/p/…, #/demo/season/…). 서버·DB 없이 기기에서 만든 합성 데이터
 * (src/shared/demo.ts)를 조회 링크 화면과 같은 컴포넌트(viewerPage)로 읽기 전용으로 보여 준다.
 * 합성 데이터 코드는 이 화면을 열 때만 불러온다(첫 화면 용량에 들어가지 않게).
 */
export function Demo(props: { rest: string[] }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    import("../../shared/demo")
      .then((demo) => {
        if (alive) setSnapshot(demo.buildDemoSnapshot());
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const rest = props.rest.length > 0 ? props.rest : ["home"];
  const page = snapshot ? viewerPage(snapshot, "/demo", rest) : null;
  return (
    <>
      <DemoBanner />
      <DemoNav current={page?.tab ?? "home"} />
      <div className="bleed-body">
      {!snapshot ? (
        // 불러오는 동안 자리를 잡아 두어 아래 푸터가 크게 튀지 않게 한다.
        <div className="screen demo-loading">
          {failed ? (
            <p className="note error" role="alert">
              예시를 불러오지 못했어요. 새로 고쳐 주세요.
            </p>
          ) : (
            <p>예시 모임을 준비하는 중…</p>
          )}
        </div>
      ) : (
        (page?.body ?? (
          <div className="screen">
            <p>없는 화면이에요.</p>
            <button type="button" className="secondary" onClick={() => go("/demo")}>
              예시 모임 요약으로
            </button>
          </div>
        ))
      )}
      </div>
    </>
  );
}

/** 모든 예시 화면 위의 안내. 높이가 바뀌지 않게 데이터와 상관없이 바로 그린다. */
function DemoBanner() {
  return (
    <div className="demo-banner" role="note" aria-label="예시 데이터 안내">
      <p>
        <strong>예시 데이터예요.</strong> 가짜 이름으로 만든 기록이라 실제 모임과 관계없어요.
      </p>
      {/* 예시 화면의 주 버튼은 화면 본문 쪽에 둔다(primary 하나 규칙). 안내 줄의 행동은 secondary. */}
      <button type="button" className="secondary" onClick={() => go("/group")}>
        내 모임 만들기
      </button>
    </div>
  );
}

function DemoNav(props: { current: ViewerTab }) {
  const item = (tab: ViewerTab, label: string) => (
    <button
      type="button"
      className="link"
      aria-current={props.current === tab ? "page" : undefined}
      onClick={() => go(`/demo/${tab}`)}
    >
      <LineIcon name={VIEWER_TAB_ICON[tab]} />
      {label}
    </button>
  );
  return (
    <nav className="viewer-nav" aria-label="예시 모임 메뉴">
      <strong>예시 모임</strong>
      <span>
        {item("home", "요약")} {item("search", "검색")} {item("records", "기록")} {item("ranking", "랭킹")}{" "}
        {item("champions", "챔피언")}
      </span>
    </nav>
  );
}
