import { useEffect } from "react";
import { arrivedByBack } from "./nav";

// 기록 화면(screens/Records.tsx)의 뒤로 가기 스크롤 복원. 보기 조건을 주소에 적는 코드는 screenKit.tsx("주소의 보기 조건")에 있다.
// nav.ts가 아니라 여기에 둔 것은 nav.ts가 첫 화면 묶음에 들어가기 때문이다(check:bundle 예산 17KB). 기록 화면만 쓰므로 그 조각에 들어간다.

/**
 * 주소별 마지막 스크롤 위치. 열쇠는 "?" 뒤 조건까지 포함한 주소 전체라, 같은 기록 화면이라도 조건이 다르면 따로 기억한다.
 * 이 창 메모리에만 둔다(새로 고치면 사라진다). 새로 고친 뒤에는 브라우저 자체 복원에 맡긴다.
 */
const scrollByHash = new Map<string, number>();

/**
 * 뒤로 가기로 이 화면에 돌아오면 떠날 때의 스크롤 위치로 되돌린다. 기록 화면처럼 "더 보기"로 길어지는 목록에 쓴다.
 * 브라우저도 위치를 되돌리지만, 그 순간에는 앞 화면(경기 상세 등)이 그려져 있어 페이지 길이가 짧아 끝까지 못 간다.
 * 주의:
 * - 목록 길이(더 보기 개수)도 주소에 남겨 두어야 같은 위치가 같은 경기를 가리킨다(Records.tsx의 n=).
 * - 뒤로 가기 판단은 nav.ts(arrivedByBack)가 한다. nav.ts의 hashchange 처리가 화면보다 먼저 돌아야 맞는다.
 * - 화면이 처음 그려질 때 한 번만 맞춘다. 스냅숏을 다시 받는 중이라 목록이 늦게 그려지는 경우까지 기다리지는 않는다.
 */
export function useScrollMemory(): void {
  useEffect(() => {
    if (arrivedByBack()) {
      const saved = scrollByHash.get(location.hash);
      // 이번 화면이 다 그려진 다음 프레임에 맞춘다.
      if (saved !== undefined) requestAnimationFrame(() => window.scrollTo(0, saved));
    }
    // 떠나는 순간(다음 화면이 scrollTo(0, 0)으로 올린 것)의 스크롤도 들어오지만, 그때는 주소가 이미 다음 화면이라
    // 그 화면 몫으로 적힌다. 이 화면의 위치는 덮이지 않는다.
    const remember = () => scrollByHash.set(location.hash, window.scrollY);
    window.addEventListener("scroll", remember, { passive: true });
    return () => window.removeEventListener("scroll", remember);
  }, []);
}
