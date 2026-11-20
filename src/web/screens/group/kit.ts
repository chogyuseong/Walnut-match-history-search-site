// 모임 탭(src/web/screens/Group.tsx)의 구역들이 함께 쓰는 저장 도구 묶음. Group이 한 번 만들어 구역마다 넘긴다.
// 저장 중 표시(busy)와 마지막 오류는 탭 전체에 하나뿐이다. 구역마다 따로 두면 한 구역이 저장하는 동안
// 다른 구역 버튼을 눌러 요청이 겹칠 수 있어서다.
import type { ReactNode } from "react";
import type { Settings, Snapshot } from "../../../shared/types";
import type { useAppValue } from "../../useApp";

/** 대화 상자 밖에서 저장하는 구역. 그 구역 안에 오류를 띄운다(GroupKit.run). */
export type GroupErrorPlace = "people" | "rotation" | "team" | "imports" | "seasons" | "rating" | "name" | "backup" | "account";

export type GroupKit = {
  app: ReturnType<typeof useAppValue>;
  snapshot: Snapshot;
  gid: string;
  settings: Settings;
  busy: boolean;
  error: unknown;
  /** 대화 상자를 열 때 이전 오류를 지운다. 안 지우면 상자 안 ErrorNote에 지난 실패가 그대로 뜬다. */
  clearError: () => void;
  /**
   * 저장하고 최신 상태를 다시 읽는다. 성공하면 true.
   * place: 오류를 띄울 구역. 모임 탭은 길어서 맨 위에만 띄우면 아래 구역에서 누른 사람이 오류를 못 본다.
   * 대화 상자 안 작업은 상자 안에 따로 ErrorNote가 있으므로 place 없이 부른다(맨 위에도 함께 뜬다).
   */
  run: (work: () => Promise<unknown>, done?: string, place?: GroupErrorPlace) => Promise<boolean>;
  /**
   * run과 같지만 끝나고 스냅숏을 다시 읽지 않는다. 로그아웃(읽을 모임이 없어진다)과
   * 인수 링크 만들기(모임 내용이 바뀌지 않는다)에 쓴다.
   */
  track: (work: () => Promise<unknown>, place?: GroupErrorPlace) => Promise<boolean>;
  saveSettings: (next: Settings, done: string, place?: GroupErrorPlace) => Promise<boolean>;
  /**
   * 참가자 수정. 요청 ID(재시도에 같은 값)와 화면이 본 버전(baseVersion)을 보낸다. 다른 기기에서 먼저 고쳤으면
   * 서버가 409 VERSION_CONFLICT로 거절하고, run이 오류 안내("그 사이 내용이 바뀌었어요 … 입력은 그대로")를 띄우고
   * 스냅숏을 새로 읽는다. 대화 상자는 성공했을 때만 닫으므로 입력한 이름은 그대로 남는다.
   */
  patchOne: (id: string, body: Record<string, unknown>, done: string, place?: GroupErrorPlace) => Promise<boolean>;
  /** 마지막 오류가 이 구역에서 났으면 ErrorNote, 아니면 null. */
  placeError: (place: GroupErrorPlace) => ReactNode;
};
