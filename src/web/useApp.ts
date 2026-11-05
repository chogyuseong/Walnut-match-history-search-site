import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { parseStoredDraft, type Draft } from "../shared/draft";
import type { Snapshot } from "../shared/types";
import { ApiFailure, call } from "./api";

const DRAFT_KEY = "naejeon.draft.v1";
const GROUP_KEY = "naejeon.group";

export interface Me {
  accountId: string | null;
  groups: { id: string; name: string }[];
  authMode: string;
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
  logout: () => Promise<void>;
  /** 모임이 없으면 만들고 모임 ID를 돌려준다. */
  ensureGroup: () => Promise<string>;
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
      return next;
    } catch (error) {
      if (error instanceof ApiFailure) {
        setLoadError(error);
        // 로그인이 만료되면 계정 상태를 비운다. 입력 중인 초안은 그대로 둔다.
        if (error.status === 401) setMe((m) => (m ? { ...m, accountId: null, groups: [] } : m));
      }
      return null;
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!groupRef.current) return null;
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
    [loadSnapshot],
  );

  const loadMe = useCallback(async (): Promise<Me | null> => {
    try {
      const next = await call<Me>("GET", "/api/me");
      setMe(next);
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
    logout,
    ensureGroup,
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
