/**
 * 챔피언 초상화 설정(2026-11-10). 그리는 부품은 championPortrait.tsx.
 * 라이엇이 공개 제공하는 Data Dragon의 정사각형 그림(120×120)을 주소로 불러온다.
 * 저장소에 그림 파일을 넣지 않고, 다른 사이트의 그림도 가져오지 않는다.
 *
 * 라이엇 "Legal Jibber Jabber" 정책 아래에서 쓰는 것이라 조건이 있다:
 * - 모든 화면 아래에 정책 고지문을 둔다(App.tsx LegalFooter가 이 값을 보고 문구를 바꾼다).
 * - 무료·비영리 개인 운영일 때만 해당한다. 유료화·광고·법인 운영으로 바뀌거나 라이엇이 허가를 거두면
 *   CHAMPION_PORTRAITS를 false로 바꾼다. 그러면 사이트 전체가 그림 없이 글자만 보이고 고지문도 예전 문구로 돌아간다.
 * - 결과 이미지·명단 이미지(shareImage.tsx·DraftImage.tsx)에는 넣지 않는다. 다른 출처 그림을 캔버스에 그리면
 *   캔버스가 오염돼 이미지 내보내기가 막힌다.
 * 브라우저가 ddragon.leagueoflegends.com에 직접 접속하므로 CSP img-src(public/_headers, src/server/http.ts)와
 * 개인정보 처리방침(screens/Privacy.tsx)에 이 주소가 적혀 있다.
 */
export const CHAMPION_PORTRAITS = true;

/**
 * Data Dragon 버전. 새 챔피언이 나오면 api/versions.json의 첫 값으로 올리고 그 버전의 ko_KR 자료로
 * src/shared/champions.ts 목록을 채운다. 옛 버전 주소도 계속 열리므로 올리지 않아도 있는 그림은 깨지지 않는다.
 */
const DDRAGON_VERSION = "16.22.1";

/** 챔피언 키(src/shared/champions.ts)는 Data Dragon id와 같아서 그대로 파일 이름이 된다. */
export function championPortraitUrl(key: string): string {
  return `https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VERSION}/img/champion/${key}.png`;
}
