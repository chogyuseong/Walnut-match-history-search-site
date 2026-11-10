import { useState } from "react";
import { CHAMPION_PORTRAITS, championPortraitUrl } from "./portraits";

/**
 * 초상화 한 칸. 늘 이름 글자 옆에 놓이므로 alt는 비운다(이름을 두 번 읽지 않게).
 * 못 불러오면(오프라인, 목록에는 있는데 그 버전 자료에 없는 새 챔피언) 그림 자리를 지워 글자만 남긴다.
 */
export function ChampionPortrait(props: { championKey: string; size: number }) {
  // 실패한 키를 기억한다. 같은 칸이 다른 챔피언으로 바뀌면(정렬·필터) 그 챔피언은 다시 불러 본다.
  const [failedKey, setFailedKey] = useState<string | null>(null);
  if (!CHAMPION_PORTRAITS || failedKey === props.championKey) return null;
  return (
    <img
      className="champ-portrait"
      src={championPortraitUrl(props.championKey)}
      width={props.size}
      height={props.size}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailedKey(props.championKey)}
    />
  );
}
