import { useState } from "react";
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

/** 소개에 적는 기능. 모두 지금 있는 기능만 적는다. */
const FEATURES: { title: string; text: string }[] = [
  {
    title: "팀 짜기",
    text: "10명을 넣으면 티어로 실력을 맞춘 두 팀을 추천하고, 서포터를 돌아가며 맡도록 순서를 챙겨요.",
  },
  { title: "전적 · 랭킹 · 개인 통계", text: "경기 결과를 저장하면 승률 랭킹, 라인별 기록, 함께 뛴 사람별 기록이 쌓여요." },
  { title: "시즌 요약", text: "시즌이나 한 해를 골라 요약과 시상을 보고 이미지로 나눌 수 있어요." },
  { title: "참가 신청 링크", text: "링크를 보내면 참가자가 로그인 없이 이름을 올려요." },
  { title: "조회 링크", text: "참가자는 로그인 없이 기록과 지금 경기의 자기 자리를 봐요." },
  { title: "기존 기록 가져오기", text: "구글 시트나 표를 붙여 넣어 지난 경기를 한 번에 옮겨요." },
];

/**
 * 첫 화면의 소개(로그인하지 않았고 이 기기에 기억한 모임·조회 링크·편성이 없을 때만, src/web/screens/Today.tsx).
 * 오늘 화면 맨 위에 붙는다. 로그인 없이 팀 짜기는 그 아래에서 그대로 쓸 수 있다.
 */
export function Intro() {
  const [loginOpen, setLoginOpen] = useState(false);
  return (
    <section className="card intro" aria-label="이 사이트 소개">
      <h2>롤 내전 기록을 남기고 분석하는 곳</h2>
      <p>
        리그 오브 레전드(롤)의 사용자 설정 게임(내전)은 라이엇 전적에 남지 않아요. 여기서 팀을 짜고 결과를 기록하면
        모임의 전적과 통계가 쌓이고, 이름으로 전적을 검색할 수 있어요.
      </p>
      <ul className="intro-features">
        {FEATURES.map((f) => (
          <li key={f.title}>
            <strong>{f.title}</strong>
            <span>{f.text}</span>
          </li>
        ))}
      </ul>
      <div className="button-row">
        <button type="button" className="primary" onClick={() => setLoginOpen(true)}>
          시작하기
        </button>
        <button type="button" className="secondary" onClick={() => go("/demo")}>
          예시 모임 둘러보기
        </button>
      </div>
      <p className="hint">팀 짜기와 명단 복사는 아래에서 로그인 없이 바로 해 볼 수 있어요.</p>
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
