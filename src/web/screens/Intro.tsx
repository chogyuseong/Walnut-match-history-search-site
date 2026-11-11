import { useId, useState } from "react";
import { LineIcon, type LineIconName } from "../ui";
import { go } from "../useApp";
import { LoginDialog } from "./Login";

/** 이 기기에 남은 이 사이트의 기억이 없는지(테마만 고른 경우는 처음으로 본다). */
export function isFirstVisit(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      // 기억한 모임(naejeon.group), 작성 중인 편성·고른 목록, 조회 링크의 "내 이름"(naejeon.me.토큰) 등.
      if (key && key.startsWith("naejeon.") && key !== "naejeon.theme") return false;
    }
    return true;
  } catch {
    // 저장소를 못 읽으면 매번 처음 온 사람으로 본다(소개만 더 보일 뿐이다).
    return true;
  }
}

/** 소개에 적는 기능. 모두 지금 있는 기능만 적는다. 넷을 넘기지 않는다(첫 화면은 행동이 먼저다). */
const FEATURES: { icon: LineIconName; title: string; text: string }[] = [
  {
    icon: "group",
    title: "팀 짜기",
    text: "10명을 넣으면 티어로 실력을 맞춘 두 팀을 추천하고, 서포터를 돌아가며 맡도록 순서를 챙겨요.",
  },
  {
    icon: "ranking",
    title: "전적 · 랭킹 · 개인 통계",
    text: "경기 결과를 저장하면 승률 랭킹, 라인별 기록, 함께 뛴 사람별 기록이 쌓여요.",
  },
  {
    icon: "link",
    title: "참가 신청 · 조회 링크",
    text: "링크를 보내면 참가자가 로그인 없이 이름을 올리고, 기록과 지금 경기의 자기 자리를 봐요.",
  },
  {
    // 달력(today)은 하단 메뉴 "오늘"의 아이콘이라 겹치지 않게 요약 아이콘을 쓴다.
    icon: "summary",
    title: "시즌 요약",
    text: "시즌이나 한 해를 골라 요약과 시상을 보고 이미지로 나눌 수 있어요.",
  },
];

/**
 * 첫 화면의 소개(로그인하지 않았고 이 기기에 기억한 모임·조회 링크·편성이 없을 때만, src/web/screens/Today.tsx).
 * 이때 오늘 화면의 머리·빈 안내는 숨고 이 소개가 화면 전체다. 구조는 확정 시안(docs/design-mockup/home-gold.html):
 * 소개 제목(화면 제목 h1) + 설명 한 문단 → 채운 주 버튼 하나 · 보조 버튼 · 텍스트 링크 → 안내 한 줄 → 기능 목록.
 * 휴대폰(390×844)에서 스크롤 없이, 하단 메뉴에 가리지 않고 "로그인 없이 팀 짜기"가 보여야 한다(e2e/intro-demo.spec.ts).
 * 1200px 이상은 왼쪽 소개·행동, 오른쪽 기능 목록(styles.css .intro).
 * 설명의 "라이엇 전적에 남지 않아요"는 검색 노출용 문장이라 e2e/search-index·intro-demo가 확인한다.
 */
export function Intro() {
  const [loginOpen, setLoginOpen] = useState(false);
  const featuresTitle = useId();
  return (
    <section className="intro" aria-label="이 사이트 소개">
      <div className="intro-hero">
        <h1>우리 모임 내전, 팀 짜기부터 전적 관리까지 한곳에서</h1>
        <p className="intro-lead">
          리그 오브 레전드의 사용자 설정 게임(내전)은 라이엇 전적에 남지 않아요. 여기서 팀을 짜고 결과를 기록하면 모임의
          전적과 통계가 쌓이고, 이름으로 전적을 검색할 수 있어요.
        </p>
        <div className="intro-actions">
          <button type="button" className="primary" onClick={() => go("/pick")}>
            로그인 없이 팀 짜기
          </button>
          <button type="button" className="secondary" onClick={() => go("/demo")}>
            예시 기록 보기
          </button>
          <button type="button" className="link" onClick={() => setLoginOpen(true)}>
            로그인하고 모임 만들기
          </button>
        </div>
        <p className="intro-note">팀 짜기와 명단 복사는 로그인 없이 돼요. 경기 결과를 저장할 때만 로그인해요.</p>
      </div>
      <section className="intro-features" aria-labelledby={featuresTitle}>
        <h2 id={featuresTitle}>모임에서 이렇게 써요</h2>
        <p className="intro-note">참가자는 로그인 없이 링크로 기록을 봐요.</p>
        <ul>
          {FEATURES.map((f) => (
            <li key={f.title}>
              <LineIcon name={f.icon} />
              <div>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>
      {loginOpen && (
        <LoginDialog
          reason="가입하거나 로그인하면 모임을 만들고 경기 결과를 저장할 수 있어요."
          onClose={() => setLoginOpen(false)}
          onDone={() => setLoginOpen(false)}
        />
      )}
    </section>
  );
}
