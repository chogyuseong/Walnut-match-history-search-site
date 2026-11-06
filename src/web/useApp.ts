import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { parseStoredDraft, type Draft, type DraftPerson } from "../shared/draft";
import { remapDraft, remapPeople } from "../shared/merge";
import type { Snapshot } from "../shared/types";
import { ApiFailure, call } from "./api";

const DRAFT_KEY = "naejeon.draft.v1";
const GROUP_KEY = "naejeon.group";
/** 참가자 고르기 화면(Pick.tsx)이 기기에 보관하는 고른 목록. 모임마다 따로 둔다(pickKey). */
const PICK_KEY = "naejeon.pick.v1";

/**
 * 모임 고르기(한 계정 여러 모임): 고른 목록은 모임마다 따로 기억한다. 모임이 없을 때(로그인 전)는 예전 키를 쓴다.
 * 예전 키에 남은 목록은 처음 연 모임으로 한 번 옮긴다(readPick).
 */
export function pickKey(groupId: string | null): string {
  return groupId ? `${PICK_KEY}.g.${groupId}` : PICK_KEY;
}

/** 모임을 바꿀 때 다른 모임의 작성 중인 편성을 잠시 맡겨 두는 곳(모임마다 하나). */
function stashKey(groupId: string): string {
  return `${DRAFT_KEY}.g.${groupId}`;
}

/** 이 모임에 맡겨 둔 편성을 꺼낸다(꺼내면 지운다). 형식이 맞지 않으면 버린다. */
function takeStash(groupId: string): Draft | null {
  try {
    const raw = localStorage.getItem(stashKey(groupId));
    if (raw === null) return null;
    localStorage.removeItem(stashKey(groupId));
    const draft = parseStoredDraft(raw);
    return draft && draft.groupId === groupId ? draft : null;
  } catch {
    return null;
  }
}

function putStash(draft: Draft): void {
  if (!draft.groupId) return;
  try {
    localStorage.setItem(stashKey(draft.groupId), JSON.stringify(draft));
  } catch {
    // 맡기지 못하면 그 편성은 사라진다. 모임 전환은 계속한다.
  }
}

/** 모임을 지운 뒤 그 모임에 묶인 기기 저장값(맡겨 둔 편성, 고른 목록)을 지운다. */
export function forgetGroupStorage(groupId: string): void {
  try {
    localStorage.removeItem(stashKey(groupId));
    localStorage.removeItem(pickKey(groupId));
  } catch {
    // 무시
  }
}

export interface Me {
  accountId: string | null;
  /** role: owner = 대표 운영자, co = 공동 운영자. 예전 서버 응답에는 없을 수 있다(대표로 본다). */
  groups: { id: string; name: string; role?: "owner" | "co" }[];
  /** "fake"(로컬 개발용 로그인) 또는 "oauth". */
  authMode: string;
  /** 쓸 수 있는 로그인 수단. "local"은 자체 계정(아이디 + 비밀번호), 나머지는 키가 설정된 제공자. */
  providers?: ("local" | "kakao" | "google")[];
  /** 지금 세션의 로그인 수단. 아이디·식별자는 서버가 돌려주지 않는다. */
  loginMethod?: "local" | "oauth" | "fake" | null;
}

export interface AppValue {
  ready: boolean;
  me: Me | null;
  groupId: string | null;
  snapshot: Snapshot | null;
  /** 서버에서 마지막으로 받은 시각(기기 시계). "○분 전 내용" 표시에 쓴다. */
  loadedAt: number | null;
  loadError: ApiFailure | null;
  draft: Draft | null;
  /** 기기 저장소에 초안을 보관할 수 있는지. */
  storageOk: boolean;
  /** 화면 아래에 잠깐 보여주는 안내. */
  notice: string | null;
  setNotice: (text: string | null) => void;
  setDraft: (draft: Draft | null) => void;
  /** 서버 상태를 다시 읽는다. 초안은 덮어쓰지 않는다. */
  refresh: () => Promise<Snapshot | null>;
  /** 이 기기에서 변경을 저장한 뒤 부른다. 초안의 기준 버전을 최신으로 맞춘다. */
  refreshAfterOwnChange: () => Promise<Snapshot | null>;
  login: (subject: string) => Promise<void>;
  /** 로그인·가입 뒤 계정 상태를 다시 읽는다(작성 중인 편성은 그대로). */
  reloadMe: () => Promise<void>;
  logout: () => Promise<void>;
  /** 모임이 없으면 만들고 모임 ID를 돌려준다. */
  ensureGroup: () => Promise<string>;
  /**
   * 다른 모임으로 바꾼다(기기에 기억). 작성 중인 편성이 지금 모임 것이면 그 모임에 맡겨 두고,
   * 고른 모임에 맡겨 둔 편성이 있으면 꺼낸다. 고른 목록도 모임마다 따로다.
   */
  switchGroup: (groupId: string) => Promise<void>;
  /** 새 모임을 만들고 그 모임으로 바꾼다(계정당 대표·공동 합계 5개). */
  createGroup: (name?: string) => Promise<string>;
  /** 모임을 바꿀 때마다 오르는 값. 화면을 새로 그리는 데 쓴다(앞 모임의 입력 상태가 남지 않게). */
  switchSeq: number;
  /** 모임을 바꾸는 중(새 모임의 기록을 받는 중). */
  switching: boolean;
}

export const AppContext = createContext<AppValue | null>(null);

export function useAppValue(): AppValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("AppContext가 없습니다.");
  return value;
}

function readStoredDraft(): Draft | null {
  try {
    return parseStoredDraft(localStorage.getItem(DRAFT_KEY));
  } catch {
    return null;
  }
}

/** 운영자 화면의 상태. 조회 링크 화면은 이것을 쓰지 않는다. */
export function useApp(enabled: boolean): AppValue {
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<ApiFailure | null>(null);
  const [draft, setDraftState] = useState<Draft | null>(() => readStoredDraft());
  const [storageOk, setStorageOk] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [switchSeq, setSwitchSeq] = useState(0);
  const [switching, setSwitching] = useState(false);
  const groupRef = useRef<string | null>(null);
  const draftRef = useRef<Draft | null>(draft);

  const setDraft = useCallback((next: Draft | null) => {
    draftRef.current = next;
    setDraftState(next);
    try {
      if (next) localStorage.setItem(DRAFT_KEY, JSON.stringify(next));
      else localStorage.removeItem(DRAFT_KEY);
      setStorageOk(true);
    } catch {
      // 보관에 실패해도 작업은 계속한다. 화면에 "창을 닫으면 사라집니다"를 보여준다.
      setStorageOk(false);
    }
  }, []);

  const loadSnapshot = useCallback(async (gid: string): Promise<Snapshot | null> => {
    try {
      const next = await call<Snapshot>("GET", `/api/groups/${gid}/snapshot`);
      setSnapshot(next);
      setLoadedAt(Date.now());
      setLoadError(null);
      // 중복 참가자 합치기 뒤: 이 기기의 초안·고른 목록에 남은 옛 ID를 남은 사람의 ID로 바꾼다.
      if (next.participants.some((p) => p.mergedInto)) {
        const current = draftRef.current;
        if (current && current.groupId === next.group.id) {
          const remapped = remapDraft(current, next.participants);
          if (remapped.changed) {
            setDraft(remapped.draft);
            setNotice("합쳐진 이름이 있어 작성 중인 편성의 이름을 바꿨어요. 서포터 추첨은 다시 확인해 주세요.");
          } else if (remapped.conflicts.length > 0) {
            setNotice(
              `작성 중인 편성에 같은 사람이 두 이름(${remapped.conflicts.join(", ")})으로 들어 있어요. 한 명을 바꿔 주세요.`,
            );
          }
        }
        try {
          const picked = JSON.parse(localStorage.getItem(pickKey(next.group.id)) ?? "[]") as DraftPerson[];
          if (Array.isArray(picked) && picked.length > 0) {
            const remapped = remapPeople(picked, next.participants);
            if (remapped.changed) localStorage.setItem(pickKey(next.group.id), JSON.stringify(remapped.people));
          }
        } catch {
          // 기기 저장소를 못 쓰면 고르기 화면에서 다시 고르면 된다.
        }
      }
      return next;
    } catch (error) {
      if (error instanceof ApiFailure) {
        setLoadError(error);
        // 로그인이 만료되면 계정 상태를 비운다. 입력 중인 초안은 그대로 둔다.
        if (error.status === 401) setMe((m) => (m ? { ...m, accountId: null, groups: [] } : m));
      }
      return null;
    }
  }, [setDraft]);

  // 계정 정보를 아직 못 받았으면(첫 불러오기가 네트워크 오류로 실패) 계정부터 다시 읽는다.
  const loadMeRef = useRef<(() => Promise<Me | null>) | null>(null);
  const refresh = useCallback(async () => {
    if (!groupRef.current) {
      await loadMeRef.current?.();
      return null;
    }
    return loadSnapshot(groupRef.current);
  }, [loadSnapshot]);

  const refreshAfterOwnChange = useCallback(async () => {
    const next = await refresh();
    const current = draftRef.current;
    if (next && current && current.baseLiveVersion !== next.group.liveVersion) {
      setDraft({ ...current, baseLiveVersion: next.group.liveVersion, groupId: next.group.id });
    }
    return next;
  }, [refresh, setDraft]);

  const selectGroup = useCallback(
    async (gid: string | null) => {
      groupRef.current = gid;
      setGroupId(gid);
      // 작성 중인 편성이 다른 모임 것이면 그 모임에 맡기고, 이 모임에 맡겨 둔 편성이 있으면 꺼낸다.
      // 모임이 정해지기 전에 만든 편성(groupId 없음)은 어느 모임에서나 쓸 수 있어 그대로 둔다.
      if (gid) {
        const current = draftRef.current;
        if (current?.groupId && current.groupId !== gid) {
          putStash(current);
          setDraft(takeStash(gid));
        } else if (!current) {
          const stashed = takeStash(gid);
          if (stashed) setDraft(stashed);
        }
      }
      if (gid) {
        try {
          localStorage.setItem(GROUP_KEY, gid);
        } catch {
          // 무시: 다음 방문 때 첫 모임을 연다.
        }
        await loadSnapshot(gid);
      } else {
        setSnapshot(null);
      }
    },
    [loadSnapshot, setDraft],
  );

  const loadMe = useCallback(async (): Promise<Me | null> => {
    try {
      const next = await call<Me>("GET", "/api/me");
      setMe(next);
      setLoadError(null);
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(GROUP_KEY);
      } catch {
        stored = null;
      }
      const chosen = next.groups.find((g) => g.id === stored) ?? next.groups[0] ?? null;
      await selectGroup(chosen?.id ?? null);
      return next;
    } catch (error) {
      if (error instanceof ApiFailure) setLoadError(error);
      return null;
    }
  }, [selectGroup]);

  loadMeRef.current = loadMe;

  useEffect(() => {
    if (!enabled) return;
    void loadMe().finally(() => setReady(true));
  }, [enabled, loadMe]);

  // 화면으로 돌아오면 최신 상태를 확인한다. 실시간 통신은 쓰지 않는다.
  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [enabled, refresh]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const login = useCallback(
    async (subject: string) => {
      await call("POST", "/api/auth/fake-login", { subject });
      await loadMe();
    },
    [loadMe],
  );

  const reloadMe = useCallback(async () => {
    await loadMe();
  }, [loadMe]);

  const logout = useCallback(async () => {
    await call("POST", "/api/auth/logout");
    groupRef.current = null;
    setGroupId(null);
    setSnapshot(null);
    setMe((m) => (m ? { ...m, accountId: null, groups: [] } : m));
  }, []);

  const ensureGroup = useCallback(async () => {
    if (groupRef.current) return groupRef.current;
    const created = await call<{ id: string; name: string }>("POST", "/api/groups", {});
    setMe((m) => (m ? { ...m, groups: [...m.groups, created] } : m));
    await selectGroup(created.id);
    return created.id;
  }, [selectGroup]);

  const switchGroup = useCallback(
    async (gid: string) => {
      if (gid === groupRef.current) return;
      setSwitching(true);
      setSnapshot(null);
      setSwitchSeq((n) => n + 1);
      try {
        await selectGroup(gid);
      } finally {
        setSwitching(false);
      }
    },
    [selectGroup],
  );

  const createGroup = useCallback(
    async (name?: string) => {
      const created = await call<{ id: string; name: string }>(
        "POST",
        "/api/groups",
        name && name.trim() !== "" ? { name } : {},
      );
      setMe((m) => (m ? { ...m, groups: [...m.groups, { ...created, role: "owner" as const }] } : m));
      await switchGroup(created.id);
      return created.id;
    },
    [switchGroup],
  );

  return {
    ready,
    me,
    groupId,
    snapshot,
    loadedAt,
    loadError,
    draft,
    storageOk,
    notice,
    setNotice,
    setDraft,
    refresh,
    refreshAfterOwnChange,
    login,
    reloadMe,
    logout,
    ensureGroup,
    switchGroup,
    createGroup,
    switchSeq,
    switching,
  };
}

/** 주소의 # 뒤를 "/"로 나눈 값. 화면 전환에 쓴다. */
export function useRoute(): string[] {
  const read = () =>
    location.hash
      .replace(/^#\/?/, "")
      .split("/")
      .filter((part) => part !== "");
  const [route, setRoute] = useState<string[]>(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function go(path: string): void {
  location.hash = path.startsWith("/") ? path : `/${path}`;
}
