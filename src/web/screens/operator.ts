// 운영자 기본 흐름 화면 묶음(지연 로딩 한 덩어리). App.tsx가 이 파일을 import()로 불러온다(src/web/lazyScreens.ts).
// 첫 화면(오늘)과 공개 화면(참가 신청·조회 링크·예시 모임)은 여기에 넣지 않는다. 무거운 드문 화면(가져오기·합치기·
// 그래프 등)도 따로 불러온다. 이 묶음은 첫 화면을 그린 뒤 미리 받아 둔다(App.tsx usePrefetchOperator).
export { CoInvite } from "./CoOperators";
export { DangerZone } from "./DangerZone";
export { Group } from "./Group";
export { Match } from "./Match";
export { Claim, Member } from "./Member";
export { OperatorRecords } from "./OperatorRecords";
export { Person } from "./Person";
export { Pick } from "./Pick";
export { Prep } from "./Prep";
// 오늘 화면(Today.tsx, 따로 받는 조각)도 이 묶음에서 꺼내 쓴다. 오늘 화면이 직접 import하면 준비 화면과 함께 쓰는 새 조각이 생겨
// 첫 화면의 조각 목록이 길어진다(check:bundle 예산 17KB).
export { HandoffNote } from "./prep/HandoffNote";
export { PriorityScreen } from "./Priority";
export { MatchDetail } from "./MatchDetail";
export { Search } from "./Search";
export { Transfer } from "./Transfer";
