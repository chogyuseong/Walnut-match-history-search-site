// 첫 화면 껍데기 허용 목록. index.html이 부르는 진입 JS와 그 정적 import에 들어가도 되는 우리 원본 파일이다.
// npm run check:bundle이 빌드 결과의 소스맵에서 첫 화면 원본 목록을 뽑아, 여기 없는 파일이 있으면 실패시킨다.
// node_modules(React 등)는 대상이 아니다.
//
// 목록에 넣는 기준:
//  - 어떤 주소로 들어오든 첫 그림 전에 필요한 것만: 진입·주소 고르기, 상단 바·탭·로그인 상태, 모임 기록 받기(useApp),
//    오류 보고, 지연 로딩 장치, 그리고 그것들이 부르는 대화 상자·오류 문구 같은 작은 부품.
//  - 화면 하나(또는 몇 개)에서만 쓰는 것, 통계·칭호·추천·형식 계산(src/shared의 큰 계산), 화면 부품(screenKit.tsx)은 넣지 않는다.
//    그런 것이 필요해 보이면 껍데기 파일이 그 모듈을 통째로 부르는지 보고, 필요한 작은 함수만 따로 떼어 낸다
//    (예: src/shared/storedDraft.ts는 draft.ts에서 저장값 읽기만 떼어 낸 것).
//  - 그래도 넣어야 하면 이유를 적고 넣는다. 첫 화면 크기 예산(check-bundle.mjs)도 같이 본다.
// 실패 출력에 "main.tsx → App.tsx → …" 경로가 나오므로, 어느 import를 끊으면 되는지 거기서 찾는다.

export const SHELL_MODULES = {
  "src/web/main.tsx": "진입",
  "src/web/App.tsx": "주소 고르기·상단 바·탭·문서 제목",
  "src/web/useApp.ts": "운영자 상태(계정·모임 기록 받기·기기 저장값)",
  "src/web/account.tsx": "상단 바 로그인 상태·로그인 안내",
  "src/web/lazyScreens.ts": "화면 지연 로딩",
  "src/web/chunkReload.ts": "배포 뒤 옛 조각 실패 복구",
  "src/web/errorReport.tsx": "화면 오류 보고",
  "src/web/api.ts": "서버 요청",
  "src/web/ui.tsx": "껍데기가 쓰는 대화 상자·오류 문구·복사 버튼·키보드 감지",
  "src/web/sessionExpiredNote.tsx": "오류 문구 안의 다시 로그인(로그인 창은 지연 로딩)",
  "src/web/searchRoute.ts": "주소의 검색 질의 떼기·/ 단축키",
  "src/web/seasonRoute.ts": "시즌 요약 주소 읽기",
  "src/web/theme.ts": "테마",
  "src/web/loginReturn.ts": "로그인 뒤 돌아갈 주소",
  "src/web/nav.ts": "지나온 화면 기록·화면 바뀔 때 맨 위로(첫 주소부터 지켜봐야 함)",
  "src/web/portraits.ts": "푸터 문구가 보는 초상화 켜기 값",
  "src/shared/storedDraft.ts": "기기에 저장된 편성 초안 읽기",
  "src/shared/merge.ts": "합쳐진 참가자를 기기의 초안·고른 목록에서 바꾸기",
  "src/shared/errorScrub.ts": "오류 보고에서 개인정보 지우기",
  "src/shared/version.ts": "오류 보고에 붙이는 앱 버전",
};
