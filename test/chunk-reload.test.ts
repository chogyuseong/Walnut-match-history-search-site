import { afterEach, describe, expect, it, vi } from "vitest";

// 배포 뒤 옛 탭의 지연 로딩 실패 복구(src/web/chunkReload.ts): 잡음 판별, 세션당 한 번 새로 고침, 그 뒤에는 오류 경계로.

/**
 * 화면 코드(src/web/chunkReload.ts, DOM 전역을 쓴다)는 서버 타입 검사(tsconfig.json) 밖이라 실행 시점에 불러온다
 * (csv.test.ts와 같은 방식). 모듈 안의 "새로 고치는 중" 상태가 테스트마다 새로 시작하도록 매번 모듈을 다시 읽는다.
 */
interface ChunkReloadModule {
  CHUNK_RELOAD_KEY: string;
  isModuleLoadError(message: string): boolean;
  reloadOnceForChunk(): boolean;
  importWithReload<M>(load: () => Promise<M>): Promise<M>;
}
const loadModule = async (): Promise<ChunkReloadModule> => {
  vi.resetModules();
  const path = "../src/web/chunkReload";
  return (await import(/* @vite-ignore */ path)) as ChunkReloadModule;
};

/** sessionStorage·location·navigator 흉내. */
function stubBrowser(options: { online?: boolean; stored?: Record<string, string>; storageThrows?: boolean } = {}) {
  const store = new Map(Object.entries(options.stored ?? {}));
  const reload = vi.fn();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => {
      if (options.storageThrows) throw new Error("SecurityError");
      return store.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (options.storageThrows) throw new Error("SecurityError");
      store.set(k, v);
    },
  });
  vi.stubGlobal("location", { reload });
  vi.stubGlobal("navigator", { onLine: options.online ?? true });
  return { store, reload };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("조각 로드 실패 판별(오류 수집에서 거름)", () => {
  it("브라우저별 동적 import 실패 메시지", async () => {
    const { isModuleLoadError } = await loadModule();
    expect(isModuleLoadError("TypeError: Failed to fetch dynamically imported module: https://x.test/assets/Graphs-abc.js")).toBe(true);
    expect(isModuleLoadError("TypeError: error loading dynamically imported module: https://x.test/assets/a.js")).toBe(true);
    expect(isModuleLoadError("TypeError: Importing a module script failed.")).toBe(true);
    expect(
      isModuleLoadError(
        'Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html".',
      ),
    ).toBe(true);
    expect(isModuleLoadError("Error: Unable to preload CSS for /assets/index-abc.css")).toBe(true);
  });

  it("일반 오류는 거르지 않는다", async () => {
    const { isModuleLoadError } = await loadModule();
    expect(isModuleLoadError("TypeError: x is undefined")).toBe(false);
    expect(isModuleLoadError("TypeError: Failed to fetch")).toBe(false);
    expect(isModuleLoadError("Script error.")).toBe(false);
  });
});

describe("세션당 한 번 새로 고침", () => {
  it("처음 실패하면 표시를 남기고 새로 고친다, 끝나지 않은 채 기다린다", async () => {
    const { store, reload } = stubBrowser();
    const { CHUNK_RELOAD_KEY, importWithReload } = await loadModule();
    let settled = false;
    void importWithReload(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module: a.js"))).then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(store.has(CHUNK_RELOAD_KEY)).toBe(true);
    expect(settled).toBe(false);
  });

  it("이미 새로 고친 세션이면 원래 오류를 던진다(오류 경계로)", async () => {
    const { reload } = stubBrowser({ stored: { "naejeon:chunk-reload": "1" } });
    const { importWithReload } = await loadModule();
    const error = new TypeError("Failed to fetch dynamically imported module: a.js");
    await expect(importWithReload(() => Promise.reject(error))).rejects.toBe(error);
    expect(reload).not.toHaveBeenCalled();
  });

  it("오프라인이거나 저장소를 못 쓰면 새로 고치지 않는다", async () => {
    let s = stubBrowser({ online: false });
    let mod = await loadModule();
    expect(mod.reloadOnceForChunk()).toBe(false);
    expect(s.reload).not.toHaveBeenCalled();
    vi.unstubAllGlobals();

    s = stubBrowser({ storageThrows: true });
    mod = await loadModule();
    expect(mod.reloadOnceForChunk()).toBe(false);
    expect(s.reload).not.toHaveBeenCalled();
  });

  it("성공하면 모듈을 그대로 돌려준다", async () => {
    const { reload } = stubBrowser();
    const { importWithReload } = await loadModule();
    await expect(importWithReload(() => Promise.resolve({ ok: 1 }))).resolves.toEqual({ ok: 1 });
    expect(reload).not.toHaveBeenCalled();
  });
});
